//! Links between emails and the tasks they are about, kept in another tool
//! (Jira and the like) and known here only by their web address. One file per
//! account, beside its settings: the links are the user's own notes, not a
//! copy of the server, so they do not live in the local cache.

use crate::account::config_dir;
use crate::store::bare_id;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Task {
    /// Web address of the task, e.g. "https://acme.atlassian.net/browse/WEB-12".
    pub url: String,
    /// Short name shown on the emails: the task key, or what the user typed.
    #[serde(default)]
    pub name: String,
    /// Message-IDs (without angle brackets) of the linked emails. The replies
    /// to them count as linked too, so a conversation needs one link only.
    #[serde(default)]
    pub emails: Vec<String>,
}

const FILE: &str = "tasks.json";

/// The tasks of the account in use, most recently linked first.
pub fn load() -> Result<Vec<Task>> {
    load_from(&config_dir()?)
}

pub fn save(tasks: &[Task]) -> Result<()> {
    save_to(&config_dir()?, tasks)
}

fn load_from(dir: &Path) -> Result<Vec<Task>> {
    let path = dir.join(FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path)?;
    serde_json::from_str(&text).with_context(|| format!("invalid {}", path.display()))
}

fn save_to(dir: &Path, tasks: &[Task]) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(FILE), serde_json::to_string_pretty(tasks)?)?;
    Ok(())
}

/// A Jira-style key ("WEB-12") in a piece of an address, if it is one.
fn issue_key(text: &str) -> Option<&str> {
    let (project, number) = text.split_once('-')?;
    let mut letters = project.chars();
    let ok = letters.next().is_some_and(|c| c.is_ascii_uppercase())
        && project.len() >= 2
        && letters.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit());
    ok.then_some(text)
}

/// The task key named by an address: ".../browse/WEB-12" or "...?selectedIssue=WEB-12".
fn key_in(url: &url::Url) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == "selectedIssue")
        .and_then(|(_, v)| issue_key(&v).map(str::to_string))
        .or_else(|| {
            url.path_segments()?
                .rev()
                .find_map(|s| issue_key(s).map(str::to_string))
        })
}

/// What tells two addresses of the same task apart from two tasks: the site
/// and the task key when there is one, otherwise the address itself.
fn identity(address: &str) -> String {
    match url::Url::parse(address.trim()) {
        Ok(u) => match key_in(&u) {
            Some(key) => format!("{}/{key}", u.host_str().unwrap_or_default()),
            None => {
                let mut plain = u.clone();
                plain.set_fragment(None);
                plain.as_str().trim_end_matches('/').to_string()
            }
        },
        Err(_) => address.trim().to_string(),
    }
}

/// The name a task gets from its address: its key, else the last piece of the
/// path, else the site.
pub fn name_from_url(address: &str) -> String {
    let Ok(u) = url::Url::parse(address.trim()) else {
        return address.trim().to_string();
    };
    key_in(&u)
        .or_else(|| u.path_segments()?.rev().find(|s| !s.is_empty()).map(str::to_string))
        .unwrap_or_else(|| u.host_str().unwrap_or_default().to_string())
}

fn position(tasks: &[Task], address: &str) -> Option<usize> {
    let id = identity(address);
    tasks.iter().position(|t| identity(&t.url) == id)
}

/// Links emails to the task at `address` (created if new) and moves it first.
pub fn link(tasks: &mut Vec<Task>, address: &str, ids: &[String]) -> Result<()> {
    let address = address.trim();
    let parsed = url::Url::parse(address)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some());
    anyhow::ensure!(
        parsed.is_some(),
        "this is not a web link (it should start with https://)"
    );
    let mut task = match position(tasks, address) {
        Some(i) => tasks.remove(i),
        None => Task {
            url: address.to_string(),
            name: name_from_url(address),
            emails: Vec::new(),
        },
    };
    for id in ids.iter().map(|id| bare_id(id)).filter(|id| !id.is_empty()) {
        if !task.emails.iter().any(|e| e.eq_ignore_ascii_case(&id)) {
            task.emails.push(id);
        }
    }
    tasks.insert(0, task);
    Ok(())
}

