//! Account details (server, port, email) stored in `account.toml`.
//! The password is NOT here: it lives in the system keychain (see `secret`).
//!
//! Each account has its own configuration folder (account, board, settings):
//! the first one uses the main folder, the others `accounts/<address>` inside it.
//! One account is in use at a time and [`config_dir`] is its folder.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
    /// Login name, when it is not the address (iCloud with a custom domain, the
    /// work name of a Microsoft account).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// Signed in with the browser: the keychain holds a refresh token, not a password.
    #[serde(default)]
    pub oauth: bool,
}

/// The mail services with their own rules. Everything else is a plain IMAP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Other,
    Icloud,
    Gmail,
    Microsoft,
}

/// Who writes the copy of a sent email in the Sent folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SentCopy {
    /// The app.
    App,
    /// The server, always: another copy would be a duplicate.
    Server,
    /// The server, depending on the account: look first, then save if it is missing.
    Check,
}

impl Provider {
    /// Recognised from the IMAP server, so accounts saved earlier count too.
    pub fn of(server: &str) -> Provider {
        match server.trim().to_lowercase().as_str() {
            "imap.mail.me.com" => Provider::Icloud,
            "imap.gmail.com" | "imap.googlemail.com" => Provider::Gmail,
            "outlook.office365.com" | "imap-mail.outlook.com" => Provider::Microsoft,
            _ => Provider::Other,
        }
    }

    /// IMAP server, SMTP server and SMTP port.
    pub fn servers(self) -> Option<(&'static str, &'static str, u16)> {
        match self {
            Provider::Other => None,
            Provider::Icloud => Some(("imap.mail.me.com", "smtp.mail.me.com", 587)),
            Provider::Gmail => Some(("imap.gmail.com", "smtp.gmail.com", 465)),
            Provider::Microsoft => Some(("outlook.office365.com", "smtp.office365.com", 587)),
        }
    }

    pub fn sent_copy(self) -> SentCopy {
        match self {
            Provider::Gmail => SentCopy::Server,
            Provider::Microsoft | Provider::Icloud => SentCopy::Check,
            Provider::Other => SentCopy::App,
        }
    }

    /// What to do when the server refuses the login. These words end up in errors:
    /// no "connection" or "network", or the app would think it is offline.
    pub fn login_help(self, oauth: bool) -> &'static str {
        match (self, oauth) {
            (Provider::Icloud, _) => " iCloud needs an app-specific password, created at account.apple.com, not your Apple Account password. With a custom domain, the username is your iCloud address.",
            (Provider::Gmail, false) => " Gmail needs an app password, created at myaccount.google.com/apppasswords after turning on 2-Step Verification, not your Google password.",
            (Provider::Gmail, true) => " Your Google Workspace administrator may have turned off IMAP or this app.",
            (Provider::Microsoft, _) => " IMAP may be turned off: in Outlook.com under Settings → Mail → Forwarding and IMAP, or by the administrator of a work mailbox.",
            (Provider::Other, _) => "",
        }
    }
}

fn default_port() -> u16 {
    993
}

fn default_smtp_port() -> u16 {
    465
}

/// Name of this app for the system: configuration folder and keychain. It differs
/// from the stable KanbanMail, so that the two can run side by side without sharing
/// accounts, boards or local copies.
pub(crate) const APP_NAME: &str = "Pigeonhole";

/// Main configuration folder, e.g. `~/Library/Application Support/Pigeonhole` on macOS.
fn root_dir() -> Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("", "", APP_NAME)
        .context("cannot determine the configuration folder")?;
    Ok(dirs.config_dir().to_path_buf())
}

/// File in the main folder naming the account in use (absent for the first account).
const ACTIVE_FILE: &str = "active-account";

/// File in the main folder with the icon chosen for each account. It sits outside
/// the accounts so that the menu reads one file and logging in again keeps the choice.
const LOOKS_FILE: &str = "account-icons.toml";

/// How an account appears in the account menu; empty fields mean its initial and
/// the color that comes from its address.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Look {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// A damaged file only costs the icons, so it never stops the app.
fn read_looks(root: &Path) -> BTreeMap<String, Look> {
    std::fs::read_to_string(root.join(LOOKS_FILE)).ok().and_then(|text| toml::from_str(&text).ok()).unwrap_or_default()
}

