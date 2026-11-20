//! Passwords in the operating system keychain (Keychain on macOS,
//! Credential Manager on Windows, Secret Service on Linux).
//!
//! macOS asks for permission once per keychain item, so there all of them live in
//! a single item, read once per launch. Elsewhere nothing is asked, and Windows
//! limits the size of an item: each secret keeps an item of its own.

use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

const ONE_ITEM: bool = cfg!(target_os = "macos");

/// Name of the single item.
const VAULT: &str = "vault";

trait Items {
    fn read(&self, name: &str) -> Result<Option<String>>;
    fn write(&self, name: &str, value: &str) -> Result<()>;
    fn remove(&self, name: &str) -> Result<()>;
}

struct Keychain;

fn entry(name: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(crate::account::APP_NAME, name).context("keychain access")
}

impl Items for Keychain {
    fn read(&self, name: &str) -> Result<Option<String>> {
        match entry(name)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e).context("reading the password from the keychain"),
        }
    }

    fn write(&self, name: &str, value: &str) -> Result<()> {
        entry(name)?
            .set_password(value)
            .context("saving the password to the keychain")
    }

    fn remove(&self, name: &str) -> Result<()> {
        match entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e).context("deleting the password from the keychain"),
        }
    }
}

/// Every secret in one item. Holding the lock while the system asks for permission
/// means that calls arriving meanwhile wait for that answer instead of asking again.
struct Vault<I> {
    items: I,
    secrets: Mutex<Option<BTreeMap<String, String>>>,
}

impl<I: Items> Vault<I> {
    fn new(items: I) -> Self {
        Vault {
            items,
            secrets: Mutex::new(None),
        }
    }

    /// Runs `change` on the secrets, read if this is the first time. A damaged item
    /// is an error: writing over it would lose every password.
    fn with<T>(&self, change: impl FnOnce(&mut BTreeMap<String, String>) -> Result<T>) -> Result<T> {
        let mut guard = self.secrets.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let saved = self.items.read(VAULT)?;
            let secrets =
                saved.map(|text| serde_json::from_str(&text).context("the keychain item of the app is damaged"));
            *guard = Some(secrets.transpose()?.unwrap_or_default());
        }
        change(guard.as_mut().unwrap())
    }

    fn save(&self, secrets: &BTreeMap<String, String>) -> Result<()> {
        self.items.write(VAULT, &serde_json::to_string(secrets)?)
    }

    /// A secret saved by an older version is moved here the first time it is needed.
    fn get(&self, name: &str) -> Result<Option<String>> {
        self.with(|secrets| {
            if let Some(found) = secrets.get(name) {
                return Ok(Some(found.clone()));
            }
            let Some(old) = self.items.read(name)? else {
                return Ok(None);
            };
            secrets.insert(name.to_string(), old.clone());
            self.save(secrets)?;
            self.items.remove(name).ok();
            Ok(Some(old))
        })
    }

    fn set(&self, name: &str, value: &str) -> Result<()> {
        self.with(|secrets| {
            secrets.insert(name.to_string(), value.to_string());
            self.save(secrets)
        })
    }

    fn delete(&self, name: &str) -> Result<()> {
        self.with(|secrets| {
            if secrets.remove(name).is_some() {
                self.save(secrets)?;
            }
            self.items.remove(name)
        })
    }
}

fn vault() -> &'static Vault<Keychain> {
    static VAULT_ITEM: OnceLock<Vault<Keychain>> = OnceLock::new();
    VAULT_ITEM.get_or_init(|| Vault::new(Keychain))
}

pub fn get_password(name: &str) -> Result<Option<String>> {
    if ONE_ITEM {
        vault().get(name)
    } else {
        Keychain.read(name)
    }
}

pub fn set_password(name: &str, password: &str) -> Result<()> {
    if ONE_ITEM {
        vault().set(name, password)
    } else {
        Keychain.write(name, password)
    }
}

pub fn delete_password(name: &str) -> Result<()> {
    if ONE_ITEM {
        vault().delete(name)
    } else {
        Keychain.remove(name)
    }
}

/// Keychain name of a refresh token. It stays apart from the passwords: an address
/// can sign in with the browser and also be an extra sender with a password.
fn token_name(key: &str) -> String {
    format!("oauth:{}", key.to_lowercase())
}

pub fn get_refresh_token(key: &str) -> Result<Option<String>> {
    get_password(&token_name(key)).context("reading the sign-in from the keychain")
}

pub fn set_refresh_token(key: &str, token: &str) -> Result<()> {
    set_password(&token_name(key), token).context("saving the sign-in to the keychain")
}

pub fn delete_refresh_token(key: &str) -> Result<()> {
    delete_password(&token_name(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct Memory {
        items: RefCell<BTreeMap<String, String>>,
        vault_reads: Cell<u32>,
    }

    impl Items for &Memory {
        fn read(&self, name: &str) -> Result<Option<String>> {
            if name == VAULT {
                self.vault_reads.set(self.vault_reads.get() + 1);
            }
            Ok(self.items.borrow().get(name).cloned())
        }
        fn write(&self, name: &str, value: &str) -> Result<()> {
            self.items.borrow_mut().insert(name.to_string(), value.to_string());
            Ok(())
        }
        fn remove(&self, name: &str) -> Result<()> {
            self.items.borrow_mut().remove(name);
            Ok(())
        }
    }

    #[test]
    fn older_items_move_into_the_vault_which_is_read_once() {
        let memory = Memory::default();
        memory.items.borrow_mut().insert("a@example.com".into(), "one".into());
        let vault = Vault::new(&memory);
        assert_eq!(vault.get("a@example.com").unwrap().as_deref(), Some("one"));
        assert_eq!(vault.get("a@example.com").unwrap().as_deref(), Some("one"));
        assert_eq!(vault.get("nobody@example.com").unwrap(), None);
        vault.set("b@example.com", "two").unwrap();
        assert_eq!(memory.vault_reads.get(), 1);
        assert_eq!(memory.items.borrow().keys().collect::<Vec<_>>(), [VAULT]);

        // The next launch finds everything in the item.
        let again = Vault::new(&memory);
        assert_eq!(again.get("b@example.com").unwrap().as_deref(), Some("two"));
        again.delete("a@example.com").unwrap();
        assert_eq!(Vault::new(&memory).get("a@example.com").unwrap(), None);
    }

    #[test]
    fn a_damaged_vault_is_never_written_over() {
        let memory = Memory::default();
        memory.items.borrow_mut().insert(VAULT.into(), "not json".into());
        let vault = Vault::new(&memory);
        assert!(vault.set("a@example.com", "one").is_err());
        assert_eq!(memory.items.borrow().get(VAULT).map(String::as_str), Some("not json"));
    }
}
