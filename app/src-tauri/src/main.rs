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
use tauri::{AppHandle, Emitter, Manager, State};
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
    /// How many emails each column loads by default.
    limit: u32,
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
    // Few connections: mail servers limit them per user (SiteGround: 30, shared
    // with every other client and device). The Inbox is watched live with IDLE on
    // one extra connection; the other columns are checked every 60 seconds on
    // the main connection with a cheap STATUS.
    if caps.idle {
        tauri::async_runtime::spawn(watch_folder(
            app.clone(),
            state.generation.clone(),
            generation,
            account.clone(),
            password.clone(),
            "INBOX".to_string(),
        ));
    }
    let polled: Vec<String> = columns
        .iter()
        .map(|c| c.folder.clone())
        .filter(|f| !(caps.idle && f.eq_ignore_ascii_case("INBOX")))
        .collect();
    tauri::async_runtime::spawn(poll_folders(app.clone(), state.generation.clone(), generation, polled));

    Ok(BoardInfo {
        columns,
        config_path: board_path().map_err(err)?.display().to_string(),
        can_idle: caps.idle,
        limit: board.max_cards_per_column,
    })
}

/// Watches a folder with IDLE: the server tells us as soon as something changes.
/// Every change is reported to the UI.
async fn watch_folder(
    app: AppHandle,
    current: Arc<AtomicU64>,
    generation: u64,
    account: Account,
    password: String,
    folder: String,
) {
    let alive = || current.load(Ordering::SeqCst) == generation;
    let mut session: Option<Session> = None;
    while alive() {
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
        if alive() {
            app.emit("folder-changed", &folder).ok();
        }
    }
    if let Some(mut s) = session {
        s.logout().await.ok();
    }
}

/// Checks the given folders every 60 seconds on the main connection and reports
/// the ones that changed (new, removed, read or flagged emails) to the UI.
async fn poll_folders(app: AppHandle, current: Arc<AtomicU64>, generation: u64, folders: Vec<String>) {
    let mut last: HashMap<String, (u32, u32, u32, u64)> = HashMap::new();
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        if current.load(Ordering::SeqCst) != generation {
            return;
        }
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().await;
        for folder in &folders {
            let fp: Result<_, String> = with_retry!(inner, |s, caps| imap::folder_fingerprint(s, folder, caps));
            let Ok(fp) = fp else { continue };
            if last.insert(folder.clone(), fp).is_some_and(|old| old != fp) {
                app.emit("folder-changed", folder).ok();
            }
        }
    }
}

#[tauri::command]
async fn load_column(folder: String, limit: Option<u32>, state: State<'_, AppState>) -> CmdResult<Vec<Card>> {
    let mut guard = state.inner.lock().await;
    let inner = &mut *guard;
    let limit = limit.unwrap_or(inner.limit).clamp(1, 5000);
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
    default_bcc: String,
    use_system_contacts: bool,
    signature_html: String,
    load_remote_images: bool,
    important_allow: Vec<String>,
    important_block: Vec<String>,
    important_same_domain: bool,
    group_threads: bool,
    folders: Vec<kanbanmail_core::settings::FolderPref>,
    rules: Vec<kanbanmail_core::settings::Rule>,
    notify: String,
    theme: String,
    zoom: u32,
    undo_seconds: u32,
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
        default_bcc: settings.default_bcc,
        use_system_contacts: settings.use_system_contacts,
        signature_html: settings.signature_html,
        load_remote_images: settings.load_remote_images,
        important_allow: settings.important_allow,
        important_block: settings.important_block,
        important_same_domain: settings.important_same_domain,
        group_threads: settings.group_threads,
        folders: settings.folders,
        rules: settings.rules,
        notify: settings.notify,
        theme: settings.theme,
        zoom: settings.zoom,
        undo_seconds: settings.undo_seconds,
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
        default_bcc: settings.default_bcc.trim().to_string(),
        use_system_contacts: settings.use_system_contacts,
        signature_html: kanbanmail_core::message::sanitize_signature(&settings.signature_html),
        load_remote_images: settings.load_remote_images,
        important_allow: kanbanmail_core::settings::normalize_rules(&settings.important_allow),
        important_block: kanbanmail_core::settings::normalize_rules(&settings.important_block),
        important_same_domain: settings.important_same_domain,
        group_threads: settings.group_threads,
        folders: settings.folders,
        rules: settings
            .rules
            .into_iter()
            .filter(|r| !r.contains.trim().is_empty() && !r.folder.is_empty())
            .collect(),
        notify: settings.notify,
        theme: settings.theme,
        zoom: settings.zoom.clamp(80, 150),
        undo_seconds: settings.undo_seconds.min(60),
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
    // A fixed Message-ID, so the sent email and its copy in Sent are the same email.
    let mut draft = draft;
    if draft.message_id.as_deref().is_none_or(str::is_empty) {
        draft.message_id = Some(smtp::new_message_id(&account.email));
    }
    let signature = Settings::load().map_err(err)?.html_signature();
    let message = smtp::build(&account, &draft, signature.as_ref()).map_err(err)?;
    smtp::send(&account, &password, &message).await.map_err(err)?;

    // The email has been sent: from here on errors are only warnings.
    let raw = smtp::build_sent_copy(&account, &draft, signature.as_ref())
        .map(|m| m.formatted())
        .unwrap_or_else(|_| message.formatted());
    let mut inner = state.inner.lock().await;
    let saved: Result<String, String> = with_retry!(inner, |s, _caps| async {
        let folder = imap::sent_folder(s).await?;
        imap::append_sent(s, &folder, &raw).await?;
        Ok(folder)
    });
    if let Some(r) = reply {
        let _ = with_retry!(inner, |s, _caps| imap::set_answered(s, &r.folder, r.uid));
    }
    if let Some(id) = draft.message_id.as_deref().filter(|s| !s.is_empty()) {
        if let Err(e) = with_retry!(inner, |s, caps| imap::delete_draft(s, caps, id)) {
            eprintln!("could not remove the draft after sending: {e}");
        }
    }
    Ok(match saved {
        Ok(folder) => SendResult { saved_to: Some(folder), warning: None },
        Err(e) => SendResult { saved_to: None, warning: Some(format!("Email sent, but the copy was not saved: {e}")) },
    })
}

