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
    store::Store,
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
    /// When the server could last not be reached: for a short while new
    /// attempts fail at once instead of waiting for a timeout each time.
    offline_since: Option<std::time::Instant>,
}

/// How long the app considers itself offline after a failed connection.
const OFFLINE_PAUSE: Duration = Duration::from_secs(30);
/// Longest wait for one server operation on a slow connection.
const OPERATION_TIMEOUT: Duration = Duration::from_secs(120);

/// The error means the server could not be reached (not that it refused the action).
fn is_offline(e: &str) -> bool {
    let e = e.to_lowercase();
    [
        "offline",
        "no answer",
        "did not answer",
        "cannot reach",
        "timed out",
        "connection",
        "broken pipe",
        "network",
        "tls",
        "dns",
        "failed to lookup",
        "os error",
        "unexpected eof",
    ]
    .iter()
    .any(|k| e.contains(k))
}

#[derive(Default)]
struct AppState {
    inner: Mutex<Inner>,
    /// Changes on every login/logout: old watchers stop.
    generation: Arc<AtomicU64>,
    /// Local copy of the mailbox (None until an account is known, or if it
    /// cannot be opened: the app then simply works without it).
    store: std::sync::Mutex<Option<Store>>,
    /// Held while the waiting changes are being sent (one replay at a time).
    replaying: Mutex<()>,
}

impl AppState {
    /// Runs something on the local copy. Its errors are only logged: the
    /// cache must never stop the app from working with the server.
    fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> anyhow::Result<T>) -> Option<T> {
        let mut guard = self.store.lock().ok()?;
        let store = guard.as_mut()?;
        match f(store) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("local copy: {e:#}");
                None
            }
        }
    }

    fn open_store(&self, email: &str) {
        let opened = Store::open(email).map_err(|e| eprintln!("local copy unavailable: {e:#}")).ok();
        if let Ok(mut guard) = self.store.lock() {
            *guard = opened;
        }
    }
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
            if self.offline_since.is_some_and(|t| t.elapsed() < OFFLINE_PAUSE) {
                anyhow::bail!("offline: the server cannot be reached right now");
            }
            let mut s = match imap::connect(acc, pw).await {
                Ok(s) => s,
                Err(e) => {
                    if is_offline(&format!("{e:#}")) {
                        self.offline_since = Some(std::time::Instant::now());
                    }
                    return Err(e);
                }
            };
            self.offline_since = None;
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
            let res: anyhow::Result<_> = tokio::time::timeout(OPERATION_TIMEOUT, async {
                $inner.ensure_session().await?;
                let $caps = $inner.caps;
                let $s = $inner.session.as_mut().unwrap();
                $body.await
            })
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("the server did not answer in time (slow connection)")));
            match res {
                Ok(v) => break Ok(v),
                Err(e) => {
                    let msg = format!("{e:#}");
                    // The connection may be half-broken: start a fresh one next time.
                    $inner.session = None;
                    // Offline or too slow: retrying would only wait again.
                    if attempt >= 2 || msg.starts_with("offline") || msg.contains("did not answer in time") {
                        break Err(msg);
                    }
                    eprintln!("IMAP error, reconnecting: {msg}");
                }
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
                state.open_store(&a.email);
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
    state.open_store(&account.email);
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
        if let Ok(mut guard) = state.store.lock() {
            *guard = None;
        }
        kanbanmail_core::store::delete_for(&acc.email).ok();
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
    let mut prefetched: Vec<String> = vec!["INBOX".to_string()];
    prefetched.extend(columns.iter().map(|c| c.folder.clone()).filter(|f| !f.eq_ignore_ascii_case("INBOX")));
    tauri::async_runtime::spawn(prefetch_bodies(app.clone(), state.generation.clone(), generation, prefetched));
    tauri::async_runtime::spawn(replay_loop(app.clone(), state.generation.clone(), generation));

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

// ---------- actions made without a connection ----------

/// A change to make on the server; kept in the local queue while offline.
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "op", rename_all = "snake_case")]
enum QueuedOp {
    Move { from: String, uid: u32, to: String },
    File { folder: String, uid: u32, kind: String },
    Pin { folder: String, uid: u32, pinned: bool },
    Seen { folder: String, uids: Vec<u32>, seen: bool },
    Send { draft: Draft, reply: Option<ReplyTarget> },
}

