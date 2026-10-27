//! Command-line test tool: connects to the IMAP server and lists folders.
//!
//! Usage:
//!   kanbanmail-cli          connect (asks for details the first time)
//!   kanbanmail-cli reset    forget the saved account and password
//!   kanbanmail-cli board    show board columns and their first emails
//!   kanbanmail-cli smtp     test the SMTP login and find the Sent folder (sends nothing)
//!   kanbanmail-cli folders  list all folders with their kind and unread count

use anyhow::Result;
use kanbanmail_core::{account::Account, imap, secret};
use std::io::{self, Write};

fn ask(label: &str, default: Option<&str>) -> Result<String> {
    match default {
        Some(d) => print!("{label} [{d}]: "),
        None => print!("{label}: "),
    }
    io::stdout().flush()?;
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    let line = line.trim();
    Ok(match (line.is_empty(), default) {
        (true, Some(d)) => d.to_string(),
        _ => line.to_string(),
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("reset") {
        if let Some(acc) = Account::load()? {
            secret::delete_password(&acc.email)?;
        }
        let path = kanbanmail_core::account::config_dir()?.join("account.toml");
        let _ = std::fs::remove_file(path);
        println!("Account and password forgotten.");
        return Ok(());
    }

    let saved = Account::load()?;
    let (account, password, is_new) = match &saved {
        Some(acc) => match secret::get_password(&acc.email)? {
            Some(p) => {
                println!("Using saved account: {} on {}", acc.email, acc.server);
                (acc.clone(), p, false)
            }
            None => (acc.clone(), rpassword::prompt_password("Password: ")?, true),
        },
        None => {
            println!("First-time setup.");
            let email = ask("Email address", None)?;
            let guess = email.split('@').nth(1).map(|d| format!("mail.{d}"));
            let server = ask("IMAP server", guess.as_deref())?;
            let password = rpassword::prompt_password("Password (hidden): ")?;
            (Account::new(server, email), password, true)
        }
    };

    println!("Connecting to {}:{} ...", account.server, account.port);
    let mut session = imap::connect(&account, &password).await?;
    println!("Login successful!\n");

    if is_new {
        account.save()?;
        secret::set_password(&account.email, &password)?;
        println!("Details saved (password in the keychain).\n");
    }

    let caps = imap::capabilities(&mut session).await?;
    let has = |c: &str| caps.iter().any(|x| x.to_uppercase().contains(c));
    println!("Server supports MOVE: {}", if has("MOVE") { "yes" } else { "no" });
    println!("Server supports IDLE: {}\n", if has("IDLE") { "yes" } else { "no" });

    println!("Folders on the server:");
    for f in imap::list_folders(&mut session).await? {
        println!("  - {f}");
    }

    if std::env::args().nth(1).as_deref() == Some("smtp") {
        println!("\nSent folder: {}", imap::sent_folder(&mut session).await?);
        println!("Testing SMTP login on {}:{} ...", account.smtp_host(), account.smtp_port);
        kanbanmail_core::smtp::test_login(&account, &password).await?;
        println!("SMTP login successful (no email sent).");
    }

    if std::env::args().nth(1).as_deref() == Some("folders") {
        println!("\nTrash: {}", imap::trash_folder(&mut session).await?);
        for f in imap::folder_tree(&mut session).await? {
            let unseen = f.unseen.filter(|n| *n > 0).map(|n| format!(" ({n})")).unwrap_or_default();
            println!("{}{} [{}]{unseen}", "  ".repeat(f.depth + 1), f.label, f.kind);
        }
    }

    if std::env::args().nth(1).as_deref() == Some("board") {
        print_board(&mut session).await?;
    }

    session.logout().await.ok();
    Ok(())
}

async fn print_board(session: &mut imap::Session) -> Result<()> {
    let board = kanbanmail_core::board::Board::load_or_create()?;
    let wanted: Vec<String> = board.columns.iter().map(|c| c.folder.clone()).collect();
    let folders = imap::resolve_folders(session, &wanted).await?;
    let mut first = None;
    for (col, folder) in board.columns.iter().zip(&folders) {
        let mut cache = imap::FolderCache::default();
        let cards = imap::load_cards(session, folder, &mut cache, board.max_cards_per_column).await?;
        println!("\n== {} ({folder}): {} emails", col.name, cards.len());
        for c in cards.iter().take(3) {
            let pin = if c.flagged { "📌 " } else { "" };
            let preview: String = c.preview.chars().take(60).collect();
            println!("  {pin}[{}] {} | {} | {preview}", c.uid, c.from, c.subject);
        }
        if first.is_none() {
            first = cards.first().map(|c| (folder.clone(), c.uid));
        }
    }
    if let Some((folder, uid)) = first {
        let m = imap::load_message(session, &folder, uid).await?;
        println!("\nTest read ({folder} uid {uid}): subject {:?}, text {} chars, html {}",
            m.subject, m.text.map_or(0, |t| t.len()), m.html.map_or("none".into(), |h| format!("{} chars", h.len())));
    }
    Ok(())
}
