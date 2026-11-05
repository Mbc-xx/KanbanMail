//! Password in the operating system keychain (Keychain on macOS,
//! Credential Manager on Windows, Secret Service on Linux).

use anyhow::{Context, Result};

fn entry(email: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(crate::account::APP_NAME, email).context("keychain access")
}

pub fn get_password(email: &str) -> Result<Option<String>> {
    match entry(email)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e).context("reading the password from the keychain"),
    }
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

/// Keychain name of a refresh token. It stays apart from the passwords: an address
/// can sign in with the browser and also be an extra sender with a password.
fn token_name(email: &str) -> String {
    format!("oauth:{}", email.to_lowercase())
}

pub fn get_refresh_token(email: &str) -> Result<Option<String>> {
    match entry(&token_name(email))?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e).context("reading the sign-in from the keychain"),
    }
}

pub fn set_refresh_token(email: &str, token: &str) -> Result<()> {
    entry(&token_name(email))?.set_password(token).context("saving the sign-in to the keychain")
}

pub fn delete_refresh_token(email: &str) -> Result<()> {
    delete_password(&token_name(email))
}
