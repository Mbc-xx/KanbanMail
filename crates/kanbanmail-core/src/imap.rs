//! IMAP over TLS (port 993).

use crate::account::Account;
use anyhow::{anyhow, Context, Result};
use futures::TryStreamExt;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::{ClientConfig, RootCertStore, pki_types::ServerName};
use tokio_rustls::TlsConnector;

pub type Session = async_imap::Session<TlsStream<TcpStream>>;

/// Opens the TLS connection and logs in. Returns an authenticated session.
pub async fn connect(account: &Account, password: &str) -> Result<Session> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));

    let tcp = TcpStream::connect((account.server.as_str(), account.port))
        .await
        .with_context(|| format!("cannot reach {}:{}", account.server, account.port))?;
    let name = ServerName::try_from(account.server.clone())
        .map_err(|_| anyhow!("invalid server name: {}", account.server))?;
    let tls = connector
        .connect(name, tcp)
        .await
        .context("TLS connection failed (wrong certificate or server?)")?;

    let mut client = async_imap::Client::new(tls);
    // The server sends a "* OK ..." greeting first, which must be read before logging in.
    client
        .read_response()
        .await
        .context("no greeting from the IMAP server")?;

    client
        .login(&account.email, password)
        .await
        .map_err(|(e, _)| anyhow!("login rejected: {e}"))
}

/// Lists the names of all IMAP folders.
pub async fn list_folders(session: &mut Session) -> Result<Vec<String>> {
    let names: Vec<_> = session
        .list(Some(""), Some("*"))
        .await
        .context("LIST command failed")?
        .try_collect()
        .await?;
    let mut out: Vec<String> = names.iter().map(|n| n.name().to_string()).collect();
    out.sort();
    Ok(out)
}

/// Capabilities announced by the server (e.g. MOVE, IDLE).
pub async fn capabilities(session: &mut Session) -> Result<Vec<String>> {
    let caps = session.capabilities().await.context("CAPABILITY command failed")?;
    let mut out: Vec<String> = caps.iter().map(|c| format!("{c:?}")).collect();
    out.sort();
    Ok(out)
}

/// What the server supports: decides how to move and how to stay up to date.
#[derive(Debug, Clone, Copy, Default)]
pub struct ServerCaps {
    pub r#move: bool,
    pub idle: bool,
    pub uidplus: bool,
    pub condstore: bool,
}

pub async fn server_caps(session: &mut Session) -> Result<ServerCaps> {
    let caps = session.capabilities().await.context("CAPABILITY command failed")?;
    Ok(ServerCaps {
        r#move: caps.has_str("MOVE"),
        idle: caps.has_str("IDLE"),
        uidplus: caps.has_str("UIDPLUS"),
        condstore: caps.has_str("CONDSTORE"),
    })
}

/// Finds the real server folder for each requested name, creating missing
/// ones. Example: on SiteGround "Todo" becomes "INBOX.Todo".
pub async fn resolve_folders(session: &mut Session, wanted: &[String]) -> Result<Vec<String>> {
    let names: Vec<_> = session
        .list(Some(""), Some("*"))
        .await
        .context("LIST command failed")?
        .try_collect()
        .await?;
    let delim = names
        .iter()
        .find_map(|n| n.delimiter().map(str::to_string))
        .unwrap_or_else(|| ".".into());
    let existing: Vec<String> = names.iter().map(|n| n.name().to_string()).collect();
    let prefix = format!("INBOX{delim}");
    // Does the server keep every folder inside INBOX?
    let others: Vec<&String> = existing.iter().filter(|n| !n.eq_ignore_ascii_case("INBOX")).collect();
    let uses_prefix = !others.is_empty() && others.iter().all(|n| n.starts_with(&prefix));

    let mut out = Vec::new();
    for want in wanted {
        if want.eq_ignore_ascii_case("INBOX") {
            out.push("INBOX".to_string());
            continue;
        }
        let with_prefix = format!("{prefix}{want}");
        if let Some(f) = existing.iter().find(|n| *n == want || **n == with_prefix) {
            out.push(f.clone());
            continue;
        }
        let target = if uses_prefix && !want.starts_with(&prefix) { with_prefix } else { want.clone() };
        session
            .create(&target)
            .await
            .with_context(|| format!("cannot create folder {target}"))?;
        session.subscribe(&target).await.ok();
        out.push(target);
    }
    Ok(out)
}

