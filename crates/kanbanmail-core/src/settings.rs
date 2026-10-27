//! Preferenze dell'app in `settings.toml` (scritto dall'app stessa).

use crate::account::config_dir;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Dopo quanti secondi di lettura una mail viene segnata come letta.
    /// 0 = subito, -1 = mai (solo a mano).
    #[serde(default = "default_mark_read")]
    pub mark_read_after_seconds: i32,
    /// Firma aggiunta in fondo alle mail nuove e alle risposte.
    #[serde(default)]
    pub signature: String,
    /// Suggerire gli indirizzi dalla rubrica del sistema operativo.
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
        toml::from_str(&text).with_context(|| format!("{} non valido", path.display()))
    }

    pub fn save(&self) -> Result<()> {
        let dir = config_dir()?;
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("settings.toml"), toml::to_string_pretty(self)?)?;
        Ok(())
    }
}
