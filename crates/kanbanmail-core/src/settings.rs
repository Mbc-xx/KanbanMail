//! App preferences in `settings.toml` (written by the app itself).

use crate::account::{all_dirs, config_dir};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Seconds of reading after which an email is marked as read.
    /// 0 = immediately, -1 = never (manual only).
    #[serde(default = "default_mark_read")]
    pub mark_read_after_seconds: i32,
    /// Signature appended to new emails and replies.
    #[serde(default)]
    pub signature: String,
    /// Addresses put in Bcc of every new email and reply (comma-separated).
    #[serde(default)]
    pub default_bcc: String,
    /// Suggest addresses from the operating system address book.
    #[serde(default)]
    pub use_system_contacts: bool,
    /// Rich version of the signature (HTML, images as `data:` URIs). Empty = plain text only.
    #[serde(default)]
    pub signature_html: String,
    /// Load remote images in every email without asking.
    #[serde(default)]
    pub load_remote_images: bool,
    /// "Important only": senders always shown (addresses or `@domain`).
    #[serde(default)]
    pub important_allow: Vec<String>,
    /// "Important only": senders never shown (addresses or `@domain`).
    #[serde(default)]
    pub important_block: Vec<String>,
    /// "Important only": people of your own email domain count as known.
    #[serde(default = "default_true")]
    pub important_same_domain: bool,
    /// Show one card per conversation in the board and folder lists.
    #[serde(default)]
    pub group_threads: bool,
    /// Sidebar folders: order (as listed), visibility and color. Folders not
    /// listed keep their default place after these.
    #[serde(default)]
    pub folders: Vec<FolderPref>,
    /// Automatic rules applied to new Inbox emails, in order (the first match wins).
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// Desktop notifications for new Inbox emails: "off", "important" or "all".
    #[serde(default = "default_notify")]
    pub notify: String,
    /// "system", "light" or "dark".
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Interface size in percent (90, 100, 110, 125).
    #[serde(default = "default_zoom")]
    pub zoom: u32,
    /// How long the "Undo" button stays after a move, in seconds (0 = no undo).
    #[serde(default = "default_undo")]
    pub undo_seconds: u32,
    /// How long a sent email waits, with an "Undo" button, before it really
    /// leaves (0 = sent at once).
    #[serde(default = "default_undo_send")]
    pub undo_send_seconds: u32,
    /// Lines of preview text under the subject on board cards (0, 1 or 2).
    #[serde(default = "default_preview_board")]
    pub preview_board: u32,
    /// Lines of preview text under the sender and subject in folder lists (0, 1 or 2).
    #[serde(default = "default_preview_list")]
    pub preview_list: u32,
    /// The board column of emails waiting for an answer: "" = the column named
    /// "Waiting", "none" = no such column.
    #[serde(default)]
    pub waiting_folder: String,
    /// Emails in the waiting column are flagged after this many days (0 = never).
    #[serde(default = "default_waiting_days")]
    pub waiting_days: u32,
    /// Most space the local copy of emails may take, in MB.
    #[serde(default = "default_cache_mb")]
    pub cache_max_mb: u32,
    /// Download recent emails in the background so they open instantly.
    #[serde(default = "default_true")]
    pub prefetch: bool,
    /// The actions of an open email as icons only (the name in the tooltip).
    #[serde(default = "default_true")]
    pub compact_actions: bool,
    /// Archive, delete, spam and move on a conversation of several emails ask
    /// whether to act on the open email only or on the whole conversation.
    #[serde(default = "default_true")]
    pub ask_conversation: bool,
    /// Other mailboxes used only to send from (chosen in the composer). Their
    /// passwords are in the keychain, under their own address.
    #[serde(default)]
    pub senders: Vec<Sender>,
}

/// A send-only mailbox: its own address, name, SMTP server and signature.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sender {
    pub email: String,
    #[serde(default)]
    pub display_name: String,
    pub smtp_server: String,
    #[serde(default = "default_smtp_port")]
    pub smtp_port: u16,
    /// Signature text; empty = the main one.
    #[serde(default)]
    pub signature: String,
    /// Rich version of the signature, like [`Settings::signature_html`].
    #[serde(default)]
    pub signature_html: String,
}

