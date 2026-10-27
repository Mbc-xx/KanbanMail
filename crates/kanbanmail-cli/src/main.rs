//! Test da riga di comando: si collega al server IMAP ed elenca le cartelle.
//!
//! Uso:
//!   kanbanmail-cli          collega (chiede i dati la prima volta)
//!   kanbanmail-cli reset    dimentica account e password salvati
//!   kanbanmail-cli board    mostra le colonne della board e le prime mail
//!   kanbanmail-cli invio    prova il login SMTP e trova la cartella Inviata (non invia nulla)

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
        println!("Account e password dimenticati.");
        return Ok(());
    }

    let saved = Account::load()?;
    let (account, password, is_new) = match &saved {
        Some(acc) => match secret::get_password(&acc.email)? {
            Some(p) => {
                println!("Uso l'account salvato: {} su {}", acc.email, acc.server);
                (acc.clone(), p, false)
            }
            None => (acc.clone(), rpassword::prompt_password("Password: ")?, true),
        },
        None => {
            println!("Prima configurazione.");
            let email = ask("Indirizzo email", None)?;
            let guess = email.split('@').nth(1).map(|d| format!("mail.{d}"));
            let server = ask("Server IMAP", guess.as_deref())?;
            let password = rpassword::prompt_password("Password (non viene mostrata): ")?;
            (Account::new(server, email), password, true)
        }
    };

    println!("Mi collego a {}:{} ...", account.server, account.port);
    let mut session = imap::connect(&account, &password).await?;
    println!("Login riuscito!\n");

    if is_new {
        account.save()?;
        secret::set_password(&account.email, &password)?;
        println!("Dati salvati (password nel portachiavi).\n");
    }

    let caps = imap::capabilities(&mut session).await?;
    let has = |c: &str| caps.iter().any(|x| x.to_uppercase().contains(c));
    println!("Il server supporta MOVE: {}", if has("MOVE") { "sì" } else { "no" });
    println!("Il server supporta IDLE: {}\n", if has("IDLE") { "sì" } else { "no" });

    println!("Cartelle sul server:");
    for f in imap::list_folders(&mut session).await? {
        println!("  - {f}");
    }

    if std::env::args().nth(1).as_deref() == Some("invio") {
        println!("\nCartella posta inviata: {}", imap::sent_folder(&mut session).await?);
        println!("Provo il login SMTP su {}:{} ...", account.smtp_host(), account.smtp_port);
        kanbanmail_core::smtp::test_login(&account, &password).await?;
        println!("Login SMTP riuscito (nessuna mail inviata).");
    }

    if std::env::args().nth(1).as_deref() == Some("cartelle") {
        println!("\nCestino: {}", imap::trash_folder(&mut session).await?);
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
        println!("\n== {} ({folder}): {} mail", col.name, cards.len());
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
        println!("\nLettura di prova ({folder} uid {uid}): oggetto {:?}, testo {} caratteri, html {}",
            m.subject, m.text.map_or(0, |t| t.len()), m.html.map_or("assente".into(), |h| format!("{} caratteri", h.len())));
    }
    Ok(())
}