/// A fresh Message-ID for a new email, used for its drafts and the final send.
#[tauri::command]
async fn new_message_id(state: State<'_, AppState>) -> CmdResult<String> {
    let inner = state.inner.lock().await;
    let acc = inner.account.as_ref().ok_or("no account configured")?;
    Ok(smtp::new_message_id(&acc.email))
}

/// Saves the email being written to the Drafts folder, replacing its previous version.
/// Returns the Drafts folder name.
#[tauri::command]
async fn save_draft(draft: Draft, state: State<'_, AppState>) -> CmdResult<String> {
    let id = draft.message_id.clone().filter(|s| !s.is_empty()).ok_or("draft without Message-ID")?;
    let mut inner = state.inner.lock().await;
    let account = inner.account.clone().ok_or("no account configured")?;
    let signature = Settings::load().map_err(err)?.html_signature();
    let raw = smtp::build_draft(&account, &draft, signature.as_ref()).map_err(err)?.formatted();
    with_retry!(inner, |s, caps| imap::save_draft(s, caps, &raw, &id))
}

/// The other emails of the conversation of `folder`/`uid`, looked up in the
/// board columns, Inbox, Sent and Archive. Oldest first; includes the email itself.
#[tauri::command]
async fn load_thread(
    folder: String,
    message_id: Option<String>,
    references: Vec<String>,
    columns: Vec<String>,
    state: State<'_, AppState>,
) -> CmdResult<Vec<imap::ThreadEntry>> {
    let mut inner = state.inner.lock().await;
    with_retry!(inner, |s, _caps| async {
        let mut folders = vec![folder.clone(), "INBOX".to_string()];
        for kind in ["sent", "archive"] {
            if let Some(f) = imap::find_special_folder(s, kind).await? {
                folders.push(f);
            }
        }
        folders.extend(columns.iter().cloned());
        let mut unique = Vec::new();
        for f in folders {
            if !unique.contains(&f) {
                unique.push(f);
            }
        }
        imap::load_thread(s, message_id.as_deref(), &references, &unique).await
    })
}

/// Sets the "Important only" rule for a sender (an address or `@domain`):
/// "allow" = always shown, "block" = never shown, anything else removes it.
/// Returns the updated (allow, block) lists.
#[tauri::command]
fn set_sender_rule(pattern: String, rule: String) -> CmdResult<(Vec<String>, Vec<String>)> {
    let pattern = pattern.trim().to_lowercase();
    if pattern.is_empty() {
        return Err("empty sender".into());
    }
    let mut settings = Settings::load().map_err(err)?;
    settings.important_allow.retain(|p| p.to_lowercase() != pattern);
    settings.important_block.retain(|p| p.to_lowercase() != pattern);
    match rule.as_str() {
        "allow" => settings.important_allow.push(pattern),
        "block" => settings.important_block.push(pattern),
        _ => {}
    }
    settings.important_allow = kanbanmail_core::settings::normalize_rules(&settings.important_allow);
    settings.important_block = kanbanmail_core::settings::normalize_rules(&settings.important_block);
    settings.save().map_err(err)?;
    Ok((settings.important_allow, settings.important_block))
}