/// The rich signature to send, when it has formatting.
fn rich_signature(text: &str, html: &str) -> Option<crate::smtp::HtmlSignature> {
    (!html.trim().is_empty()).then(|| crate::smtp::HtmlSignature { text: text.to_string(), html: html.to_string() })
}

fn default_smtp_port() -> u16 {
    465
}

impl Sender {
    /// The sender as an account for building and sending emails (SMTP only).
    pub fn account(&self) -> crate::account::Account {
        let name = self.display_name.trim();
        crate::account::Account {
            server: self.smtp_server.clone(),
            port: 993,
            email: self.email.clone(),
            display_name: (!name.is_empty()).then(|| name.to_string()),
            smtp_server: Some(self.smtp_server.clone()),
            smtp_port: self.smtp_port,
        }
    }

    pub fn html_signature(&self) -> Option<crate::smtp::HtmlSignature> {
        rich_signature(&self.signature, &self.signature_html)
    }
}

fn default_cache_mb() -> u32 {
    1024
}

fn default_preview_board() -> u32 {
    2
}

fn default_preview_list() -> u32 {
    1
}

fn default_waiting_days() -> u32 {
    3
}

fn default_undo_send() -> u32 {
    10
}

fn default_undo() -> u32 {
    8
}

fn default_notify() -> String {
    "important".into()
}

fn default_theme() -> String {
    "system".into()
}

fn default_zoom() -> u32 {
    100
}

/// "When <field> contains <contains>, move the email to <folder>".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    /// "from", "to" or "subject".
    pub field: String,
    pub contains: String,
    pub folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderPref {
    /// Full folder name on the server, e.g. "INBOX.Clients".
    pub name: String,
    #[serde(default)]
    pub hidden: bool,
    /// CSS color like "#4f8fd6", empty for none.
    #[serde(default)]
    pub color: String,
}

fn default_true() -> bool {
    true
}

/// Lowercased, trimmed, without duplicates or empty entries.
pub fn normalize_rules(rules: &[String]) -> Vec<String> {
    let mut out: Vec<String> = rules.iter().map(|r| r.trim().to_lowercase()).filter(|r| !r.is_empty()).collect();
    out.sort();
    out.dedup();
    out
}

fn default_mark_read() -> i32 {
    3
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            mark_read_after_seconds: default_mark_read(),
            signature: String::new(),
            default_bcc: String::new(),
            use_system_contacts: false,
            signature_html: String::new(),
            load_remote_images: false,
            important_allow: Vec::new(),
            important_block: Vec::new(),
            important_same_domain: true,
            group_threads: false,
            folders: Vec::new(),
            rules: Vec::new(),
            notify: default_notify(),
            theme: default_theme(),
            zoom: default_zoom(),
            undo_seconds: default_undo(),
            undo_send_seconds: default_undo_send(),
            preview_board: default_preview_board(),
            preview_list: default_preview_list(),
            waiting_folder: String::new(),
            waiting_days: default_waiting_days(),
            cache_max_mb: default_cache_mb(),
            prefetch: true,
            compact_actions: true,
            ask_conversation: true,
            senders: Vec::new(),
        }
    }
}

impl Settings {
    /// The extra sender with this address (`None` for the main account or an unknown one).
    pub fn sender(&self, email: Option<&str>) -> Option<&Sender> {
        let email = email?.trim();
        self.senders.iter().find(|s| s.email.eq_ignore_ascii_case(email))
    }

    /// Senders cleaned for saving: trimmed, with an address and a server, without
    /// duplicates or the main account itself.
    pub fn normalize_senders(senders: Vec<Sender>, main_email: &str) -> Vec<Sender> {
        let mut out: Vec<Sender> = Vec::new();
        for s in senders {
            let s = Sender {
                email: s.email.trim().to_string(),
                display_name: s.display_name.trim().to_string(),
                smtp_server: s.smtp_server.trim().to_string(),
                smtp_port: s.smtp_port,
                signature: s.signature.trim_end().to_string(),
                signature_html: crate::message::sanitize_signature(&s.signature_html),
            };
            let dup = s.email.eq_ignore_ascii_case(main_email) || out.iter().any(|o| o.email.eq_ignore_ascii_case(&s.email));
            if s.email.contains('@') && !s.smtp_server.is_empty() && !dup {
                out.push(s);
            }
        }
        out
    }