fn write_look(root: &Path, email: &str, look: Look) -> Result<()> {
    let mut looks = read_looks(root);
    let key = email.to_lowercase();
    if look == Look::default() {
        looks.remove(&key);
    } else {
        looks.insert(key, look);
    }
    let path = root.join(LOOKS_FILE);
    std::fs::write(&path, toml::to_string_pretty(&looks)?).with_context(|| format!("writing {}", path.display()))
}

/// The chosen icons, by lowercase address.
pub fn looks() -> Result<BTreeMap<String, Look>> {
    Ok(read_looks(&root_dir()?))
}

/// Sets the icon of an account; an empty [`Look`] goes back to the initial.
pub fn set_look(email: &str, look: Look) -> Result<()> {
    write_look(&root_dir()?, email, look)
}

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
        let known = Provider::of(&server).servers();
        Account {
            server,
            port: 993,
            email,
            display_name: None,
            smtp_server: known.map(|(_, smtp, _)| smtp.to_string()),
            smtp_port: known.map_or(465, |(_, _, port)| port),
            username: None,
            oauth: false,
        }
    }

    pub fn provider(&self) -> Provider {
        Provider::of(&self.server)
    }

    /// The name to log in with on the IMAP server.
    pub fn imap_login(&self) -> &str {
        self.username.as_deref().filter(|u| !u.is_empty()).unwrap_or(&self.email)
    }

    /// The name to log in with on the SMTP server: iCloud wants a whole address
    /// there, also where IMAP takes only the part before the @.
    pub fn smtp_login(&self) -> &str {
        Some(self.imap_login()).filter(|u| u.contains('@')).unwrap_or(&self.email)
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
    fn account_icons_are_kept_by_address() {
        let root = std::env::temp_dir().join(format!("kanbanmail-looks-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let look = Look { icon: Some("🏠".into()), color: Some("#43a07a".into()) };
        write_look(&root, "Me@Example.com", look.clone()).unwrap();
        write_look(&root, "other@example.com", Look { icon: Some("AB".into()), color: None }).unwrap();
        assert_eq!(read_looks(&root).get("me@example.com"), Some(&look));
        write_look(&root, "ME@example.com", Look::default()).unwrap();
        let left = read_looks(&root);
        assert_eq!(left.keys().collect::<Vec<_>>(), ["other@example.com"]);
        std::fs::write(root.join(LOOKS_FILE), "not toml =").unwrap();
        assert!(read_looks(&root).is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn known_services_get_their_servers() {
        let icloud = Account::new("imap.mail.me.com".into(), "a@icloud.com".into());
        assert_eq!((icloud.smtp_host(), icloud.smtp_port), ("smtp.mail.me.com", 587));
        let other = Account::new("mail.example.com".into(), "a@example.com".into());
        assert_eq!((other.smtp_host(), other.smtp_port), ("mail.example.com", 465));
        assert_eq!(Provider::of(" IMAP.Gmail.com "), Provider::Gmail);
    }

    #[test]
    fn a_short_username_is_not_used_for_smtp() {
        let mut a = Account::new("imap.mail.me.com".into(), "me@mydomain.com".into());
        assert_eq!((a.imap_login(), a.smtp_login()), ("me@mydomain.com", "me@mydomain.com"));
        a.username = Some("me".into());
        assert_eq!((a.imap_login(), a.smtp_login()), ("me", "me@mydomain.com"));
        a.username = Some("me@icloud.com".into());
        assert_eq!((a.imap_login(), a.smtp_login()), ("me@icloud.com", "me@icloud.com"));
    }

    #[test]
    fn accounts_saved_earlier_still_load() {
        let a: Account = toml::from_str("server = \"imap.gmail.com\"\nemail = \"a@gmail.com\"\n").unwrap();
        assert!(!a.oauth && a.username.is_none());
        assert_eq!(a.provider(), Provider::Gmail);
    }

    #[test]
    fn login_help_does_not_look_like_being_offline() {
        for p in [Provider::Icloud, Provider::Gmail, Provider::Microsoft] {
            for oauth in [false, true] {
                let text = p.login_help(oauth).to_lowercase();
                assert!(!["connection", "network", "offline", "cannot reach"].iter().any(|k| text.contains(k)));
            }
        }
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
