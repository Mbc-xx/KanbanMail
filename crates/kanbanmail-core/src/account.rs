//! Dati dell'account (server, porta, email) salvati in `account.toml`.
//! La password NON sta qui: vive nel portachiavi del sistema (vedi `secret`).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub server: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub email: String,
    /// Nome mostrato come mittente nelle mail inviate (facoltativo).
    #[serde(default)]
    pub display_name: Option<String>,
    /// Server SMTP per l'invio; se assente si usa lo stesso server IMAP.
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

/// Cartella di configurazione dell'app, es. `~/Library/Application Support/KanbanMail` su macOS.
pub fn config_dir() -> Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("", "", "KanbanMail")
        .context("impossibile determinare la cartella di configurazione")?;
    let dir = dirs.config_dir().to_path_buf();
    // L'app si chiamava MailMau: alla prima esecuzione spostiamo i vecchi file.
    if !dir.exists() {
        if let Some(old) = directories::ProjectDirs::from("", "", OLD_APP_NAME) {
            if old.config_dir().exists() {
                std::fs::rename(old.config_dir(), &dir).ok();
            }
        }
    }
    Ok(dir)
}

/// Nome precedente dell'app, usato solo per recuperare i dati salvati.
pub(crate) const OLD_APP_NAME: &str = concat!("Mail", "Mau");

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
        let path = account_path()?;
        if !path.exists() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("lettura di {}", path.display()))?;
        Ok(Some(toml::from_str(&text).context("account.toml non valido")?))
    }

    pub fn save(&self) -> Result<()> {
        let path = account_path()?;
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, toml::to_string_pretty(self)?)
            .with_context(|| format!("scrittura di {}", path.display()))?;
        Ok(())
    }
}
