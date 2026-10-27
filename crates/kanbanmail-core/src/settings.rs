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
}

fn default_mark_read() -> i32 {
    3
}

impl Default for Settings {
    fn default() -> Self {
        Settings { mark_read_after_seconds: default_mark_read(), signature: String::new(), use_system_contacts: false }
    }
}

impl Settings {
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