/// Everyone you have written to (from the sent-mail folders), lowercased.
/// Uses its own connection so the board stays responsive meanwhile.
#[tauri::command]
async fn known_senders(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let (account, password) = {
        let inner = state.inner.lock().await;
        (inner.account.clone().ok_or("no account configured")?, inner.password.clone().unwrap_or_default())
    };
    let mut session = imap::connect(&account, &password).await.map_err(err)?;
    let known = imap::sent_recipients(&mut session, 3000).await.map_err(err);
    session.logout().await.ok();
    Ok(known?.into_iter().collect())
}

/// Searches sender, recipients and subject (and with `in_body` the text too).
/// `scope` "main" = Inbox, Sent, Archive and the given folders (fast);
/// "rest" = every other folder except Trash, Junk and Drafts. Newest first.
/// Uses its own connection so a slow text search does not block the board; if
/// the server refuses one more connection, falls back to the main one.
#[tauri::command]
async fn search_emails(
    text: String,
    in_body: bool,
    folders: Vec<String>,
    scope: String,
    state: State<'_, AppState>,
) -> CmdResult<Vec<imap::ThreadEntry>> {
    async fn run(s: &mut Session, text: &str, in_body: bool, extra: &[String], scope: &str) -> anyhow::Result<Vec<imap::ThreadEntry>> {
        let mut main = vec!["INBOX".to_string()];
        for kind in ["sent", "archive"] {
            if let Some(f) = imap::find_special_folder(s, kind).await? {
                main.push(f);
            }
        }
        for f in extra {
            if !main.contains(f) {
                main.push(f.clone());
            }
        }
        let folders: Vec<String> = if scope == "rest" {
            imap::searchable_folders(s).await?.into_iter().filter(|f| !main.contains(f)).collect()
        } else {
            main
        };
        imap::search(s, text, in_body, &folders, 100).await
    }

    let (account, password) = {
        let inner = state.inner.lock().await;
        (inner.account.clone().ok_or("no account configured")?, inner.password.clone().unwrap_or_default())
    };
    match imap::connect(&account, &password).await {
        Ok(mut session) => {
            let result = run(&mut session, &text, in_body, &folders, &scope).await;
            session.logout().await.ok();
            result.map_err(err)
        }
        Err(e) => {
            eprintln!("search connection refused, using the main one: {e:#}");
            let mut inner = state.inner.lock().await;
            with_retry!(inner, |s, _caps| run(s, &text, in_body, &folders, &scope))
        }
    }
}

/// Shows the number of unread Inbox emails on the app icon (Dock on macOS,
/// taskbar on Windows/Linux where supported). 0 removes the badge.
#[tauri::command]
fn set_unread_badge(count: u32, window: tauri::WebviewWindow) -> CmdResult<()> {
    window
        .set_badge_count((count > 0).then_some(count as i64))
        .map_err(|e| e.to_string())
}

/// Saves an attachment to the Downloads folder and shows it in the file manager.
/// Returns the saved file path.
#[tauri::command]
async fn save_attachment(folder: String, uid: u32, index: usize, state: State<'_, AppState>) -> CmdResult<String> {
    let raw = {
        let mut inner = state.inner.lock().await;
        with_retry!(inner, |s, _caps| imap::load_raw(s, &folder, uid))?
    };
    let (name, bytes) = kanbanmail_core::message::attachment(&raw, index).ok_or("attachment not found")?;
    let dir = directories::UserDirs::new()
        .and_then(|d| d.download_dir().map(|p| p.to_path_buf()))
        .ok_or("cannot find the Downloads folder")?;
    let path = unique_path(&dir, &safe_file_name(&name));
    std::fs::write(&path, bytes).map_err(|e| format!("cannot save {}: {e}", path.display()))?;
    reveal_in_file_manager(&path);
    Ok(path.display().to_string())
}

/// Keeps only characters that are safe in a file name on every system.
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() { "attachment".into() } else { cleaned }
}

/// `name.pdf`, or `name (1).pdf`, `name (2).pdf`... if it already exists.
fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

fn reveal_in_file_manager(path: &std::path::Path) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg("-R").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(dir) = path.parent() {
        let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
    }
}