/// Cards already downloaded for a folder, so they are not fetched again on every refresh.
#[derive(Debug, Default)]
pub struct FolderCache {
    uid_validity: Option<u32>,
    cards: std::collections::HashMap<u32, crate::message::Card>,
}

/// Loads the most recent cards of a folder (at most `limit`).
/// Downloads only new emails; for the others only the flags are refreshed.
pub async fn load_cards(
    session: &mut Session,
    folder: &str,
    cache: &mut FolderCache,
    limit: u32,
) -> Result<Vec<crate::message::Card>> {
    use async_imap::types::Flag;

    let mailbox = session
        .select(folder)
        .await
        .with_context(|| format!("cannot open folder {folder}"))?;
    if mailbox.uid_validity != cache.uid_validity {
        cache.cards.clear();
        cache.uid_validity = mailbox.uid_validity;
    }
    if mailbox.exists == 0 {
        cache.cards.clear();
        return Ok(Vec::new());
    }
    let start = mailbox.exists.saturating_sub(limit.max(1) - 1).max(1);
    let range = format!("{start}:*");

    // 1) UIDs + flags (lightweight).
    let flags: Vec<_> = session
        .fetch(&range, "(UID FLAGS)")
        .await
        .context("reading flags failed")?
        .try_collect()
        .await?;
    let mut current = std::collections::HashMap::new();
    for f in &flags {
        let Some(uid) = f.uid else { continue };
        let flagged = f.flags().any(|x| matches!(x, Flag::Flagged));
        let seen = f.flags().any(|x| matches!(x, Flag::Seen));
        current.insert(uid, (flagged, seen));
    }

    // 2) Download the first 32 KB, only for emails we do not have yet.
    let missing: Vec<u32> = current.keys().filter(|u| !cache.cards.contains_key(u)).copied().collect();
    for chunk in missing.chunks(50) {
        let set = chunk.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let fetched: Vec<_> = session
            .uid_fetch(&set, "(UID INTERNALDATE BODY.PEEK[]<0.32768>)")
            .await
            .context("reading emails failed")?
            .try_collect()
            .await?;
        for f in fetched {
            let Some(uid) = f.uid else { continue };
            let date = f.internal_date().map(|d| d.timestamp()).unwrap_or(0);
            let card = crate::message::parse_card(uid, f.body().unwrap_or_default(), false, false, date);
            cache.cards.insert(uid, card);
        }
    }

    cache.cards.retain(|uid, _| current.contains_key(uid));
    let mut cards: Vec<_> = cache
        .cards
        .values_mut()
        .map(|c| {
            let (flagged, seen) = current[&c.uid];
            c.flagged = flagged;
            c.seen = seen;
            c.clone()
        })
        .collect();
    // Pinned emails first, then newest first.
    cards.sort_by(|a, b| b.flagged.cmp(&a.flagged).then(b.date.cmp(&a.date)));
    Ok(cards)
}

/// Downloads the raw email (without marking it as read).
pub async fn load_raw(session: &mut Session, folder: &str, uid: u32) -> Result<Vec<u8>> {
    session.select(folder).await.with_context(|| format!("cannot open {folder}"))?;
    let fetched: Vec<_> = session
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
        .await
        .context("reading the email failed")?
        .try_collect()
        .await?;
    fetched
        .iter()
        .find_map(|f| f.body().map(<[u8]>::to_vec))
        .ok_or_else(|| anyhow!("the email no longer exists (moved by another program?)"))
}

/// Downloads the full email for the reader (without marking it as read).
pub async fn load_message(session: &mut Session, folder: &str, uid: u32) -> Result<crate::message::MessageView> {
    session.select(folder).await.with_context(|| format!("cannot open {folder}"))?;
    let fetched: Vec<_> = session
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
        .await
        .context("reading the email failed")?
        .try_collect()
        .await?;
    let raw = fetched
        .iter()
        .find_map(|f| f.body())
        .ok_or_else(|| anyhow!("the email no longer exists (moved by another program?)"))?;
    Ok(crate::message::parse_view(raw))
}

