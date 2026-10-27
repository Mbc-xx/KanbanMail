//! Password nel portachiavi del sistema operativo (Portachiavi su macOS,
//! Credential Manager su Windows, Secret Service su Linux).

use anyhow::{Context, Result};

const SERVICE: &str = "KanbanMail";

fn entry(email: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, email).context("accesso al portachiavi")
}

pub fn get_password(email: &str) -> Result<Option<String>> {
    match entry(email)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => migrate_old_password(email),
        Err(e) => Err(e).context("lettura della password dal portachiavi"),
    }
}

/// Recupera la password salvata quando l'app si chiamava ancora MailMau
/// e la sposta sotto il nuovo nome.
fn migrate_old_password(email: &str) -> Result<Option<String>> {
    let Ok(old) = keyring::Entry::new(crate::account::OLD_APP_NAME, email) else {
        return Ok(None);
    };
    let Ok(password) = old.get_password() else {
        return Ok(None);
    };
    set_password(email, &password)?;
    old.delete_credential().ok();
    Ok(Some(password))
}

pub fn set_password(email: &str, password: &str) -> Result<()> {
    entry(email)?
        .set_password(password)
        .context("salvataggio della password nel portachiavi")
}

pub fn delete_password(email: &str) -> Result<()> {
    match entry(email)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e).context("cancellazione della password dal portachiavi"),
    }
}