    pub fn html_signature(&self) -> Option<crate::smtp::HtmlSignature> {
        rich_signature(&self.signature, &self.signature_html)
    }

    pub fn load() -> Result<Settings> {
        Settings::load_from(&config_dir()?)
    }

    pub fn load_from(dir: &Path) -> Result<Settings> {
        let path = dir.join("settings.toml");
        if !path.exists() {
            return Ok(Settings::default());
        }
        let text = std::fs::read_to_string(&path)?;
        toml::from_str(&text).with_context(|| format!("invalid {}", path.display()))
    }

    pub fn save(&self) -> Result<()> {
        self.save_to(&config_dir()?)
    }

    fn save_to(&self, dir: &Path) -> Result<()> {
        std::fs::create_dir_all(dir)?;
        std::fs::write(dir.join("settings.toml"), toml::to_string_pretty(self)?)?;
        Ok(())
    }

    /// These settings with the preferences of the app taken from `from`: how it
    /// looks and behaves is the same for every account, while signatures,
    /// senders, rules, folders and the Waiting column belong to each one.
    pub fn with_shared_from(self, from: &Settings) -> Settings {
        Settings {
            mark_read_after_seconds: from.mark_read_after_seconds,
            use_system_contacts: from.use_system_contacts,
            load_remote_images: from.load_remote_images,
            group_threads: from.group_threads,
            notify: from.notify.clone(),
            theme: from.theme.clone(),
            zoom: from.zoom,
            undo_seconds: from.undo_seconds,
            undo_send_seconds: from.undo_send_seconds,
            preview_board: from.preview_board,
            preview_list: from.preview_list,
            cache_max_mb: from.cache_max_mb,
            prefetch: from.prefetch,
            compact_actions: from.compact_actions,
            ask_conversation: from.ask_conversation,
            ..self
        }
    }

    /// Passes the shared preferences on to the other accounts.
    pub fn share_with_other_accounts(&self) -> Result<()> {
        let here = config_dir()?;
        for dir in all_dirs()?.into_iter().filter(|d| *d != here) {
            Settings::load_from(&dir)?.with_shared_from(self).save_to(&dir)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sender(email: &str, server: &str) -> Sender {
        Sender { email: email.into(), display_name: " Desk ".into(), smtp_server: server.into(), smtp_port: 587, signature: String::new(), signature_html: String::new() }
    }

    #[test]
    fn a_new_account_shares_preferences_but_not_its_own_details() {
        let from = Settings { theme: "dark".into(), zoom: 120, signature: "Mine".into(), waiting_folder: "Later".into(), ..Settings::default() };
        let other = Settings { signature: "Theirs".into(), ..Settings::default() }.with_shared_from(&from);
        assert_eq!((other.theme.as_str(), other.zoom), ("dark", 120));
        assert_eq!(other.signature, "Theirs");
        assert_eq!(other.waiting_folder, "");
    }

    #[test]
    fn senders_are_cleaned_and_found() {
        let senders = Settings::normalize_senders(
            vec![
                sender(" desk@example.org ", " smtp.example.org "),
                sender("DESK@example.org", "smtp.example.org"),
                sender("me@example.com", "smtp.example.com"),
                sender("no-server@example.org", ""),
                sender("not-an-address", "smtp.example.org"),
            ],
            "Me@Example.com",
        );
        assert_eq!(senders.len(), 1);
        let settings = Settings { senders, ..Settings::default() };
        let found = settings.sender(Some("Desk@Example.org")).unwrap();
        assert_eq!(found.email, "desk@example.org");
        let account = found.account();
        assert_eq!((account.smtp_host(), account.smtp_port), ("smtp.example.org", 587));
        assert_eq!(account.display_name.as_deref(), Some("Desk"));
        assert!(settings.sender(Some("me@example.com")).is_none());
        assert!(settings.sender(None).is_none());
        // Saved and read back with the other settings.
        let text = toml::to_string_pretty(&settings).unwrap();
        assert_eq!(toml::from_str::<Settings>(&text).unwrap().senders.len(), 1);
    }
}