/// Moves an email: MOVE if the server supports it, otherwise COPY + \Deleted + EXPUNGE.
pub async fn move_message(session: &mut Session, caps: ServerCaps, from: &str, uid: u32, to: &str) -> Result<()> {
    session.select(from).await.with_context(|| format!("cannot open {from}"))?;
    let set = uid.to_string();
    if caps.r#move {
        session.uid_mv(&set, to).await.context("MOVE failed")?;
        return Ok(());
    }
    session.uid_copy(&set, to).await.context("COPY failed")?;
    let _: Vec<_> = session
        .uid_store(&set, "+FLAGS.SILENT (\\Deleted)")
        .await
        .context("setting \\Deleted failed")?
        .try_collect()
        .await?;
    if caps.uidplus {
        let _: Vec<_> = session.uid_expunge(&set).await?.try_collect().await?;
    } else {
        let _: Vec<_> = session.expunge().await?.try_collect().await?;
    }
    Ok(())
}

/// Turns the pin (IMAP \Flagged flag) on or off.
pub async fn set_flagged(session: &mut Session, folder: &str, uid: u32, flagged: bool) -> Result<()> {
    session.select(folder).await.with_context(|| format!("cannot open {folder}"))?;
    let op = if flagged { "+FLAGS.SILENT (\\Flagged)" } else { "-FLAGS.SILENT (\\Flagged)" };
    let _: Vec<_> = session
        .uid_store(uid.to_string(), op)
        .await
        .context("changing the pin failed")?
        .try_collect()
        .await?;
    Ok(())
}

/// Waits for changes in a folder. Returns when the server reports a change
/// or after `max_wait`. Gives the session back so it can be reused.
pub async fn wait_for_change(mut session: Session, folder: &str, max_wait: std::time::Duration) -> Result<Session> {
    session.select(folder).await.with_context(|| format!("cannot open {folder}"))?;
    let mut idle = session.idle();
    idle.init().await.context("IDLE did not start")?;
    let (wait, _stop) = idle.wait_with_timeout(max_wait);
    wait.await.context("IDLE interrupted")?;
    idle.done().await.context("ending IDLE failed")
}

/// Marks an email as read or unread (\Seen flag).
pub async fn set_seen(session: &mut Session, folder: &str, uid: u32, seen: bool) -> Result<()> {
    session.select(folder).await.with_context(|| format!("cannot open {folder}"))?;
    let op = if seen { "+FLAGS.SILENT (\\Seen)" } else { "-FLAGS.SILENT (\\Seen)" };
    let _: Vec<_> = session
        .uid_store(uid.to_string(), op)
        .await
        .context("changing read state failed")?
        .try_collect()
        .await?;
    Ok(())
}

/// Marks an email as answered (\Answered flag).
pub async fn set_answered(session: &mut Session, folder: &str, uid: u32) -> Result<()> {
    session.select(folder).await.with_context(|| format!("cannot open {folder}"))?;
    let _: Vec<_> = session
        .uid_store(uid.to_string(), "+FLAGS.SILENT (\\Answered)")
        .await?
        .try_collect()
        .await?;
    Ok(())
}

/// Finds the sent-mail folder: the one the server marks \Sent, otherwise
/// by name (Sent, Inviata, Sent Messages...). Creates it if missing.
pub async fn sent_folder(session: &mut Session) -> Result<String> {
    use async_imap::types::NameAttribute;
    let names: Vec<_> = session
        .list(Some(""), Some("*"))
        .await
        .context("LIST command failed")?
        .try_collect()
        .await?;
    if let Some(n) = names.iter().find(|n| n.attributes().iter().any(|a| matches!(a, NameAttribute::Sent))) {
        return Ok(n.name().to_string());
    }
    let delim = names.iter().find_map(|n| n.delimiter()).unwrap_or(".");
    for candidate in ["Sent", "Sent Items", "Inviata", "Posta inviata", "Sent Messages"] {
        for full in [format!("INBOX{delim}{candidate}"), candidate.to_string()] {
            if let Some(n) = names.iter().find(|n| n.name().eq_ignore_ascii_case(&full)) {
                return Ok(n.name().to_string());
            }
        }
    }
    let resolved = resolve_folders(session, &["Sent".to_string()]).await?;
    Ok(resolved.into_iter().next().unwrap())
}

