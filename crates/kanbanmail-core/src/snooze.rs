//! Emails put aside until a chosen time ("snoozed"): they wait in a folder
//! of their own and go back where they were when the time comes. One file
//! per account, beside its settings; the app brings them back while it runs.

use crate::account::config_dir;
use crate::store::bare_id;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snoozed {
    /// Message-ID of the email (as it is in the email, brackets included).
    pub message_id: String,
    /// The folder it waits in.
    pub folder: String,
    /// Where it goes back to.
    pub back: String,
    /// When it goes back, in seconds since 1970.
    pub until: i64,
}

const FILE: &str = "snoozed.json";

pub fn load() -> Result<Vec<Snoozed>> {
    load_from(&config_dir()?)
}

pub fn save(list: &[Snoozed]) -> Result<()> {
    save_to(&config_dir()?, list)
}

fn load_from(dir: &Path) -> Result<Vec<Snoozed>> {
    let path = dir.join(FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path)?;
    serde_json::from_str(&text).with_context(|| format!("invalid {}", path.display()))
}

fn save_to(dir: &Path, list: &[Snoozed]) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(FILE), serde_json::to_string_pretty(list)?)?;
    Ok(())
}

/// Adds emails (one snoozed again replaces its old entry), soonest first.
pub fn add(list: &mut Vec<Snoozed>, items: Vec<Snoozed>) {
    for item in items.into_iter().filter(|i| !bare_id(&i.message_id).is_empty()) {
        let id = bare_id(&item.message_id);
        list.retain(|x| bare_id(&x.message_id) != id);
        list.push(item);
    }
    list.sort_by_key(|x| x.until);
}

pub fn remove(list: &mut Vec<Snoozed>, ids: &[String]) {
    let gone: Vec<String> = ids.iter().map(|i| bare_id(i)).collect();
    list.retain(|x| !gone.contains(&bare_id(&x.message_id)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, until: i64) -> Snoozed {
        Snoozed {
            message_id: id.into(),
            folder: "Snoozed".into(),
            back: "INBOX".into(),
            until,
        }
    }

    #[test]
    fn snoozing_again_replaces_and_the_soonest_comes_first() {
        let mut list = Vec::new();
        add(&mut list, vec![item("<a@x>", 300), item("<b@x>", 100)]);
        add(&mut list, vec![item("<A@X>", 50), item("", 10)]);
        assert_eq!(
            list.iter()
                .map(|x| (x.message_id.as_str(), x.until))
                .collect::<Vec<_>>(),
            [("<A@X>", 50), ("<b@x>", 100)]
        );
        remove(&mut list, &["b@x".into()]);
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn saved_and_read_back() {
        let dir = std::env::temp_dir().join(format!("pigeonhole-snooze-{}", std::process::id()));
        let list = vec![item("<a@x>", 1)];
        save_to(&dir, &list).unwrap();
        assert_eq!(load_from(&dir).unwrap(), list);
        std::fs::remove_dir_all(&dir).ok();
    }
}