impl QueuedOp {
    fn kind(&self) -> &'static str {
        match self {
            QueuedOp::Move { .. } => "move",
            QueuedOp::File { .. } => "file",
            QueuedOp::Pin { .. } => "pin",
            QueuedOp::Seen { .. } => "seen",
            QueuedOp::Send { .. } => "send",
        }
    }

    /// What it is, for messages to the user.
    fn describe(&self) -> String {
        match self {
            QueuedOp::Move { to, .. } => format!("moving an email to {to}"),
            QueuedOp::File { kind, .. } => format!("moving an email to {kind}"),
            QueuedOp::Pin { .. } => "pinning an email".into(),
            QueuedOp::Seen { .. } => "marking emails read/unread".into(),
            QueuedOp::Send { draft, .. } => format!("sending “{}”", draft.subject),
        }
    }
}

/// Does it on the server. Returns the destination folder for File.
async fn run_op(state: &AppState, op: &QueuedOp) -> CmdResult<Option<String>> {
    if let QueuedOp::Send { draft, reply } = op {
        return send_now(state, draft.clone(), reply.clone()).await.map(|_| None);
    }
    let mut inner = state.inner.lock().await;
    match op {
        QueuedOp::Move { from, uid, to } => with_retry!(inner, |s, caps| imap::move_message(s, caps, from, *uid, to)).map(|_| None),
        QueuedOp::File { folder, uid, kind } => with_retry!(inner, |s, caps| async {
            let target = imap::special_folder(s, kind).await?;
            anyhow::ensure!(target != *folder, "the email is already in {target}");
            imap::move_message(s, caps, folder, *uid, &target).await?;
            Ok(target)
        })
        .map(Some),
        QueuedOp::Pin { folder, uid, pinned } => with_retry!(inner, |s, _caps| imap::set_flagged(s, folder, *uid, *pinned)).map(|_| None),
        QueuedOp::Seen { folder, uids, seen } => with_retry!(inner, |s, _caps| imap::set_seen_many(s, folder, uids, *seen)).map(|_| None),
        QueuedOp::Send { .. } => unreachable!(),
    }
}

fn queue_op(app: &AppHandle, state: &AppState, op: &QueuedOp) -> CmdResult<()> {
    let payload = serde_json::to_string(op).map_err(|e| e.to_string())?;
    state
        .with_store(|st| st.enqueue(op.kind(), &payload))
        .ok_or("no connection, and the change could not be kept for later")?;
    emit_queue(app, state);
    Ok(())
}

fn emit_queue(app: &AppHandle, state: &AppState) {
    let count = state.with_store(|st| st.queue()).map(|q| q.len()).unwrap_or(0);
    app.emit("queue-changed", count).ok();
}

/// Done on the server (with File's destination), or kept for later.
enum Outcome {
    Done(Option<String>),
    Queued,
}

/// Does it now, or keeps it for later when the server cannot be reached.
async fn perform_or_queue(app: &AppHandle, state: &AppState, op: QueuedOp) -> CmdResult<Outcome> {
    // Changes keep their order: while older ones wait, new ones wait too.
    let waiting = state.with_store(|st| st.queue()).map(|q| !q.is_empty()).unwrap_or(false);
    if !waiting {
        match run_op(state, &op).await {
            Err(e) if is_offline(&e) => {}
            other => return other.map(Outcome::Done),
        }
    }
    queue_op(app, state, &op)?;
    Ok(Outcome::Queued)
}

