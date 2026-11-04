//! Account details (server, port, email) stored in `account.toml`.
//! The password is NOT here: it lives in the system keychain (see `secret`).
//!
//! Each account has its own configuration folder (account, board, settings):
//! the first one uses the main folder, the others `accounts/<address>` inside it.
//! One account is in use at a time and [`config_dir`] is its folder.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub server: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub email: String,
    /// Name shown as sender on outgoing emails (optional).
    #[serde(default)]
    pub display_name: Option<String>,
    /// SMTP server for sending; defaults to the IMAP server.
    #[serde(default)]
    pub smtp_server: Option<String>,
    /// 465 = SSL/TLS diretto, 587 = STARTTLS.
    #[serde(default = "default_smtp_port")]
    pub smtp_port: u16,
}

fn default_port() -> u16 {
    993
}

fn default_smtp_port() -> u16 {
    465
}

/// Main configuration folder, e.g. `~/Library/Application Support/KanbanMail` on macOS.
fn root_dir() -> Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("", "", "KanbanMail")
        .context("cannot determine the configuration folder")?;
    let dir = dirs.config_dir().to_path_buf();
    // The app used to be called MailMau: on first run, move the old files over.
    if !dir.exists() {
        if let Some(old) = directories::ProjectDirs::from("", "", OLD_APP_NAME) {
            if old.config_dir().exists() {
                std::fs::rename(old.config_dir(), &dir).ok();
            }
        }
    }
    Ok(dir)
}

/// Previous app name, used only to recover saved data.
pub(crate) const OLD_APP_NAME: &str = concat!("Mail", "Mau");

/// File in the main folder naming the account in use (absent for the first account).
const ACTIVE_FILE: &str = "active-account";

/// An email address as a file name.
pub(crate) fn safe_name(email: &str) -> String {
    email.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '@' || c == '-' { c } else { '_' }).collect()
}

fn extra_dir(root: &Path, email: &str) -> PathBuf {
    root.join("accounts").join(safe_name(email))
}

fn read_account(dir: &Path) -> Result<Option<Account>> {
    let path = dir.join("account.toml");
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    Ok(Some(toml::from_str(&text).with_context(|| format!("invalid {}", path.display()))?))
}

/// The folders holding an account: the main one first, then the others by name.
fn dirs_in(root: &Path) -> Vec<PathBuf> {
    let mut extra: Vec<PathBuf> = std::fs::read_dir(root.join("accounts"))
        .map(|list| list.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    extra.sort();
    std::iter::once(root.to_path_buf()).chain(extra).filter(|d| d.join("account.toml").exists()).collect()
}

/// The extra account to use at startup (None: the one in the main folder).
fn saved_active(root: &Path) -> Option<String> {
    let named = std::fs::read_to_string(root.join(ACTIVE_FILE)).ok().map(|s| s.trim().to_string());
    if let Some(email) = named.filter(|e| !e.is_empty() && extra_dir(root, e).join("account.toml").exists()) {
        return Some(email);
    }
    // The first account was disconnected while others remain.
    let first = dirs_in(root).into_iter().next()?;
    if first == root {
        return None;
    }
    read_account(&first).ok().flatten().map(|a| a.email)
}

fn active() -> &'static RwLock<Option<String>> {
    static ACTIVE: OnceLock<RwLock<Option<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| RwLock::new(root_dir().ok().and_then(|root| saved_active(&root))))
}

fn set_active(root: &Path, email: Option<String>) -> Result<()> {
    let path = root.join(ACTIVE_FILE);
    match &email {
        Some(e) => std::fs::write(&path, e).with_context(|| format!("writing {}", path.display()))?,
        None => {
            std::fs::remove_file(&path).ok();
        }
    }
    *active().write().unwrap() = email;
    Ok(())
}

/// Configuration folder of the account in use.
pub fn config_dir() -> Result<PathBuf> {
    let root = root_dir()?;
    Ok(match active().read().unwrap().as_deref() {
        Some(email) => extra_dir(&root, email),
        None => root,
    })
}