/// Saves a copy of a sent email to the given folder, already marked as read.
pub async fn append_sent(session: &mut Session, folder: &str, raw: &[u8]) -> Result<()> {
    session
        .append(folder, Some("(\\Seen)"), None, raw)
        .await
        .with_context(|| format!("saving a copy to {folder} failed"))
}

/// A folder for the sidebar.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FolderInfo {
    /// Full name on the server, e.g. "INBOX.Clients.Smith".
    pub name: String,
    /// Display name (last segment), e.g. "Smith".
    pub label: String,
    /// Nesting level (0 = top level).
    pub depth: usize,
    /// inbox, sent, trash, junk, drafts, archive or "".
    pub kind: String,
    /// Whether the folder can hold emails (some are only containers).
    pub selectable: bool,
    pub unseen: Option<u32>,
}

fn folder_kind(name: &str, attrs: &[async_imap::types::NameAttribute<'_>], delim: &str) -> &'static str {
    use async_imap::types::NameAttribute as A;
    for a in attrs {
        match a {
            A::Sent => return "sent",
            A::Trash => return "trash",
            A::Junk => return "junk",
            A::Drafts => return "drafts",
            A::Archive => return "archive",
            _ => {}
        }
    }
    if name.eq_ignore_ascii_case("INBOX") {
        return "inbox";
    }
    let leaf = name.rsplit(delim).next().unwrap_or(name).to_lowercase();
    match leaf.as_str() {
        "sent" | "sent items" | "sent messages" | "inviata" | "posta inviata" => "sent",
        "trash" | "deleted messages" | "deleted items" | "cestino" | "eliminati" => "trash",
        "junk" | "spam" | "posta indesiderata" => "junk",
        "drafts" | "bozze" => "drafts",
        "archive" | "archivio" => "archive",
        _ => "",
    }
}

/// All folders, sorted as a tree, with unread counts.
pub async fn folder_tree(session: &mut Session) -> Result<Vec<FolderInfo>> {
    use async_imap::types::NameAttribute;
    let names: Vec<_> = session
        .list(Some(""), Some("*"))
        .await
        .context("LIST command failed")?
        .try_collect()
        .await?;
    let delim = names.iter().find_map(|n| n.delimiter()).unwrap_or(".").to_string();
    let prefix = format!("INBOX{delim}");
    let mut out: Vec<FolderInfo> = names
        .iter()
        .map(|n| {
            let name = n.name().to_string();
            // On servers that keep everything inside INBOX, show its subfolders as top level.
            let shown = name.strip_prefix(&prefix).unwrap_or(&name);
            let depth = shown.matches(delim.as_str()).count();
            FolderInfo {
                label: shown.rsplit(delim.as_str()).next().unwrap_or(shown).to_string(),
                depth,
                kind: folder_kind(&name, n.attributes(), &delim).to_string(),
                selectable: !n.attributes().iter().any(|a| matches!(a, NameAttribute::NoSelect)),
                unseen: None,
                name,
            }
        })
        .collect();
    // INBOX first, then special folders, then the rest alphabetically.
    // Each subfolder follows its top-level parent.
    let rank = |k: &str| match k {
        "inbox" => 0,
        "drafts" => 1,
        "sent" => 2,
        "archive" => 3,
        "junk" => 4,
        "trash" => 5,
        _ => 6,
    };
    let path = |f: &FolderInfo| f.name.strip_prefix(&prefix).unwrap_or(&f.name).to_lowercase();
    let root_rank: std::collections::HashMap<String, i32> = out
        .iter()
        .filter(|f| f.depth == 0)
        .map(|f| (path(f), rank(&f.kind)))
        .collect();
    let key = |f: &FolderInfo| {
        let p = path(f);
        let root = p.split(delim.as_str()).next().unwrap_or("").to_string();
        let r = if f.name.eq_ignore_ascii_case("INBOX") { -1 } else { *root_rank.get(&root).unwrap_or(&6) };
        (r, root, p)
    };
    out.sort_by_key(key);
    for f in out.iter_mut().filter(|f| f.selectable) {
        if let Ok(mb) = session.status(&f.name, "(UNSEEN)").await {
            f.unseen = mb.unseen;
        }
    }
    Ok(out)
}

/// Special folder ("trash", "archive", "drafts", "sent"): first the one the
/// server marks (\\Trash, \\Archive...), then by well-known name. `None` if missing.
pub async fn find_special_folder(session: &mut Session, kind: &str) -> Result<Option<String>> {
    let names: Vec<_> = session.list(Some(""), Some("*")).await?.try_collect().await?;
    let delim = names.iter().find_map(|n| n.delimiter()).unwrap_or(".").to_string();
    let by_attribute = names
        .iter()
        .find(|n| !n.attributes().is_empty() && folder_kind("", n.attributes(), &delim) == kind);
    let by_name = || names.iter().find(|n| folder_kind(n.name(), &[], &delim) == kind);
    Ok(by_attribute.or_else(by_name).map(|n| n.name().to_string()))
}

/// Like [`find_special_folder`], but creates the folder if it does not exist.
pub async fn special_folder(session: &mut Session, kind: &str) -> Result<String> {
    let default_name = match kind {
        "trash" => "Trash",
        "archive" => "Archive",
        "drafts" => "Drafts",
        "sent" => "Sent",
        _ => anyhow::bail!("unknown special folder: {kind}"),
    };
    if let Some(found) = find_special_folder(session, kind).await? {
        return Ok(found);
    }
    Ok(resolve_folders(session, &[default_name.to_string()]).await?.remove(0))
}

pub async fn trash_folder(session: &mut Session) -> Result<String> {
    special_folder(session, "trash").await
}

/// UIDs in the selected folder whose Message-ID header matches `message_id`.
async fn uids_by_message_id(session: &mut Session, message_id: &str) -> Result<Vec<u32>> {
    let bare = message_id.trim().trim_start_matches('<').trim_end_matches('>');
    anyhow::ensure!(!bare.is_empty() && !bare.contains('"') && !bare.contains('\\'), "invalid Message-ID");
    let mut uids: Vec<u32> = session
        .uid_search(format!("HEADER Message-ID \"{bare}\""))
        .await
        .context("SEARCH failed")?
        .into_iter()
        .collect();
    uids.sort_unstable();
    Ok(uids)
}

async fn delete_uids(session: &mut Session, caps: ServerCaps, uids: &[u32]) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let _: Vec<_> = session
        .uid_store(&set, "+FLAGS.SILENT (\\Deleted)")
        .await
        .context("setting \\Deleted failed")?
        .try_collect()
        .await?;
    if caps.uidplus {
        let _: Vec<_> = session.uid_expunge(&set).await?.try_collect().await?;
    } else {
        let _: Vec<_> = session.expunge().await?.try_collect().await?;
    }
    Ok(())
}

/// Saves a draft to the Drafts folder and removes its older versions
/// (same Message-ID). Returns the Drafts folder name.
pub async fn save_draft(session: &mut Session, caps: ServerCaps, raw: &[u8], message_id: &str) -> Result<String> {
    let folder = special_folder(session, "drafts").await?;
    session
        .append(&folder, Some("(\\Draft \\Seen)"), None, raw)
        .await
        .with_context(|| format!("saving the draft to {folder} failed"))?;
    session.select(&folder).await.with_context(|| format!("cannot open {folder}"))?;
    let uids = uids_by_message_id(session, message_id).await?;
    // The newest copy has the highest UID: keep it, remove the others.
    if let Some((_, older)) = uids.split_last() {
        delete_uids(session, caps, older).await?;
    }
    Ok(folder)
}

/// Removes every copy of a draft (after sending it, or when it is discarded).
pub async fn delete_draft(session: &mut Session, caps: ServerCaps, message_id: &str) -> Result<()> {
    let folder = special_folder(session, "drafts").await?;
    session.select(&folder).await.with_context(|| format!("cannot open {folder}"))?;
    let uids = uids_by_message_id(session, message_id).await?;
    delete_uids(session, caps, &uids).await
}

/// How many of the most recent emails of each folder a conversation search looks at.
const THREAD_SEARCH_DEPTH: u32 = 2000;

/// One email of a conversation, with the folder it lives in.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ThreadEntry {
    pub folder: String,
    pub card: crate::message::Card,
}