/// Sends the waiting changes, oldest first. Stops at the first one that
/// cannot reach the server; one the server refuses is dropped and reported.
async fn replay_queue(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _running = state.replaying.lock().await;
    let queue = state.with_store(|st| st.queue()).unwrap_or_default();
    if queue.is_empty() {
        return;
    }
    let mut changed = false;
    for item in queue {
        let Ok(op) = serde_json::from_str::<QueuedOp>(&item.payload) else {
            state.with_store(|st| st.dequeue(item.id));
            continue;
        };
        match run_op(&state, &op).await {
            Ok(_) => {
                state.with_store(|st| st.dequeue(item.id));
                changed = true;
            }
            Err(e) if is_offline(&e) => {
                state.with_store(|st| st.queue_failed(item.id, &e));
                break;
            }
            Err(e) => {
                state.with_store(|st| st.dequeue(item.id));
                changed = true;
                app.emit("queue-error", format!("Could not finish {}: {e}", op.describe())).ok();
            }
        }
    }
    emit_queue(app, &state);
    if changed {
        app.emit("queue-flushed", ()).ok();
    }
}

/// Tries the waiting changes now (when the app sees the connection is back).
#[tauri::command]
async fn flush_queue(app: AppHandle) -> usize {
    replay_queue(&app).await;
    let state = app.state::<AppState>();
    state.with_store(|st| st.queue()).map(|q| q.len()).unwrap_or(0)
}

/// How many changes wait for the connection.
#[tauri::command]
fn queue_count(state: State<'_, AppState>) -> usize {
    state.with_store(|st| st.queue()).map(|q| q.len()).unwrap_or(0)
}

/// Retries the waiting changes every 30 seconds.
async fn replay_loop(app: AppHandle, current: Arc<AtomicU64>, generation: u64) {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        if current.load(Ordering::SeqCst) != generation {
            return;
        }
        replay_queue(&app).await;
    }
}

/// Emails bigger than this are not downloaded in the background (only when opened).
const PREFETCH_MAX_SIZE: u64 = 3 * 1024 * 1024;

/// Downloads, a few at a time, the content of the newest emails of the Inbox
/// and the board columns, so they open instantly (and offline). Keeps the
/// local copy under the size chosen in the settings.
async fn prefetch_bodies(app: AppHandle, current: Arc<AtomicU64>, generation: u64, folders: Vec<String>) {
    tokio::time::sleep(Duration::from_secs(8)).await;
    loop {
        if current.load(Ordering::SeqCst) != generation {
            return;
        }
        let settings = Settings::load().unwrap_or_default();
        let state = app.state::<AppState>();
        let mut downloaded = 0;
        if settings.prefetch {
            let missing = state.with_store(|st| st.missing_bodies(&folders, 6)).unwrap_or_default();
            let mut by_folder: Vec<(String, Vec<u32>)> = Vec::new();
            for (folder, uid) in missing {
                match by_folder.iter_mut().find(|(f, _)| *f == folder) {
                    Some((_, uids)) => uids.push(uid),
                    None => by_folder.push((folder, vec![uid])),
                }
            }
            for (folder, uids) in by_folder {
                let res: Result<_, String> = {
                    let mut inner = state.inner.lock().await;
                    with_retry!(inner, |s, _caps| imap::fetch_raws(s, &folder, &uids, PREFETCH_MAX_SIZE))
                };
                let Ok(list) = res else { break }; // offline or slow: try again later
                for (uid, raw, size) in list {
                    match raw {
                        Some(raw) => state.with_store(|st| st.put_raw(&folder, uid, &raw)),
                        None => state.with_store(|st| st.mark_too_big(&folder, uid, size)),
                    };
                    downloaded += 1;
                }
            }
            state.with_store(|st| st.evict(u64::from(settings.cache_max_mb) * 1024 * 1024));
        }
        // Quick rounds while there is something to download, then rest.
        tokio::time::sleep(Duration::from_secs(if downloaded > 0 { 2 } else { 120 })).await;
    }
}

/// How much the local copy holds.
#[tauri::command]
fn cache_stats(state: State<'_, AppState>) -> kanbanmail_core::store::StoreStats {
    state.with_store(|st| st.stats()).unwrap_or_default()
}

