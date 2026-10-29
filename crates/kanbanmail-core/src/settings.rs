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