fn bare_id(id: &str) -> String {
    id.trim().trim_start_matches('<').trim_end_matches('>').to_string()
}

/// `OR a OR b c` from a list of IMAP search keys.
fn or_chain(keys: &[String]) -> String {
    match keys {
        [] => String::new(),
        [only] => only.clone(),
        [first, rest @ ..] => format!("OR {first} {}", or_chain(rest)),
    }
}

/// Finds the other emails of a conversation: those the message refers to
/// (References / In-Reply-To) and those that refer to the same thread, in the
/// given folders. Returns them oldest first, without duplicates.
pub async fn load_thread(
    session: &mut Session,
    message_id: Option<&str>,
    references: &[String],
    folders: &[String],
) -> Result<Vec<ThreadEntry>> {
    let mut ids: Vec<String> = references.iter().map(|r| bare_id(r)).collect();
    if let Some(id) = message_id {
        ids.push(bare_id(id));
    }
    ids.retain(|id| !id.is_empty() && !id.contains('"') && !id.contains('\\'));
    ids.dedup();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    // Keep the search short: the thread root plus the most recent references.
    let root = ids[0].clone();
    let recent: Vec<String> = ids.iter().rev().take(15).cloned().collect();
    let mut keys: Vec<String> = recent.iter().map(|id| format!("HEADER Message-ID \"{id}\"")).collect();
    keys.push(format!("HEADER References \"{root}\""));
    keys.push(format!("HEADER In-Reply-To \"{root}\""));
    let query = or_chain(&keys);

    let mut out = search_folders(session, folders, &query, Some(THREAD_SEARCH_DEPTH), 50).await?;
    out.sort_by_key(|e| e.card.date);
    Ok(out)
}

