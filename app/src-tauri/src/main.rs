// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod contacts;

use kanbanmail_core::{
    account::Account,
    board::{board_path, Board},
    imap::{self, FolderCache, ServerCaps, Session},
    message::{Card, MessageView},
    secret,
    settings::Settings,
    smtp::{self, Draft},
};
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// Shared app state. One IMAP connection for commands, plus one
/// connection per column dedicated to waiting for changes (IDLE).
#[derive(Default)]
struct Inner {
    account: Option<Account>,
    password: Option<String>,
    session: Option<Session>,
    caps: ServerCaps,
    caches: HashMap<String, FolderCache>,
    limit: u32,
}

#[derive(Default)]
struct AppState {
    inner: Mutex<Inner>,
    /// Changes on every login/logout: old watchers stop.
    generation: Arc<AtomicU64>,
}

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

impl Inner {
    async fn ensure_session(&mut self) -> anyhow::Result<&mut Session> {
        if self.session.is_none() {
            let (Some(acc), Some(pw)) = (&self.account, &self.password) else {
                anyhow::bail!("no account configured");
            };
            let mut s = imap::connect(acc, pw).await?;
            self.caps = imap::server_caps(&mut s).await?;
            self.session = Some(s);
        }
        Ok(self.session.as_mut().unwrap())
    }
}

/// Runs an IMAP operation; if it fails (e.g. dropped connection)
/// reconnects and retries once.
macro_rules! with_retry {
    ($inner:ident, |$s:ident, $caps:ident| $body:expr) => {{
        let mut attempt = 0;
        loop {
            attempt += 1;
            let res: anyhow::Result<_> = async {
                $inner.ensure_session().await?;
                let $caps = $inner.caps;
                let $s = $inner.session.as_mut().unwrap();
                $body.await
            }
            .await;
            match res {
                Ok(v) => break Ok(v),
                Err(e) if attempt < 2 => {
                    eprintln!("IMAP error, reconnecting: {e:#}");
                    $inner.session = None;
                }
                Err(e) => break Err(err(e)),
            }
        }
    }};
}

#[derive(Serialize)]
struct Status {
    configured: bool,
    email: Option<String>,
    server: Option<String>,
}

/// Is the account already saved (file + keychain)?
#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> CmdResult<Status> {
    let acc = Account::load().map_err(err)?;
    let mut inner = state.inner.lock().await;
    let configured = match &acc {
        Some(a) => match secret::get_password(&a.email).map_err(err)? {
            Some(pw) => {
                inner.account = Some(a.clone());
                inner.password = Some(pw);
                true
            }
            None => false,
        },
        None => false,
    };
    Ok(Status {
        configured,
        email: acc.as_ref().map(|a| a.email.clone()),
        server: acc.as_ref().map(|a| a.server.clone()),
    })
}

/// Tries to log in; on success saves server and email to file and the password to the keychain.
#[tauri::command]
async fn login(server: String, email: String, password: String, state: State<'_, AppState>) -> CmdResult<()> {
    let account = Account::new(server.trim().to_string(), email.trim().to_string());
    let mut session = imap::connect(&account, &password).await.map_err(err)?;
    let caps = imap::server_caps(&mut session).await.map_err(err)?;
    account.save().map_err(err)?;
    secret::set_password(&account.email, &password).map_err(err)?;
    let mut inner = state.inner.lock().await;
    *inner = Inner { account: Some(account), password: Some(password), session: Some(session), caps, ..Default::default() };
    Ok(())
}

/// Forgets account and password (to switch account or fix the details).
#[tauri::command]
async fn forget_account(state: State<'_, AppState>) -> CmdResult<()> {
    state.generation.fetch_add(1, Ordering::SeqCst);
    let mut inner = state.inner.lock().await;
    if let Some(acc) = &inner.account {
        secret::delete_password(&acc.email).map_err(err)?;
    }
    if let Some(mut s) = inner.session.take() {
        s.logout().await.ok();
    }
    *inner = Inner::default();
    let path = kanbanmail_core::account::config_dir().map_err(err)?.join("account.toml");
    std::fs::remove_file(path).ok();
    Ok(())
}

#[derive(Serialize, Clone)]
struct ColumnInfo {
    name: String,
    folder: String,
}

#[derive(Serialize)]
struct BoardInfo {
    columns: Vec<ColumnInfo>,
    config_path: String,
    can_idle: bool,
}