/// The configuration folders of every account.
pub fn all_dirs() -> Result<Vec<PathBuf>> {
    Ok(dirs_in(&root_dir()?))
}

/// Every account, the first one first.
pub fn list() -> Result<Vec<Account>> {
    let mut accounts = Vec::new();
    for dir in all_dirs()? {
        accounts.extend(read_account(&dir)?);
    }
    Ok(accounts)
}

/// Is the account in use one of those added after the first?
pub fn is_extra() -> bool {
    active().read().unwrap().is_some()
}

/// Makes `email` the account in use.
pub fn switch_to(email: &str) -> Result<()> {
    let root = root_dir()?;
    let first = read_account(&root)?.is_some_and(|a| a.email.eq_ignore_ascii_case(email));
    if !first {
        anyhow::ensure!(extra_dir(&root, email).join("account.toml").exists(), "unknown account: {email}");
    }
    set_active(&root, (!first).then(|| email.to_string()))
}

/// Creates the folder of a new account and makes it the one in use:
/// [`Account::save`] then writes there.
pub fn begin_new(email: &str) -> Result<()> {
    anyhow::ensure!(email.contains('@'), "invalid email address: {email}");
    let root = root_dir()?;
    std::fs::create_dir_all(extra_dir(&root, email))?;
    set_active(&root, Some(email.to_string()))
}

/// Deletes the configuration of the account in use and moves to the next one, if any.
/// The first account leaves its board and settings for whoever connects next.
pub fn remove_active() -> Result<()> {
    let root = root_dir()?;
    match active().read().unwrap().as_deref() {
        Some(email) => std::fs::remove_dir_all(extra_dir(&root, email))?,
        None => std::fs::remove_file(root.join("account.toml"))?,
    }
    set_active(&root, None)?;
    let next = saved_active(&root);
    set_active(&root, next)
}

fn account_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("account.toml"))
}

impl Account {
    pub fn new(server: String, email: String) -> Account {
        Account { server, port: 993, email, display_name: None, smtp_server: None, smtp_port: 465 }
    }

    pub fn smtp_host(&self) -> &str {
        self.smtp_server.as_deref().filter(|s| !s.is_empty()).unwrap_or(&self.server)
    }

    pub fn load() -> Result<Option<Account>> {
        read_account(&config_dir()?)
    }

    pub fn save(&self) -> Result<()> {
        let path = account_path()?;
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, toml::to_string_pretty(self)?)
            .with_context(|| format!("writing {}", path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_account(dir: &Path, email: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("account.toml"), format!("server = \"mail.example.com\"\nemail = \"{email}\"\n")).unwrap();
    }

    #[test]
    fn accounts_are_found_and_the_right_one_starts() {
        let root = std::env::temp_dir().join(format!("kanbanmail-accounts-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();
        assert!(dirs_in(&root).is_empty());
        assert_eq!(saved_active(&root), None);

        // Only extra accounts left: the first of them starts.
        write_account(&extra_dir(&root, "b@example.com"), "b@example.com");
        write_account(&extra_dir(&root, "a@example.com"), "a@example.com");
        assert_eq!(saved_active(&root).as_deref(), Some("a@example.com"));

        // The main account comes first and is the default.
        write_account(&root, "main@example.com");
        assert_eq!(dirs_in(&root)[0], root);
        assert_eq!(dirs_in(&root).len(), 3);
        assert_eq!(saved_active(&root), None);

        // The saved choice wins, unless that account is gone.
        std::fs::write(root.join(ACTIVE_FILE), "b@example.com\n").unwrap();
        assert_eq!(saved_active(&root).as_deref(), Some("b@example.com"));
        std::fs::write(root.join(ACTIVE_FILE), "gone@example.com").unwrap();
        assert_eq!(saved_active(&root), None);

        // A folder without an account does not count.
        std::fs::create_dir_all(root.join("accounts").join("empty")).unwrap();
        assert_eq!(dirs_in(&root).len(), 3);
        std::fs::remove_dir_all(&root).ok();
    }
}
