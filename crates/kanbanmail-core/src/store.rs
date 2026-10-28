//! Local copy of the mailbox (SQLite): cards of every folder seen, the content
//! of opened or prefetched emails, a full-text index for instant search,
//! conversations computed locally and the queue of actions made offline.
//!
//! The server stays the reference: everything here is a cache that can be
//! deleted at any time (it is rebuilt as folders are opened again).

use crate::imap::ThreadEntry;
use crate::message::Card;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS folders (
    name TEXT PRIMARY KEY,
    uidvalidity INTEGER
);
CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY,
    folder TEXT NOT NULL,
    uid INTEGER NOT NULL,
    mid TEXT,
    date INTEGER NOT NULL,
    body_key TEXT NOT NULL,
    card TEXT NOT NULL,
    UNIQUE (folder, uid)
);
CREATE INDEX IF NOT EXISTS cards_mid ON cards (mid);
CREATE INDEX IF NOT EXISTS cards_date ON cards (folder, date);
CREATE TABLE IF NOT EXISTS refs (
    ref TEXT NOT NULL,
    card INTEGER NOT NULL REFERENCES cards (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS refs_ref ON refs (ref);
CREATE INDEX IF NOT EXISTS refs_card ON refs (card);
CREATE TABLE IF NOT EXISTS bodies (
    key TEXT PRIMARY KEY,
    raw BLOB,
    size INTEGER NOT NULL,
    last_access INTEGER NOT NULL,
    too_big INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5 (
    sender, recipients, subject, body,
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
";

/// How much body text goes into the search index for each email.
const INDEXED_BODY_CHARS: usize = 20_000;

pub struct Store {
    conn: Connection,
}

/// An action made while the server could not be reached, sent later.
#[derive(Debug, Clone, Serialize)]
pub struct QueuedAction {
    pub id: i64,
    pub kind: String,
    pub payload: String,
    pub created: i64,
    pub attempts: u32,
    pub last_error: Option<String>,
}

/// How much the local copy holds.
#[derive(Debug, Clone, Serialize, Default)]
pub struct StoreStats {
    pub emails: u64,
    pub bodies: u64,
    pub bytes: u64,
    pub queued: u64,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// "<Abc@Host>" -> "abc@host": the form used to compare Message-IDs.
pub fn bare_id(id: &str) -> String {
    id.trim().trim_start_matches('<').trim_end_matches('>').trim().to_lowercase()
}

/// Where the content of an email is kept: the same email in two folders (or
/// after a move) shares it, so it is downloaded once.
fn body_key(folder: &str, uidvalidity: Option<u32>, card: &Card) -> String {
    match card.message_id.as_deref().map(bare_id).filter(|m| !m.is_empty()) {
        Some(mid) => format!("mid:{mid}"),
        None => format!("uid:{folder}/{}/{}", uidvalidity.unwrap_or(0), card.uid),
    }
}

/// The folder of the cache for an email address (one database per account).
pub fn path_for(email: &str) -> Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("", "", "KanbanMail").context("cannot determine the cache folder")?;
    let safe: String = email
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '@' || c == '-' { c } else { '_' })
        .collect();
    Ok(dirs.cache_dir().join(format!("{safe}.sqlite")))
}

/// Deletes the local copy of an account (when it is disconnected or the cache is cleared).
pub fn delete_for(email: &str) -> Result<()> {
    let path = path_for(email)?;
    for suffix in ["", "-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{suffix}", path.display()));
        if p.exists() {
            std::fs::remove_file(&p).with_context(|| format!("cannot delete {}", p.display()))?;
        }
    }
    Ok(())
}

impl Store {
    /// Opens (or creates) the local copy of an account.
    pub fn open(email: &str) -> Result<Store> {
        let path = path_for(email)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
        }
        Self::open_at(&path)
    }

    pub fn open_at(path: &Path) -> Result<Store> {
        let conn = Connection::open(path).with_context(|| format!("cannot open the local copy {}", path.display()))?;
        conn.execute_batch(SCHEMA).context("cannot prepare the local copy")?;
        Ok(Store { conn })
    }

    /// An empty store in memory (tests).
    pub fn in_memory() -> Result<Store> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn })
    }

    // ---------- cards ----------

    /// The UIDVALIDITY and every card known for a folder.
    pub fn folder_cards(&self, folder: &str) -> Result<(Option<u32>, Vec<Card>)> {
        let validity: Option<u32> = self
            .conn
            .query_row("SELECT uidvalidity FROM folders WHERE name = ?1", [folder], |r| r.get(0))
            .optional()?
            .flatten();
        let mut stmt = self.conn.prepare_cached("SELECT card FROM cards WHERE folder = ?1")?;
        let cards = stmt
            .query_map([folder], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .filter_map(|json| serde_json::from_str::<Card>(&json).ok())
            .collect();
        Ok((validity, cards))
    }

    /// The newest cards of a folder, pinned first (as the server list is shown).
    pub fn cards(&self, folder: &str, limit: u32) -> Result<Vec<Card>> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT card FROM cards WHERE folder = ?1 ORDER BY date DESC LIMIT ?2")?;
        let mut cards: Vec<Card> = stmt
            .query_map(params![folder, limit], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .filter_map(|json| serde_json::from_str(&json).ok())
            .collect();
        cards.sort_by(|a, b| b.flagged.cmp(&a.flagged).then(b.date.cmp(&a.date)));
        Ok(cards)
    }

    /// Records what the server returned for the newest emails of a folder.
    /// Cards missing from that window (UIDs from the oldest one shown up, or
    /// all of them when `complete`: the window was the whole folder) were moved
    /// or deleted and are removed; older ones are kept.
    pub fn save_cards(&mut self, folder: &str, uidvalidity: Option<u32>, cards: &[Card], complete: bool) -> Result<()> {
        let tx = self.conn.transaction()?;
        let old: Option<Option<u32>> = tx
            .query_row("SELECT uidvalidity FROM folders WHERE name = ?1", [folder], |r| r.get(0))
            .optional()?;
        if old.is_some_and(|v| v != uidvalidity) {
            // The server renumbered the folder: what we had is meaningless.
            delete_cards_where(&tx, "folder = ?1", params![folder])?;
        }
        tx.execute(
            "INSERT INTO folders (name, uidvalidity) VALUES (?1, ?2)
             ON CONFLICT (name) DO UPDATE SET uidvalidity = excluded.uidvalidity",
            params![folder, uidvalidity],
        )?;
        match cards.iter().map(|c| c.uid).min().map(|m| if complete { 0 } else { m }) {
            Some(min) => {
                let keep: HashSet<u32> = cards.iter().map(|c| c.uid).collect();
                let gone: Vec<u32> = {
                    let mut stmt = tx.prepare("SELECT uid FROM cards WHERE folder = ?1 AND uid >= ?2")?;
                    let rows = stmt.query_map(params![folder, min], |r| r.get::<_, u32>(0))?;
                    rows.filter_map(|r| r.ok()).filter(|u| !keep.contains(u)).collect()
                };
                for uid in gone {
                    delete_cards_where(&tx, "folder = ?1 AND uid = ?2", params![folder, uid])?;
                }
            }
            None => delete_cards_where(&tx, "folder = ?1", params![folder])?,
        }
        // Only cards that changed (new, read, pinned…) are written again.
        let known: std::collections::HashMap<u32, String> = {
            let mut stmt = tx.prepare("SELECT uid, card FROM cards WHERE folder = ?1")?;
            let rows = stmt.query_map([folder], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?)))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for card in cards {
            if known.get(&card.uid).is_some_and(|old| *old == serde_json::to_string(card).unwrap_or_default()) {
                continue;
            }
            upsert_card(&tx, folder, uidvalidity, card)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Adds cards without touching the others (search results, conversations, All Mail).
    pub fn add_cards(&mut self, entries: &[ThreadEntry]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for e in entries {
            let validity: Option<u32> = tx
                .query_row("SELECT uidvalidity FROM folders WHERE name = ?1", [&e.folder], |r| r.get(0))
                .optional()?
                .flatten();
            upsert_card(&tx, &e.folder, validity, &e.card)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Emails that left a folder (moved, archived, deleted).
    pub fn remove(&mut self, folder: &str, uids: &[u32]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for uid in uids {
            delete_cards_where(&tx, "folder = ?1 AND uid = ?2", params![folder, uid])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Forgets everything known about a folder (e.g. after emptying it).
    pub fn clear_folder(&mut self, folder: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        delete_cards_where(&tx, "folder = ?1", params![folder])?;
        tx.commit()?;
        Ok(())
    }

    /// Read / pinned changes made from the app.
    pub fn set_flags(&mut self, folder: &str, uids: &[u32], seen: Option<bool>, flagged: Option<bool>) -> Result<()> {
        let tx = self.conn.transaction()?;
        for uid in uids {
            let json: Option<String> = tx
                .query_row("SELECT card FROM cards WHERE folder = ?1 AND uid = ?2", params![folder, uid], |r| r.get(0))
                .optional()?;
            let Some(mut card) = json.and_then(|j| serde_json::from_str::<Card>(&j).ok()) else { continue };
            if let Some(s) = seen {
                card.seen = s;
            }
            if let Some(f) = flagged {
                card.flagged = f;
            }
            tx.execute(
                "UPDATE cards SET card = ?3 WHERE folder = ?1 AND uid = ?2",
                params![folder, uid, serde_json::to_string(&card)?],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The newest cards of every folder, newest first.
    pub fn recent(&self, limit: u32) -> Result<Vec<ThreadEntry>> {
        let mut stmt = self.conn.prepare_cached("SELECT folder, card FROM cards ORDER BY date DESC LIMIT ?1")?;
        let rows = stmt.query_map([limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows
            .filter_map(|r| r.ok())
            .filter_map(|(folder, json)| serde_json::from_str(&json).ok().map(|card| ThreadEntry { folder, card }))
            .collect())
    }

    // ---------- email content ----------

    /// The full email, if it was downloaded before.
    pub fn raw(&self, folder: &str, uid: u32) -> Result<Option<Vec<u8>>> {
        let key: Option<String> = self
            .conn
            .query_row("SELECT body_key FROM cards WHERE folder = ?1 AND uid = ?2", params![folder, uid], |r| r.get(0))
            .optional()?;
        let Some(key) = key else { return Ok(None) };
        let raw: Option<Vec<u8>> = self
            .conn
            .query_row("SELECT raw FROM bodies WHERE key = ?1 AND raw IS NOT NULL", [&key], |r| r.get(0))
            .optional()?;
        if raw.is_some() {
            self.conn.execute("UPDATE bodies SET last_access = ?2 WHERE key = ?1", params![key, now()])?;
        }
        Ok(raw)
    }

    /// Keeps the full email (and indexes its text for search).
    pub fn put_raw(&mut self, folder: &str, uid: u32, raw: &[u8]) -> Result<()> {
        let row: Option<(i64, String)> = self
            .conn
            .query_row("SELECT id, body_key FROM cards WHERE folder = ?1 AND uid = ?2", params![folder, uid], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let Some((id, key)) = row else { return Ok(()) };
        let view = crate::message::parse_view(raw);
        let mut text = view.text.unwrap_or_default();
        if text.len() > INDEXED_BODY_CHARS {
            let mut cut = INDEXED_BODY_CHARS;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO bodies (key, raw, size, last_access, too_big) VALUES (?1, ?2, ?3, ?4, 0)
             ON CONFLICT (key) DO UPDATE SET raw = excluded.raw, size = excluded.size, last_access = excluded.last_access, too_big = 0",
            params![key, raw, raw.len() as i64, now()],
        )?;
        // Every copy of this email (same Message-ID in other folders) gets the body text.
        let ids: Vec<i64> = {
            let mut stmt = tx.prepare("SELECT id FROM cards WHERE body_key = ?1")?;
            let rows = stmt.query_map([&key], |r| r.get(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for card_id in if ids.is_empty() { vec![id] } else { ids } {
            tx.execute("UPDATE search SET body = ?2 WHERE rowid = ?1", params![card_id, text])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Remembers that an email is too big to be downloaded in the background.
    pub fn mark_too_big(&mut self, folder: &str, uid: u32, size: u64) -> Result<()> {
        let key: Option<String> = self
            .conn
            .query_row("SELECT body_key FROM cards WHERE folder = ?1 AND uid = ?2", params![folder, uid], |r| r.get(0))
            .optional()?;
        if let Some(key) = key {
            self.conn.execute(
                "INSERT INTO bodies (key, raw, size, last_access, too_big) VALUES (?1, NULL, ?2, ?3, 1)
                 ON CONFLICT (key) DO NOTHING",
                params![key, size as i64, now()],
            )?;
        }
        Ok(())
    }

    /// The newest emails of these folders whose content is not here yet
    /// (and not known to be too big), newest first.
    pub fn missing_bodies(&self, folders: &[String], limit: u32) -> Result<Vec<(String, u32)>> {
        let mut out = Vec::new();
        let mut stmt = self.conn.prepare_cached(
            "SELECT c.folder, c.uid, c.date FROM cards c LEFT JOIN bodies b ON b.key = c.body_key
             WHERE c.folder = ?1 AND b.key IS NULL ORDER BY c.date DESC LIMIT ?2",
        )?;
        let mut all: Vec<(String, u32, i64)> = Vec::new();
        for f in folders {
            let rows = stmt.query_map(params![f, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            all.extend(rows.filter_map(|r| r.ok()));
        }
        all.sort_by(|a, b| b.2.cmp(&a.2));
        all.truncate(limit as usize);
        out.extend(all.into_iter().map(|(f, u, _)| (f, u)));
        Ok(out)
    }

    /// Drops the least recently used email contents until the copy is at
    /// most `max_bytes` (cards and the search index stay). Dropped emails are
    /// not downloaded in the background again, only when opened.
    pub fn evict(&mut self, max_bytes: u64) -> Result<u64> {
        let total: i64 = self.conn.query_row("SELECT COALESCE(SUM(size), 0) FROM bodies WHERE raw IS NOT NULL", [], |r| r.get(0))?;
        let mut over = total - max_bytes as i64;
        if over <= 0 {
            return Ok(0);
        }
        let victims: Vec<(String, i64)> = {
            let mut stmt = self
                .conn
                .prepare("SELECT key, size FROM bodies WHERE raw IS NOT NULL ORDER BY last_access ASC")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            let mut out = Vec::new();
            for r in rows.flatten() {
                if over <= 0 {
                    break;
                }
                over -= r.1;
                out.push(r);
            }
            out
        };
        let tx = self.conn.transaction()?;
        let mut freed = 0;
        for (key, size) in &victims {
            tx.execute("UPDATE bodies SET raw = NULL WHERE key = ?1", [key])?;
            freed += *size as u64;
        }
        tx.commit()?;
        Ok(freed)
    }

    pub fn stats(&self) -> Result<StoreStats> {
        let emails: i64 = self.conn.query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))?;
        let (bodies, bytes): (i64, i64) = self.conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM bodies WHERE raw IS NOT NULL",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let queued: i64 = self.conn.query_row("SELECT COUNT(*) FROM queue", [], |r| r.get(0))?;
        Ok(StoreStats { emails: emails as u64, bodies: bodies as u64, bytes: bytes as u64, queued: queued as u64 })
    }

    // ---------- search and conversations ----------

    /// Emails whose sender, recipients, subject or text contain every word
    /// (accents and case ignored, words may be the start of longer ones).
    pub fn search(&self, text: &str, limit: u32) -> Result<Vec<ThreadEntry>> {
        let words: Vec<String> = text
            .split_whitespace()
            .map(|w| w.chars().filter(|c| c.is_alphanumeric() || matches!(c, '@' | '.' | '-' | '_')).collect::<String>())
            .filter(|w| !w.is_empty())
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect();
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let query = words.join(" ");
        let mut stmt = self.conn.prepare_cached(
            "SELECT c.folder, c.card FROM search s JOIN cards c ON c.id = s.rowid
             WHERE search MATCH ?1 ORDER BY c.date DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![query, limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows
            .filter_map(|r| r.ok())
            .filter_map(|(folder, json)| serde_json::from_str(&json).ok().map(|card| ThreadEntry { folder, card }))
            .collect())
    }

    /// The emails of a conversation known locally: those with one of these
    /// Message-IDs and those referring to them, following the links twice.
    /// Oldest first, one entry per email (the first folder found).
    pub fn thread(&self, message_id: Option<&str>, references: &[String]) -> Result<Vec<ThreadEntry>> {
        let mut ids: HashSet<String> = references.iter().map(|r| bare_id(r)).filter(|r| !r.is_empty()).collect();
        if let Some(m) = message_id.map(bare_id).filter(|m| !m.is_empty()) {
            ids.insert(m);
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut found: std::collections::HashMap<i64, (String, Card)> = std::collections::HashMap::new();
        for _round in 0..2 {
            let list: Vec<String> = ids.iter().cloned().collect();
            let mut new_rows = Vec::new();
            for chunk in list.chunks(200) {
                let marks = vec!["?"; chunk.len()].join(",");
                let sql = format!(
                    "SELECT id, folder, card FROM cards WHERE mid IN ({marks})
                     UNION SELECT c.id, c.folder, c.card FROM refs r JOIN cards c ON c.id = r.card WHERE r.ref IN ({marks})"
                );
                let mut stmt = self.conn.prepare(&sql)?;
                let args: Vec<&dyn rusqlite::ToSql> = chunk.iter().chain(chunk.iter()).map(|s| s as &dyn rusqlite::ToSql).collect();
                let rows = stmt.query_map(args.as_slice(), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
                new_rows.extend(rows.filter_map(|r| r.ok()));
            }
            for (id, folder, json) in new_rows {
                if found.contains_key(&id) {
                    continue;
                }
                let Ok(card) = serde_json::from_str::<Card>(&json) else { continue };
                if let Some(m) = card.message_id.as_deref() {
                    ids.insert(bare_id(m));
                }
                ids.extend(card.thread_refs.iter().map(|r| bare_id(r)));
                found.insert(id, (folder, card));
            }
        }
        let mut seen = HashSet::new();
        let mut out: Vec<ThreadEntry> = found
            .into_values()
            .map(|(folder, card)| ThreadEntry { folder, card })
            .collect();
        out.sort_by_key(|e| e.card.date);
        out.retain(|e| match e.card.message_id.as_deref() {
            Some(m) => seen.insert(bare_id(m)),
            None => true,
        });
        Ok(out)
    }

    // ---------- actions made offline ----------

    pub fn enqueue(&mut self, kind: &str, payload: &str) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO queue (kind, payload, created) VALUES (?1, ?2, ?3)",
            params![kind, payload, now()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Waiting actions, oldest first.
    pub fn queue(&self) -> Result<Vec<QueuedAction>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, kind, payload, created, attempts, last_error FROM queue ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(QueuedAction {
                id: r.get(0)?,
                kind: r.get(1)?,
                payload: r.get(2)?,
                created: r.get(3)?,
                attempts: r.get(4)?,
                last_error: r.get(5)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn dequeue(&mut self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM queue WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn queue_failed(&mut self, id: i64, error: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE queue SET attempts = attempts + 1, last_error = ?2 WHERE id = ?1",
            params![id, error],
        )?;
        Ok(())
    }
}

fn delete_cards_where(tx: &rusqlite::Transaction<'_>, condition: &str, args: impl rusqlite::Params + Clone) -> Result<()> {
    tx.execute(&format!("DELETE FROM search WHERE rowid IN (SELECT id FROM cards WHERE {condition})"), args.clone())?;
    tx.execute(&format!("DELETE FROM cards WHERE {condition}"), args)?;
    Ok(())
}

fn upsert_card(tx: &rusqlite::Transaction<'_>, folder: &str, uidvalidity: Option<u32>, card: &Card) -> Result<()> {
    let mid = card.message_id.as_deref().map(bare_id).filter(|m| !m.is_empty());
    let key = body_key(folder, uidvalidity, card);
    tx.execute(
        "INSERT INTO cards (folder, uid, mid, date, body_key, card) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (folder, uid) DO UPDATE SET mid = excluded.mid, date = excluded.date,
             body_key = excluded.body_key, card = excluded.card",
        params![folder, card.uid, mid, card.date, key, serde_json::to_string(card)?],
    )?;
    let id: i64 = tx.query_row("SELECT id FROM cards WHERE folder = ?1 AND uid = ?2", params![folder, card.uid], |r| r.get(0))?;
    tx.execute("DELETE FROM refs WHERE card = ?1", [id])?;
    for r in card.thread_refs.iter().map(|r| bare_id(r)).filter(|r| !r.is_empty()) {
        tx.execute("INSERT INTO refs (ref, card) VALUES (?1, ?2)", params![r, id])?;
    }
    // The search row keeps the body text already indexed for this email, if any.
    let body: Option<String> = tx
        .query_row("SELECT body FROM search WHERE rowid = ?1", [id], |r| r.get(0))
        .optional()?
        .flatten();
    let body = match body {
        Some(b) => b,
        None => tx
            .query_row(
                "SELECT s.body FROM cards c JOIN search s ON s.rowid = c.id WHERE c.body_key = ?1 AND c.id != ?2 AND s.body != '' LIMIT 1",
                params![key, id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_default(),
    };
    tx.execute("DELETE FROM search WHERE rowid = ?1", [id])?;
    tx.execute(
        "INSERT INTO search (rowid, sender, recipients, subject, body) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, format!("{} {}", card.from, card.from_address), card.to, card.subject, if body.is_empty() { card.preview.clone() } else { body }],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(uid: u32, from: &str, subject: &str, mid: &str, refs: &[&str], date: i64) -> Card {
        Card {
            uid,
            from: from.into(),
            from_address: format!("{}@example.com", from.to_lowercase().replace(' ', ".")),
            subject: subject.into(),
            date,
            preview: format!("preview of {subject}"),
            flagged: false,
            seen: false,
            has_attachments: false,
            message_id: Some(format!("<{mid}>")),
            automated: false,
            thread_refs: refs.iter().map(|r| format!("<{r}>")).collect(),
            to: "me@example.com".into(),
        }
    }

    #[test]
    fn cards_round_trip_and_window() {
        let mut s = Store::in_memory().unwrap();
        let cards = vec![card(10, "Anna", "Hello", "a@x", &[], 100), card(11, "Luca", "Quote", "b@x", &[], 200)];
        s.save_cards("INBOX", Some(7), &cards, true).unwrap();
        let (v, got) = s.folder_cards("INBOX").unwrap();
        assert_eq!(v, Some(7));
        assert_eq!(got.len(), 2);
        assert_eq!(s.cards("INBOX", 10).unwrap()[0].uid, 11, "newest first");
        // UID 10 left the folder (the window is the whole folder); 12 arrived.
        s.save_cards("INBOX", Some(7), &[card(11, "Luca", "Quote", "b@x", &[], 200), card(12, "Sara", "New", "c@x", &[], 300)], true)
            .unwrap();
        let uids: Vec<u32> = s.cards("INBOX", 10).unwrap().iter().map(|c| c.uid).collect();
        assert_eq!(uids, vec![12, 11]);
        // A new UIDVALIDITY wipes the folder.
        s.save_cards("INBOX", Some(8), &[card(1, "Anna", "Again", "d@x", &[], 400)], false).unwrap();
        assert_eq!(s.cards("INBOX", 10).unwrap().len(), 1);
    }

    #[test]
    fn older_cards_outside_the_window_are_kept() {
        let mut s = Store::in_memory().unwrap();
        s.save_cards("INBOX", Some(1), &[card(5, "Old", "Old one", "o@x", &[], 10), card(20, "New", "New one", "n@x", &[], 20)], false)
            .unwrap();
        // Only the newest email is in the window now (a smaller limit).
        s.save_cards("INBOX", Some(1), &[card(20, "New", "New one", "n@x", &[], 20)], false).unwrap();
        assert_eq!(s.cards("INBOX", 10).unwrap().len(), 2);
    }

    #[test]
    fn bodies_are_shared_and_evicted() {
        let mut s = Store::in_memory().unwrap();
        s.save_cards("INBOX", Some(1), &[card(1, "Anna", "Report", "r@x", &[], 10)], false).unwrap();
        s.save_cards("Archive", Some(1), &[card(9, "Anna", "Report", "r@x", &[], 10)], false).unwrap();
        let raw = b"From: Anna <anna@example.com>\r\nSubject: Report\r\nMessage-ID: <r@x>\r\n\r\nThe quarterly numbers are ready.\r\n";
        assert!(s.raw("INBOX", 1).unwrap().is_none());
        s.put_raw("INBOX", 1, raw).unwrap();
        assert_eq!(s.raw("Archive", 9).unwrap().as_deref(), Some(&raw[..]), "same Message-ID, same content");
        assert!(s.missing_bodies(&["INBOX".into(), "Archive".into()], 10).unwrap().is_empty());
        assert_eq!(s.stats().unwrap().bodies, 1);
        s.evict(0).unwrap();
        assert!(s.raw("INBOX", 1).unwrap().is_none());
        assert!(s.missing_bodies(&["INBOX".into()], 10).unwrap().is_empty(), "not prefetched again");
        s.put_raw("INBOX", 1, raw).unwrap();
        assert!(s.raw("INBOX", 1).unwrap().is_some(), "kept again once opened");
    }

    #[test]
    fn search_finds_words_in_body_without_accents() {
        let mut s = Store::in_memory().unwrap();
        s.save_cards("INBOX", Some(1), &[card(1, "Anna Bianchi", "Riunione", "r@x", &[], 10), card(2, "Luca", "Pranzo", "p@x", &[], 20)], false)
            .unwrap();
        let raw = "From: Anna <anna@example.com>\r\nSubject: Riunione\r\nMessage-ID: <r@x>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCi vediamo lunedì per il preventivo.\r\n";
        s.put_raw("INBOX", 1, raw.as_bytes()).unwrap();
        fn hit(s: &Store, q: &str) -> Vec<u32> {
            s.search(q, 10).unwrap().iter().map(|e| e.card.uid).collect()
        }
        assert_eq!(hit(&s, "lunedi"), vec![1], "accents ignored");
        assert_eq!(hit(&s, "preven"), vec![1], "start of a word");
        assert_eq!(hit(&s, "anna riunione"), vec![1], "every word");
        assert_eq!(hit(&s, "pranzo"), vec![2]);
        assert!(hit(&s, "anna pranzo").is_empty());
        assert!(hit(&s, "\"").is_empty());
        // Re-saving the card keeps the indexed body text.
        s.save_cards("INBOX", Some(1), &[card(1, "Anna Bianchi", "Riunione", "r@x", &[], 10), card(2, "Luca", "Pranzo", "p@x", &[], 20)], false)
            .unwrap();
        assert_eq!(hit(&s, "preventivo"), vec![1]);
    }

    #[test]
    fn thread_follows_references_across_folders() {
        let mut s = Store::in_memory().unwrap();
        s.save_cards("INBOX", Some(1), &[card(1, "Anna", "Plan", "root@x", &[], 10), card(3, "Anna", "Re: Plan", "c@x", &["root@x", "b@x"], 30)], false)
            .unwrap();
        s.save_cards("Sent", Some(1), &[card(2, "Me", "Re: Plan", "b@x", &["root@x"], 20)], false).unwrap();
        s.save_cards("INBOX.Other", Some(1), &[card(4, "Zoe", "Unrelated", "z@x", &[], 40)], false).unwrap();
        let t = s.thread(Some("<c@x>"), &["<b@x>".into()]).unwrap();
        let got: Vec<(String, u32)> = t.iter().map(|e| (e.folder.clone(), e.card.uid)).collect();
        assert_eq!(got, vec![("INBOX".into(), 1), ("Sent".into(), 2), ("INBOX".into(), 3)]);
    }

    #[test]
    fn queue_keeps_order_and_errors() {
        let mut s = Store::in_memory().unwrap();
        let a = s.enqueue("move", "{}").unwrap();
        s.enqueue("seen", "{}").unwrap();
        s.queue_failed(a, "offline").unwrap();
        let q = s.queue().unwrap();
        assert_eq!(q.iter().map(|x| x.kind.as_str()).collect::<Vec<_>>(), vec!["move", "seen"]);
        assert_eq!(q[0].attempts, 1);
        s.dequeue(a).unwrap();
        assert_eq!(s.queue().unwrap().len(), 1);
    }

    #[test]
    fn flags_update_cards() {
        let mut s = Store::in_memory().unwrap();
        s.save_cards("INBOX", Some(1), &[card(1, "Anna", "Plan", "p@x", &[], 10)], false).unwrap();
        s.set_flags("INBOX", &[1], Some(true), Some(true)).unwrap();
        let c = &s.cards("INBOX", 1).unwrap()[0];
        assert!(c.seen && c.flagged);
        s.remove("INBOX", &[1]).unwrap();
        assert!(s.cards("INBOX", 1).unwrap().is_empty());
        assert!(s.search("plan", 10).unwrap().is_empty());
    }
}