/// Takes emails off a task; a task left without emails goes away.
pub fn unlink(tasks: &mut Vec<Task>, address: &str, ids: &[String]) {
    let Some(i) = position(tasks, address) else { return };
    let gone: Vec<String> = ids.iter().map(|id| bare_id(id)).collect();
    tasks[i]
        .emails
        .retain(|e| !gone.iter().any(|g| g.eq_ignore_ascii_case(e)));
    if tasks[i].emails.is_empty() {
        tasks.remove(i);
    }
}

pub fn remove(tasks: &mut Vec<Task>, address: &str) {
    if let Some(i) = position(tasks, address) {
        tasks.remove(i);
    }
}

/// Gives a task the name typed by the user; an empty one brings back its key.
pub fn rename(tasks: &mut [Task], address: &str, name: &str) {
    if let Some(i) = position(tasks, address) {
        let name = name.trim();
        tasks[i].name = if name.is_empty() {
            name_from_url(&tasks[i].url)
        } else {
            name.to_string()
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JIRA: &str = "https://acme.atlassian.net/browse/WEB-12";

    #[test]
    fn names_come_from_the_address() {
        assert_eq!(name_from_url(JIRA), "WEB-12");
        assert_eq!(
            name_from_url("https://acme.atlassian.net/jira/software/projects/WEB/boards/3?selectedIssue=WEB-40"),
            "WEB-40"
        );
        assert_eq!(name_from_url("https://tracker.example/tickets/881/"), "881");
        assert_eq!(name_from_url("https://tracker.example"), "tracker.example");
    }

    #[test]
    fn one_task_however_its_address_is_written() {
        let mut tasks = Vec::new();
        link(&mut tasks, JIRA, &["<a@x>".into()]).unwrap();
        link(
            &mut tasks,
            "https://acme.atlassian.net/browse/WEB-12?focusedCommentId=7",
            &["<b@x>".into(), "A@x".into()],
        )
        .unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].emails, ["a@x", "b@x"]);
        // The same key on another site is another task.
        link(&mut tasks, "https://other.example/browse/WEB-12", &["c@x".into()]).unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].url, "https://other.example/browse/WEB-12");
    }

    #[test]
    fn only_web_links_are_accepted() {
        let mut tasks = Vec::new();
        assert!(link(&mut tasks, "WEB-12", &["a@x".into()]).is_err());
        assert!(link(&mut tasks, "file:///etc/passwd", &["a@x".into()]).is_err());
        assert!(tasks.is_empty());
    }

    #[test]
    fn a_task_without_emails_goes_away() {
        let mut tasks = Vec::new();
        link(&mut tasks, JIRA, &["a@x".into(), "b@x".into()]).unwrap();
        rename(&mut tasks, JIRA, "  Login page ");
        assert_eq!(tasks[0].name, "Login page");
        rename(&mut tasks, JIRA, "");
        assert_eq!(tasks[0].name, "WEB-12");
        unlink(&mut tasks, JIRA, &["<a@x>".into()]);
        assert_eq!(tasks[0].emails, ["b@x"]);
        unlink(&mut tasks, JIRA, &["b@x".into()]);
        assert!(tasks.is_empty());
    }

    #[test]
    fn saved_and_read_back() {
        let dir = std::env::temp_dir().join(format!("pigeonhole-tasks-{}", std::process::id()));
        let mut tasks = Vec::new();
        link(&mut tasks, JIRA, &["a@x".into()]).unwrap();
        save_to(&dir, &tasks).unwrap();
        assert_eq!(load_from(&dir).unwrap(), tasks);
        std::fs::remove_dir_all(&dir).ok();
    }
}