/// Removes every saved version of a draft.
#[tauri::command]
async fn discard_draft(message_id: String, state: State<'_, AppState>) -> CmdResult<()> {
    let mut inner = state.inner.lock().await;
    with_retry!(inner, |s, caps| imap::delete_draft(s, caps, &message_id))
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

/// "All Mail": the most recent emails of every folder except Trash, Junk and
/// Drafts, newest first.
#[tauri::command]
async fn load_all_mail(state: State<'_, AppState>) -> CmdResult<Vec<imap::ThreadEntry>> {
    let mut guard = state.inner.lock().await;
    let inner = &mut *guard;
    let mut caches = std::mem::take(&mut inner.caches);
    let res = with_retry!(inner, |s, _caps| async {
        let folders = imap::searchable_folders(s).await?;
        imap::load_all_mail(s, &folders, &mut caches, 200).await
    });
    inner.caches = caches;
    res
}

/// Markdown (with inline HTML) to the HTML that will be sent, for the preview.
#[tauri::command]
fn render_markdown(text: String) -> String {
    smtp::markdown_to_html(&text)
}

/// An attachment of an existing email, ready to be attached again (forward,
/// reopened draft).
#[tauri::command]
async fn attachment_data(folder: String, uid: u32, index: usize, state: State<'_, AppState>) -> CmdResult<smtp::OutgoingAttachment> {
    use base64::Engine;
    let raw = {
        let mut inner = state.inner.lock().await;
        with_retry!(inner, |s, _caps| imap::load_raw(s, &folder, uid))?
    };
    let (name, mime, bytes) = kanbanmail_core::message::attachment_with_mime(&raw, index).ok_or("attachment not found")?;
    Ok(smtp::OutgoingAttachment { name, mime, data: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

/// What an exported settings file contains (never the password).
#[derive(Serialize, Deserialize)]
struct ExportFile {
    app: String,
    version: u32,
    account: ExportAccount,
    board_toml: String,
    settings: Settings,
}

#[derive(Serialize, Deserialize)]
struct ExportAccount {
    server: String,
    email: String,
    display_name: Option<String>,
    smtp_server: Option<String>,
    smtp_port: u16,
}

/// Saves account details (no password), board columns and settings to a JSON
/// file in Downloads and shows it in the file manager. Returns its path.
#[tauri::command]
async fn export_settings(state: State<'_, AppState>) -> CmdResult<String> {
    let acc = state.inner.lock().await.account.clone().ok_or("no account configured")?;
    let file = ExportFile {
        app: "KanbanMail".into(),
        version: 1,
        account: ExportAccount {
            server: acc.server.clone(),
            email: acc.email.clone(),
            display_name: acc.display_name.clone(),
            smtp_server: acc.smtp_server.clone(),
            smtp_port: acc.smtp_port,
        },
        board_toml: std::fs::read_to_string(board_path().map_err(err)?).unwrap_or_default(),
        settings: Settings::load().map_err(err)?,
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    let dir = directories::UserDirs::new()
        .and_then(|d| d.download_dir().map(|p| p.to_path_buf()))
        .ok_or("cannot find the Downloads folder")?;
    let path = unique_path(&dir, "KanbanMail-settings.json");
    std::fs::write(&path, json).map_err(|e| format!("cannot save {}: {e}", path.display()))?;
    reveal_in_file_manager(&path);
    Ok(path.display().to_string())
}

/// Applies an exported settings file: board columns and settings always; the
/// sender name and SMTP details only if the file is for the same email address.
/// Returns a short summary.
#[tauri::command]
async fn import_settings(json: String, state: State<'_, AppState>) -> CmdResult<String> {
    let file: ExportFile = serde_json::from_str(&json).map_err(|_| "this is not a KanbanMail settings file")?;
    if file.app != "KanbanMail" {
        return Err("this is not a KanbanMail settings file".into());
    }
    if !file.board_toml.trim().is_empty() {
        toml::from_str::<Board>(&file.board_toml).map_err(|e| format!("the board columns in the file are not valid: {e}"))?;
        std::fs::write(board_path().map_err(err)?, &file.board_toml).map_err(|e| e.to_string())?;
    }
    file.settings.save().map_err(err)?;
    let mut inner = state.inner.lock().await;
    let same = inner.account.as_ref().is_some_and(|a| a.email.eq_ignore_ascii_case(&file.account.email));
    if same {
        let acc = inner.account.as_mut().unwrap();
        acc.display_name = file.account.display_name;
        acc.smtp_server = file.account.smtp_server;
        acc.smtp_port = file.account.smtp_port;
        acc.save().map_err(err)?;
        Ok("Settings, columns and account details imported.".into())
    } else {
        Ok(format!(
            "Settings and columns imported. Account details were kept: the file is for {}.",
            file.account.email
        ))
    }
}

/// Opens a link of an email in the default browser (web links only).
#[tauri::command]
fn open_url(url: String) -> CmdResult<()> {
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("only web links can be opened".into());
    }
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url.trim()).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url.trim()]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url.trim()).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// Undoes a move: the email (found by Message-ID in `now_in`) goes back to `back_to`.
#[tauri::command]
async fn undo_move(message_id: String, now_in: String, back_to: String, state: State<'_, AppState>) -> CmdResult<()> {
    let mut inner = state.inner.lock().await;
    with_retry!(inner, |s, caps| imap::move_back(s, caps, &message_id, &now_in, &back_to))
}

#[tauri::command]
async fn set_seen_many(folder: String, uids: Vec<u32>, seen: bool, state: State<'_, AppState>) -> CmdResult<()> {
    let mut inner = state.inner.lock().await;
    with_retry!(inner, |s, _caps| imap::set_seen_many(s, &folder, &uids, seen))
}

/// Permanently deletes everything in Trash (`kind` = "trash") or Junk ("junk").
/// Returns how many emails were deleted.
#[tauri::command]
async fn empty_folder(kind: String, state: State<'_, AppState>) -> CmdResult<u32> {
    let mut inner = state.inner.lock().await;
    let (folder, count) = with_retry!(inner, |s, _caps| imap::empty_folder(s, &kind))?;
    inner.caches.remove(&folder);
    Ok(count)
}

#[derive(Deserialize)]
struct ColumnSpec {
    name: String,
    folder: String,
}

/// Saves the board columns edited in the settings (the board is then reopened).
#[tauri::command]
fn save_board(columns: Vec<ColumnSpec>) -> CmdResult<()> {
    let mut board = Board::load_or_create().map_err(err)?;
    board.columns = columns
        .into_iter()
        .filter(|c| !c.folder.trim().is_empty())
        .map(|c| kanbanmail_core::board::Column {
            name: if c.name.trim().is_empty() { c.folder.clone() } else { c.name.trim().to_string() },
            folder: c.folder.trim().to_string(),
        })
        .collect();
    board.save().map_err(err)
}

/// A desktop notification (macOS asks for permission the first time).
#[tauri::command]
fn notify(title: String, body: String, app: AppHandle) -> CmdResult<()> {
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

/// Answers a calendar invitation ("ACCEPTED", "DECLINED", "TENTATIVE") to its organizer.
#[tauri::command]
async fn respond_invite(folder: String, uid: u32, response: String, state: State<'_, AppState>) -> CmdResult<()> {
    let (raw, account, password) = {
        let mut inner = state.inner.lock().await;
        let raw = with_retry!(inner, |s, _caps| imap::load_raw(s, &folder, uid))?;
        (raw, inner.account.clone().ok_or("no account configured")?, inner.password.clone().unwrap_or_default())
    };
    let invite = kanbanmail_core::message::parse_view(&raw).invite.ok_or("this email has no invitation")?;
    let message = smtp::build_invite_reply(&account, &invite.ics, &response).map_err(err)?;
    smtp::send(&account, &password, &message).await.map_err(err)
}

/// Opens the invitation with the default calendar app (Calendar on macOS).
#[tauri::command]
async fn add_to_calendar(folder: String, uid: u32, state: State<'_, AppState>) -> CmdResult<()> {
    let raw = {
        let mut inner = state.inner.lock().await;
        with_retry!(inner, |s, _caps| imap::load_raw(s, &folder, uid))?
    };
    let invite = kanbanmail_core::message::parse_view(&raw).invite.ok_or("this email has no invitation")?;
    let path = std::env::temp_dir().join(format!("kanbanmail-{}.ics", uid));
    std::fs::write(&path, invite.ics).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("cmd").args(["/C", "start", ""]).arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&path).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_contacts_privacy() {
    contacts::open_privacy_settings();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
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
            new_message_id,
            save_draft,
            discard_draft,
            save_attachment,
            load_thread,
            set_unread_badge,
            set_sender_rule,
            known_senders,
            search_emails,
            open_contacts_privacy,
            load_all_mail,
            open_url,
            undo_move,
            set_seen_many,
            empty_folder,
            save_board,
            notify,
            respond_invite,
            add_to_calendar,
            render_markdown,
            attachment_data,
            export_settings,
            import_settings,
            system_contacts
        ])
        .run(tauri::generate_context!())
        .expect("error while starting KanbanMail");
}