/// Deletes the local copy (it is rebuilt as folders are opened again).
#[tauri::command]
async fn clear_cache(state: State<'_, AppState>) -> CmdResult<()> {
    let email = state.inner.lock().await.account.as_ref().map(|a| a.email.clone()).ok_or("no account configured")?;
    if let Ok(mut guard) = state.store.lock() {
        *guard = None;
    }
    let result = kanbanmail_core::store::delete_for(&email).map_err(err);
    state.open_store(&email);
    result
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
    // Start from the local copy: only new emails and flags are downloaded.
    let mut cache = match inner.caches.remove(&folder) {
        Some(c) => c,
        None => state
            .with_store(|st| st.folder_cards(&folder))
            .map(|(validity, cards)| FolderCache::from_cards(validity, cards))
            .unwrap_or_default(),
    };
    let res = with_retry!(inner, |s, _caps| imap::load_cards(s, &folder, &mut cache, limit));
    if let Ok(cards) = &res {
        let complete = (cards.len() as u32) < limit;
        state.with_store(|st| st.save_cards(&folder, cache.uid_validity(), cards, complete));
    }
    inner.caches.insert(folder, cache);
    res
}

/// The cards of a folder kept locally (instant, works offline).
#[tauri::command]
fn cached_column(folder: String, limit: u32, state: State<'_, AppState>) -> Vec<Card> {
    state.with_store(|st| st.cards(&folder, limit)).unwrap_or_default()
}

/// The newest emails known on this Mac across folders (All Mail offline).
#[tauri::command]
fn cached_all_mail(state: State<'_, AppState>) -> Vec<imap::ThreadEntry> {
    state.with_store(|st| st.recent(300)).unwrap_or_default()
}

/// The full email: from the local copy if it is there, otherwise from the
/// server (and then kept).
async fn raw_email(state: &AppState, folder: &str, uid: u32) -> CmdResult<Vec<u8>> {
    if let Some(Some(raw)) = state.with_store(|st| st.raw(folder, uid)) {
        return Ok(raw);
    }
    let raw = {
        let mut inner = state.inner.lock().await;
        with_retry!(inner, |s, _caps| imap::load_raw(s, folder, uid))
    };
    match raw {
        Ok(raw) => {
            state.with_store(|st| st.put_raw(folder, uid, &raw));
            Ok(raw)
        }
        Err(e) => {
            // Moved or deleted by another program: forget the stale card.
            if e.contains("no longer exists") {
                state.with_store(|st| st.remove(folder, &[uid]));
            }
            Err(e)
        }
    }
}

#[tauri::command]
/// true when moved now, false when the move waits for the connection.
async fn move_card(from: String, uid: u32, to: String, app: AppHandle, state: State<'_, AppState>) -> CmdResult<bool> {
    let outcome = perform_or_queue(&app, &state, QueuedOp::Move { from: from.clone(), uid, to }).await?;
    state.with_store(|st| st.remove(&from, &[uid]));
    Ok(matches!(outcome, Outcome::Done(_)))
}

#[tauri::command]
async fn set_pin(folder: String, uid: u32, pinned: bool, app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    perform_or_queue(&app, &state, QueuedOp::Pin { folder: folder.clone(), uid, pinned }).await?;
    state.with_store(|st| st.set_flags(&folder, &[uid], None, Some(pinned)));
    Ok(())
}

#[tauri::command]
async fn read_message(folder: String, uid: u32, state: State<'_, AppState>) -> CmdResult<MessageView> {
    let raw = raw_email(&state, &folder, uid).await?;
    Ok(kanbanmail_core::message::parse_view(&raw))
}

#[tauri::command]
async fn set_seen(folder: String, uid: u32, seen: bool, app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    perform_or_queue(&app, &state, QueuedOp::Seen { folder: folder.clone(), uids: vec![uid], seen }).await?;
    state.with_store(|st| st.set_flags(&folder, &[uid], Some(seen), None));
    Ok(())
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
    #[serde(default)]
    undo_send_seconds: u32,
    #[serde(default)]
    preview_board: u32,
    #[serde(default)]
    preview_list: u32,
    #[serde(default)]
    waiting_folder: String,
    #[serde(default)]
    waiting_days: u32,
    #[serde(default = "default_cache_mb")]
    cache_max_mb: u32,
    #[serde(default = "default_yes")]
    prefetch: bool,
}