/// Reads board.toml, creates missing folders and starts live updates.
#[tauri::command]
async fn open_board(app: AppHandle, state: State<'_, AppState>) -> CmdResult<BoardInfo> {
    let board = Board::load_or_create().map_err(err)?;
    let wanted: Vec<String> = board.columns.iter().map(|c| c.folder.clone()).collect();
    let mut inner = state.inner.lock().await;
    inner.limit = board.max_cards_per_column;
    let folders = with_retry!(inner, |s, _caps| imap::resolve_folders(s, &wanted))?;
    let columns: Vec<ColumnInfo> = board
        .columns
        .iter()
        .zip(folders)
        .map(|(c, folder)| ColumnInfo { name: c.name.clone(), folder })
        .collect();

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (account, password, caps) = (inner.account.clone().unwrap(), inner.password.clone().unwrap(), inner.caps);
    for col in &columns {
        tauri::async_runtime::spawn(watch_folder(
            app.clone(),
            state.generation.clone(),
            generation,
            account.clone(),
            password.clone(),
            caps,
            col.folder.clone(),
        ));
    }

    Ok(BoardInfo {
        columns,
        config_path: board_path().map_err(err)?.display().to_string(),
        can_idle: caps.idle,
    })
}

/// Watches a folder: with IDLE the server tells us as soon as something changes,
/// otherwise we check every 60 seconds. Every change is reported to the UI.
async fn watch_folder(
    app: AppHandle,
    current: Arc<AtomicU64>,
    generation: u64,
    account: Account,
    password: String,
    caps: ServerCaps,
    folder: String,
) {
    let alive = || current.load(Ordering::SeqCst) == generation;
    let mut session: Option<Session> = None;
    while alive() {
        if !caps.idle {
            tokio::time::sleep(Duration::from_secs(60)).await;
        } else {
            let s = match session.take() {
                Some(s) => s,
                None => match imap::connect(&account, &password).await {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[{folder}] IDLE connection failed: {e:#}");
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        continue;
                    }
                },
            };
            let wait = imap::wait_for_change(s, &folder, Duration::from_secs(9 * 60));
            match tokio::time::timeout(Duration::from_secs(10 * 60), wait).await {
                Ok(Ok(s)) => session = Some(s),
                Ok(Err(e)) => {
                    eprintln!("[{folder}] IDLE interrupted: {e:#}");
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
                Err(_) => {} // no answer: reopen the connection on the next round
            }
        }
        if alive() {
            app.emit("folder-changed", &folder).ok();
        }
    }
    if let Some(mut s) = session {
        s.logout().await.ok();
    }
}

#[tauri::command]
async fn load_column(folder: String, state: State<'_, AppState>) -> CmdResult<Vec<Card>> {
    let mut guard = state.inner.lock().await;
    let inner = &mut *guard;
    let limit = inner.limit.max(1);
    let mut cache = inner.caches.remove(&folder).unwrap_or_default();
    let res = with_retry!(inner, |s, _caps| imap::load_cards(s, &folder, &mut cache, limit));
    inner.caches.insert(folder, cache);
    res
}

#[tauri::command]
async fn move_card(from: String, uid: u32, to: String, state: State<'_, AppState>) -> CmdResult<()> {
    let mut inner = state.inner.lock().await;
    with_retry!(inner, |s, caps| imap::move_message(s, caps, &from, uid, &to))
}

#[tauri::command]
async fn set_pin(folder: String, uid: u32, pinned: bool, state: State<'_, AppState>) -> CmdResult<()> {
    let mut inner = state.inner.lock().await;
    with_retry!(inner, |s, _caps| imap::set_flagged(s, &folder, uid, pinned))
}

#[tauri::command]
async fn read_message(folder: String, uid: u32, state: State<'_, AppState>) -> CmdResult<MessageView> {
    let mut inner = state.inner.lock().await;
    with_retry!(inner, |s, _caps| imap::load_message(s, &folder, uid))
}

#[tauri::command]
async fn set_seen(folder: String, uid: u32, seen: bool, state: State<'_, AppState>) -> CmdResult<()> {
    let mut inner = state.inner.lock().await;
    with_retry!(inner, |s, _caps| imap::set_seen(s, &folder, uid, seen))
}

#[derive(Serialize, Deserialize)]
struct SettingsView {
    email: String,
    display_name: String,
    smtp_server: String,
    smtp_port: u16,
    mark_read_after_seconds: i32,
    signature: String,
    use_system_contacts: bool,
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> CmdResult<SettingsView> {
    let inner = state.inner.lock().await;
    let acc = inner.account.as_ref().ok_or("no account configured")?;
    let settings = Settings::load().map_err(err)?;
    Ok(SettingsView {
        email: acc.email.clone(),
        display_name: acc.display_name.clone().unwrap_or_default(),
        smtp_server: acc.smtp_host().to_string(),
        smtp_port: acc.smtp_port,
        mark_read_after_seconds: settings.mark_read_after_seconds,
        signature: settings.signature,
        use_system_contacts: settings.use_system_contacts,
    })
}

#[tauri::command]
async fn save_settings(settings: SettingsView, state: State<'_, AppState>) -> CmdResult<()> {
    let mut inner = state.inner.lock().await;
    let acc = inner.account.as_mut().ok_or("no account configured")?;
    let name = settings.display_name.trim();
    acc.display_name = (!name.is_empty()).then(|| name.to_string());
    let smtp = settings.smtp_server.trim();
    acc.smtp_server = (!smtp.is_empty() && smtp != acc.server).then(|| smtp.to_string());
    acc.smtp_port = settings.smtp_port;
    acc.save().map_err(err)?;
    Settings {
        mark_read_after_seconds: settings.mark_read_after_seconds.max(-1),
        signature: settings.signature.trim_end().to_string(),
        use_system_contacts: settings.use_system_contacts,
    }
        .save()
        .map_err(err)
}

/// The email being replied to, so it can be marked as answered.
#[derive(Deserialize)]
struct ReplyTarget {
    folder: String,
    uid: u32,
}

#[derive(Serialize)]
struct SendResult {
    /// Folder the copy was saved to.
    saved_to: Option<String>,
    /// Non-fatal problem (the email was sent but not saved).
    warning: Option<String>,
}

#[tauri::command]
async fn send_mail(draft: Draft, reply: Option<ReplyTarget>, state: State<'_, AppState>) -> CmdResult<SendResult> {
    let (account, password) = {
        let inner = state.inner.lock().await;
        (
            inner.account.clone().ok_or("no account configured")?,
            inner.password.clone().unwrap_or_default(),
        )
    };
    let message = smtp::build(&account, &draft).map_err(err)?;
    smtp::send(&account, &password, &message).await.map_err(err)?;

    // The email has been sent: from here on errors are only warnings.
    let raw = message.formatted();
    let mut inner = state.inner.lock().await;
    let saved: Result<String, String> = with_retry!(inner, |s, _caps| async {
        let folder = imap::sent_folder(s).await?;
        imap::append_sent(s, &folder, &raw).await?;
        Ok(folder)
    });
    if let Some(r) = reply {
        let _ = with_retry!(inner, |s, _caps| imap::set_answered(s, &r.folder, r.uid));
    }
    Ok(match saved {
        Ok(folder) => SendResult { saved_to: Some(folder), warning: None },
        Err(e) => SendResult { saved_to: None, warning: Some(format!("Email sent, but the copy was not saved: {e}")) },
    })
}

#[tauri::command]
async fn list_folders(state: State<'_, AppState>) -> CmdResult<Vec<imap::FolderInfo>> {
    let mut inner = state.inner.lock().await;
    with_retry!(inner, |s, _caps| imap::folder_tree(s))
}

/// Moves the email to the trash (`kind` = "trash") or the archive ("archive").
/// Returns the destination folder name.
#[tauri::command]
async fn file_card(folder: String, uid: u32, kind: String, state: State<'_, AppState>) -> CmdResult<String> {
    let mut inner = state.inner.lock().await;
    with_retry!(inner, |s, caps| async {
        let target = imap::special_folder(s, &kind).await?;
        anyhow::ensure!(target != folder, "the email is already in {target}");
        imap::move_message(s, caps, &folder, uid, &target).await?;
        Ok(target)
    })
}

/// Contacts from the system address book (only when enabled in settings).
#[tauri::command]
async fn system_contacts() -> CmdResult<Vec<contacts::Contact>> {
    if !Settings::load().map_err(err)?.use_system_contacts {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(contacts::system_contacts)
        .await
        .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_status,
            login,
            forget_account,
            open_board,
            load_column,
            move_card,
            set_pin,
            read_message,
            set_seen,
            get_settings,
            save_settings,
            send_mail,
            list_folders,
            file_card,
            system_contacts
        ])
        .run(tauri::generate_context!())
        .expect("error while starting KanbanMail");
}
