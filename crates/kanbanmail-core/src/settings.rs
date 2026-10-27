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
        Settings { mark_read_after_seconds: default_mark_read(), signature: String::new(), use_system_contacts: false, signature_html: String::new(),
            load_remote_images: false,
            important_allow: Vec::new(),
            important_block: Vec::new(),
            important_same_domain: true,
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