/// Runs an IMAP search in each folder and returns the matching emails as cards,
/// at most `per_folder` (the newest) per folder, without duplicates across folders.
/// `depth` limits the search to the most recent emails of each folder.
async fn search_folders(
    session: &mut Session,
    folders: &[String],
    criteria: &str,
    depth: Option<u32>,
    per_folder: usize,
) -> Result<Vec<ThreadEntry>> {
    use async_imap::types::Flag;
    let mut seen_ids = std::collections::HashSet::new();
    let mut out = Vec::new();
    for folder in folders {
        let Ok(mailbox) = session.examine(folder).await else {
            continue; // folder missing or not selectable: skip it
        };
        if mailbox.exists == 0 {
            continue;
        }
        let query = match depth {
            Some(d) => format!("{}:* ({criteria})", mailbox.exists.saturating_sub(d - 1).max(1)),
            None => criteria.to_string(),
        };
        let found = match session.uid_search(&query).await {
            Ok(found) => found,
            Err(e) => {
                eprintln!("[{folder}] search failed: {e}");
                continue;
            }
        };
        let mut uids: Vec<u32> = found.into_iter().collect();
        if uids.is_empty() {
            continue;
        }
        uids.sort_unstable();
        let set = uids.iter().rev().take(per_folder).map(u32::to_string).collect::<Vec<_>>().join(",");
        let fetched: Vec<_> = session
            .uid_fetch(&set, "(UID FLAGS INTERNALDATE BODY.PEEK[]<0.32768>)")
            .await
            .with_context(|| format!("reading results in {folder} failed"))?
            .try_collect()
            .await?;
        for f in fetched {
            let Some(uid) = f.uid else { continue };
            let date = f.internal_date().map(|d| d.timestamp()).unwrap_or(0);
            let flagged = f.flags().any(|x| matches!(x, Flag::Flagged));
            let seen = f.flags().any(|x| matches!(x, Flag::Seen));
            let card = crate::message::parse_card(uid, f.body().unwrap_or_default(), flagged, seen, date);
            // The same email can sit in several folders (e.g. Inbox and Archive).
            let key = card.message_id.clone().map(|id| bare_id(&id)).unwrap_or_else(|| format!("{folder}/{uid}"));
            if seen_ids.insert(key) {
                out.push(ThreadEntry { folder: folder.clone(), card });
            }
        }
    }
    Ok(out)
}

/// An IMAP quoted string (backslashes and quotes escaped).
fn imap_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Every folder worth searching: all selectable folders except Trash, Junk and Drafts.
pub async fn searchable_folders(session: &mut Session) -> Result<Vec<String>> {
    use async_imap::types::NameAttribute;
    let names: Vec<_> = session.list(Some(""), Some("*")).await?.try_collect().await?;
    let delim = names.iter().find_map(|n| n.delimiter()).unwrap_or(".").to_string();
    let mut out: Vec<String> = names
        .iter()
        .filter(|n| !n.attributes().iter().any(|a| matches!(a, NameAttribute::NoSelect)))
        .filter(|n| !matches!(folder_kind(n.name(), n.attributes(), &delim), "trash" | "junk" | "drafts"))
        .map(|n| n.name().to_string())
        .collect();
    // INBOX first: it is where most results are.
    out.sort_by_key(|n| (!n.eq_ignore_ascii_case("INBOX"), n.to_lowercase()));
    Ok(out)
}

