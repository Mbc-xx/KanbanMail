//! Password in the operating system keychain (Keychain on macOS,
//! Credential Manager on Windows, Secret Service on Linux).

use anyhow::{Context, Result};

const SERVICE: &str = "KanbanMail";

fn entry(email: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, email).context("keychain access")
}

pub fn get_password(email: &str) -> Result<Option<String>> {
    match entry(email)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => migrate_old_password(email),
        Err(e) => Err(e).context("reading the password from the keychain"),
    }
}

/// Recovers the password saved when the app was still called MailMau
/// and moves it under the new name.
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
        .context("saving the password to the keychain")
}

pub fn delete_password(email: &str) -> Result<()> {
    match entry(email)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e).context("deleting the password from the keychain"),
    }
}
