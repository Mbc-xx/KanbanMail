//! Moving between accounts on real files, in a throwaway home folder.

use kanbanmail_core::account::{self, Account};
use kanbanmail_core::settings::Settings;

fn emails() -> Vec<String> {
    account::list().unwrap().into_iter().map(|a| a.email).collect()
}

#[test]
fn accounts_keep_their_own_settings_and_can_be_removed() {
    let home = std::env::temp_dir().join(format!("kanbanmail-home-{}", std::process::id()));
    std::fs::remove_dir_all(&home).ok();
    std::fs::create_dir_all(&home).unwrap();
    // Set before anything reads the configuration folder; this file has a single test.
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_CONFIG_HOME", home.join("config"));
    }
    let root = account::config_dir().unwrap();
    assert!(root.starts_with(&home), "must not touch the real configuration");

    // First account, in the main folder.
    Account::new("mail.first.example".into(), "first@example.com".into()).save().unwrap();
    Settings { signature: "First".into(), theme: "dark".into(), ..Settings::default() }.save().unwrap();

    // A second one has its own folder and starts without the first one's signature.
    account::begin_new("second@example.com").unwrap();
    Account::new("mail.second.example".into(), "second@example.com".into()).save().unwrap();
    assert!(account::is_extra());
    assert_ne!(account::config_dir().unwrap(), root);
    assert_eq!(Settings::load().unwrap().signature, "");
    Settings { signature: "Second".into(), ..Settings::default() }.save().unwrap();
    assert_eq!(emails(), ["first@example.com", "second@example.com"]);

    // Moving back finds each account as it was.
    account::switch_to("first@example.com").unwrap();
    assert!(!account::is_extra());
    assert_eq!(Account::load().unwrap().unwrap().server, "mail.first.example");
    assert_eq!(Settings::load().unwrap().signature, "First");

    // Shared preferences reach the other account, its signature stays.
    Settings::load().unwrap().share_with_other_accounts().unwrap();
    account::switch_to("second@example.com").unwrap();
    let second = Settings::load().unwrap();
    assert_eq!((second.signature.as_str(), second.theme.as_str()), ("Second", "dark"));

    assert!(account::switch_to("nobody@example.com").is_err());
    assert!(account::begin_new("..").is_err());

    // Removing an added account deletes only its folder and goes back to the first.
    account::remove_active().unwrap();
    assert_eq!(emails(), ["first@example.com"]);
    assert_eq!(account::config_dir().unwrap(), root);
    assert_eq!(Settings::load().unwrap().signature, "First");

    // Removing the first while another exists hands over to that one.
    account::begin_new("third@example.com").unwrap();
    Account::new("mail.third.example".into(), "third@example.com".into()).save().unwrap();
    account::switch_to("first@example.com").unwrap();
    account::remove_active().unwrap();
    assert_eq!(emails(), ["third@example.com"]);
    assert!(account::is_extra());
    assert_eq!(Account::load().unwrap().unwrap().email, "third@example.com");

    std::fs::remove_dir_all(&home).ok();
}