/// Searches emails whose sender, recipients or subject contain `text` (and, with
/// `in_body`, the text of the email too, which is much slower without a server
/// index). Newest first, at most `limit` per folder.
pub async fn search(
    session: &mut Session,
    text: &str,
    in_body: bool,
    folders: &[String],
    limit: usize,
) -> Result<Vec<ThreadEntry>> {
    let words: Vec<&str> = text.split_whitespace().collect();
    anyhow::ensure!(!words.is_empty(), "empty search");
    // Every word must match somewhere (AND of ORs).
    let per_word: Vec<String> = words
        .iter()
        .map(|w| {
            let q = imap_quote(w);
            let mut keys = vec![format!("FROM {q}"), format!("TO {q}"), format!("CC {q}"), format!("SUBJECT {q}")];
            if in_body {
                keys.push(format!("BODY {q}"));
            }
            format!("({})", or_chain(&keys))
        })
        .collect();
    let criteria = format!("CHARSET UTF-8 {}", per_word.join(" "));
    let mut out = search_folders(session, folders, &criteria, None, limit).await?;
    out.sort_by(|a, b| b.card.date.cmp(&a.card.date));
    Ok(out)
}

/// Everyone you have written to: the To/Cc/Bcc addresses of the most recent
/// `limit` emails in every sent-mail folder, lowercased.
pub async fn sent_recipients(session: &mut Session, limit: u32) -> Result<std::collections::BTreeSet<String>> {
    let names: Vec<_> = session.list(Some(""), Some("*")).await?.try_collect().await?;
    let delim = names.iter().find_map(|n| n.delimiter()).unwrap_or(".").to_string();
    let sent: Vec<String> = names
        .iter()
        .filter(|n| folder_kind(n.name(), n.attributes(), &delim) == "sent")
        .map(|n| n.name().to_string())
        .collect();
    let mut out = std::collections::BTreeSet::new();
    for folder in sent {
        let Ok(mailbox) = session.examine(&folder).await else { continue };
        if mailbox.exists == 0 {
            continue;
        }
        let start = mailbox.exists.saturating_sub(limit.max(1) - 1).max(1);
        let fetched: Vec<_> = session
            .fetch(format!("{start}:*"), "(BODY.PEEK[HEADER])")
            .await
            .with_context(|| format!("reading {folder} failed"))?
            .try_collect()
            .await?;
        for f in fetched {
            let Some(raw) = f.header() else { continue };
            let Some(m) = mail_parser::MessageParser::default().parse(raw) else { continue };
            for list in [m.to(), m.cc(), m.bcc()].into_iter().flatten() {
                for mb in list.mailboxes() {
                    if let Some(a) = mb.address() {
                        out.insert(a.trim().to_lowercase());
                    }
                }
            }
        }
    }
    Ok(out)
}

/// A cheap fingerprint of a folder (count, next UID, unread count and, with
/// CONDSTORE, the modification sequence that also changes on flag updates).
/// When it changes, something happened in the folder.
pub async fn folder_fingerprint(session: &mut Session, folder: &str, caps: ServerCaps) -> Result<(u32, u32, u32, u64)> {
    let items = if caps.condstore { "(MESSAGES UIDNEXT UNSEEN HIGHESTMODSEQ)" } else { "(MESSAGES UIDNEXT UNSEEN)" };
    let mb = session.status(folder, items).await.with_context(|| format!("STATUS {folder} failed"))?;
    Ok((mb.exists, mb.uid_next.unwrap_or(0), mb.unseen.unwrap_or(0), mb.highest_modseq.unwrap_or(0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_and_or_chains() {
        assert_eq!(imap_quote(r#"say "hi" \ bye"#), r#""say \"hi\" \\ bye""#);
        assert_eq!(or_chain(&["A".into(), "B".into(), "C".into()]), "OR A OR B C");
        assert_eq!(or_chain(&["A".into()]), "A");
    }
}