fn default_cache_mb() -> u32 {
    1024
}

fn default_yes() -> bool {
    true
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
        undo_send_seconds: settings.undo_send_seconds,
        preview_board: settings.preview_board,
        preview_list: settings.preview_list,
        waiting_folder: settings.waiting_folder,
        waiting_days: settings.waiting_days,
        cache_max_mb: settings.cache_max_mb,
        prefetch: settings.prefetch,
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
        undo_send_seconds: settings.undo_send_seconds.min(60),
        preview_board: settings.preview_board.min(2),
        preview_list: settings.preview_list.min(2),
        waiting_folder: settings.waiting_folder.trim().to_string(),
        waiting_days: settings.waiting_days.min(365),
        cache_max_mb: settings.cache_max_mb.clamp(100, 20_000),
        prefetch: settings.prefetch,
    }
        .save()
        .map_err(err)
}

/// The email being replied to, so it can be marked as answered.
#[derive(Serialize, Deserialize, Clone)]
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
async fn send_mail(draft: Draft, reply: Option<ReplyTarget>, app: AppHandle, state: State<'_, AppState>) -> CmdResult<SendResult> {
    match send_now(&state, draft.clone(), reply.clone()).await {
        Err(e) if is_offline(&e) => {
            queue_op(&app, &state, &QueuedOp::Send { draft, reply })?;
            Ok(SendResult {
                saved_to: None,
                warning: Some("No connection: the email will be sent as soon as the server can be reached.".into()),
            })
        }
        other => other,
    }
}

/// Longest wait for the mail server to accept an email (attachments on a slow line).
const SEND_TIMEOUT: Duration = Duration::from_secs(300);

async fn send_now(state: &AppState, draft: Draft, reply: Option<ReplyTarget>) -> CmdResult<SendResult> {
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
    tokio::time::timeout(SEND_TIMEOUT, smtp::send(&account, &password, &message))
        .await
        .map_err(|_| "the mail server did not answer in time (slow connection)".to_string())?
        .map_err(err)?;

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
    .inspect(|entries| {
        state.with_store(|st| st.add_cards(entries));
    })
}

/// The conversation as far as the local copy knows it (instant, offline).
#[tauri::command]
fn local_thread(message_id: Option<String>, references: Vec<String>, state: State<'_, AppState>) -> Vec<imap::ThreadEntry> {
    state.with_store(|st| st.thread(message_id.as_deref(), &references)).unwrap_or_default()
}

