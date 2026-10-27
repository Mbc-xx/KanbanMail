//! App preferences in `settings.toml` (written by the app itself).

use crate::account::config_dir;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

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
        }
    }
}

impl Settings {
    pub fn html_signature(&self) -> Option<crate::smtp::HtmlSignature> {
        (!self.signature_html.trim().is_empty()).then(|| crate::smtp::HtmlSignature {
            text: self.signature.clone(),
            html: self.signature_html.clone(),
        })
    }

    pub fn load() -> Result<Settings> {
        let path = config_dir()?.join("settings.toml");
        if !path.exists() {
            return Ok(Settings::default());
        }
        let text = std::fs::read_to_string(&path)?;
        toml::from_str(&text).with_context(|| format!("invalid {}", path.display()))
    }

    pub fn save(&self) -> Result<()> {
        let dir = config_dir()?;
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("settings.toml"), toml::to_string_pretty(self)?)?;
        Ok(())
    }
}