/// Searches the local copy: sender, recipients, subject and the text of the
/// emails downloaded so far. Instant and offline; newest first.
#[tauri::command]
fn search_local(text: String, state: State<'_, AppState>) -> Vec<imap::ThreadEntry> {
    state.with_store(|st| st.search(&text, 200)).unwrap_or_default()
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
    let found = match imap::connect(&account, &password).await {
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
    }?;
    state.with_store(|st| st.add_cards(&found));
    Ok(found)
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
    let raw = raw_email(&state, &folder, uid).await?;
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
/// Returns the destination folder, or "" when the move waits for the connection.
async fn file_card(folder: String, uid: u32, kind: String, app: AppHandle, state: State<'_, AppState>) -> CmdResult<String> {
    let outcome = perform_or_queue(&app, &state, QueuedOp::File { folder: folder.clone(), uid, kind }).await?;
    state.with_store(|st| st.remove(&folder, &[uid]));
    Ok(match outcome {
        Outcome::Done(target) => target.unwrap_or_default(),
        Outcome::Queued => String::new(),
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
    if let Ok(entries) = &res {
        state.with_store(|st| st.add_cards(entries));
    }
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
    let raw = raw_email(&state, &folder, uid).await?;
    let (name, mime, bytes) = kanbanmail_core::message::attachment_with_mime(&raw, index).ok_or("attachment not found")?;
    Ok(smtp::OutgoingAttachment { name, mime, data: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

/// A file chosen with the paperclip, read here rather than by the web view
/// (which could hand over files with no content).
#[derive(Serialize)]
struct PickedFile {
    name: String,
    mime: String,
    size: u64,
    /// Content, base64.
    data: String,
}

/// The macOS "Open" panel for attachments; reading a file that is only in
/// iCloud Drive downloads it first.
#[tauri::command]
async fn pick_attachments(window: tauri::Window) -> CmdResult<Vec<PickedFile>> {
    use base64::Engine;
    let Some(files) = rfd::AsyncFileDialog::new().set_title("Attach files").set_parent(&window).pick_files().await else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for f in files {
        let path = f.path().to_path_buf();
        let name = f.file_name();
        let bytes = tokio::fs::read(&path).await.map_err(|e| format!("could not read {name}: {e}"))?;
        if bytes.is_empty() {
            return Err(format!("{name} is empty (if it is in the cloud, download it to this Mac first)"));
        }
        out.push(PickedFile {
            mime: mime_for(&name).to_string(),
            size: bytes.len() as u64,
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
            name,
        });
    }
    Ok(out)
}

/// The media type of a file from its extension (what mail clients use to pick an app).
fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "rtf" => "application/rtf",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "ics" => "text/calendar",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "7z" => "application/x-7z-compressed",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
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
    open_in_browser(&url)
}

/// Opens a web link in the default browser.
fn open_in_browser(url: &str) -> CmdResult<()> {
    let url = url.to_string();
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

/// Links clicked inside an email (an isolated frame) never navigate the app:
/// web links open in the default browser, mailto links in a new email.
fn external_links<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("external-links")
        .on_navigation(|webview, url| match url.scheme() {
            "http" | "https" if !matches!(url.host_str(), Some("localhost" | "tauri.localhost")) => {
                let _ = open_in_browser(url.as_str());
                false
            }
            "mailto" => {
                let _ = webview.emit("open-link", url.as_str());
                false
            }
            _ => true,
        })
        .build()
}

/// Undoes a move: the email (found by Message-ID in `now_in`) goes back to `back_to`.
#[tauri::command]
async fn undo_move(message_id: String, now_in: String, back_to: String, state: State<'_, AppState>) -> CmdResult<()> {
    let mut inner = state.inner.lock().await;
    with_retry!(inner, |s, caps| imap::move_back(s, caps, &message_id, &now_in, &back_to))
}

#[tauri::command]
async fn set_seen_many(folder: String, uids: Vec<u32>, seen: bool, app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    perform_or_queue(&app, &state, QueuedOp::Seen { folder: folder.clone(), uids: uids.clone(), seen }).await?;
    state.with_store(|st| st.set_flags(&folder, &uids, Some(seen), None));
    Ok(())
}

/// Permanently deletes everything in Trash (`kind` = "trash") or Junk ("junk").
/// Returns how many emails were deleted.
#[tauri::command]
async fn empty_folder(kind: String, state: State<'_, AppState>) -> CmdResult<u32> {
    let mut inner = state.inner.lock().await;
    let (folder, count) = with_retry!(inner, |s, _caps| imap::empty_folder(s, &kind))?;
    inner.caches.remove(&folder);
    state.with_store(|st| st.clear_folder(&folder));
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
    let raw = raw_email(&state, &folder, uid).await?;
    let (account, password) = {
        let inner = state.inner.lock().await;
        (inner.account.clone().ok_or("no account configured")?, inner.password.clone().unwrap_or_default())
    };
    let invite = kanbanmail_core::message::parse_view(&raw).invite.ok_or("this email has no invitation")?;
    let message = smtp::build_invite_reply(&account, &invite.ics, &response).map_err(err)?;
    smtp::send(&account, &password, &message).await.map_err(err)
}

/// Opens the invitation with the default calendar app (Calendar on macOS).
#[tauri::command]
async fn add_to_calendar(folder: String, uid: u32, state: State<'_, AppState>) -> CmdResult<()> {
    let raw = raw_email(&state, &folder, uid).await?;
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
        .plugin(external_links())
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
            pick_attachments,
            cached_column,
            cached_all_mail,
            local_thread,
            search_local,
            cache_stats,
            clear_cache,
            flush_queue,
            queue_count,
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
