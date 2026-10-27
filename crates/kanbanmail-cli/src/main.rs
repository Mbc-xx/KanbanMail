//! Command-line test tool: connects to the IMAP server and lists folders.
//!
//! Usage:
//!   kanbanmail-cli          connect (asks for details the first time)
//!   kanbanmail-cli reset    forget the saved account and password
//!   kanbanmail-cli board    show board columns and their first emails
//!   kanbanmail-cli smtp     test the SMTP login and find the Sent folder (sends nothing)
//!   kanbanmail-cli folders  list all folders with their kind and unread count
//!   kanbanmail-cli drafts   save a test draft twice, check one copy is kept, then delete it
//!   kanbanmail-cli thread   show the conversation of the newest Inbox email that is a reply
//!   kanbanmail-cli known    count the people you wrote to and classify the newest Inbox emails
//!   kanbanmail-cli search WORDS  search sender, recipients and subject in Inbox, Sent and Archive

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

    if std::env::args().nth(1).as_deref() == Some("search") {
        let text = std::env::args().skip(2).collect::<Vec<_>>().join(" ");
        let mut folders = vec!["INBOX".to_string()];
        for kind in ["sent", "archive"] {
            if let Some(f) = imap::find_special_folder(&mut session, kind).await? {
                folders.push(f);
            }
        }
        let started = std::time::Instant::now();
        let found = imap::search(&mut session, &text, false, &folders, 100).await?;
        println!("\n\"{text}\" in {folders:?}: {} results in {:?}", found.len(), started.elapsed());
        for e in found.iter().take(5) {
            println!("  [{}] {} | {}", e.folder, e.card.from, e.card.subject);
        }
    }

    if std::env::args().nth(1).as_deref() == Some("known") {
        let started = std::time::Instant::now();
        let known = imap::sent_recipients(&mut session, 2000).await?;
        println!("\nPeople you wrote to: {} (read in {:?})", known.len(), started.elapsed());
        let mut cache = imap::FolderCache::default();
        let cards = imap::load_cards(&mut session, "INBOX", &mut cache, 40).await?;
        let (mut important, mut automated, mut unknown) = (0, 0, 0);
        for c in &cards {
            let label = if c.automated {
                automated += 1;
                "automated"
            } else if known.contains(&c.from_address.to_lowercase()) {
                important += 1;
                "KNOWN"
            } else {
                unknown += 1;
                "unknown"
            };
            println!("  {label:<9} {}", c.from_address);
        }
        println!("Newest {}: {important} from people you wrote to, {automated} automated, {unknown} other", cards.len());
    }

    if std::env::args().nth(1).as_deref() == Some("thread") {
        test_thread(&mut session).await?;
    }

    if std::env::args().nth(1).as_deref() == Some("drafts") {
        test_drafts(&mut session, &account).await?;
    }

    if std::env::args().nth(1).as_deref() == Some("board") {
        print_board(&mut session).await?;
    }

    session.logout().await.ok();
    Ok(())
}

async fn test_thread(session: &mut imap::Session) -> Result<()> {
    let mut cache = imap::FolderCache::default();
    let cards = imap::load_cards(session, "INBOX", &mut cache, 100).await?;
    let reply = cards.iter().find(|c| c.subject.to_lowercase().starts_with("re:"));
    let Some(card) = reply else {
        println!("No reply found among the newest 100 Inbox emails.");
        return Ok(());
    };
    let view = imap::load_message(session, "INBOX", card.uid).await?;
    let mut folders = vec!["INBOX".to_string()];
    for kind in ["sent", "archive"] {
        if let Some(f) = imap::find_special_folder(session, kind).await? {
            folders.push(f);
        }
    }
    let started = std::time::Instant::now();
    let thread = imap::load_thread(session, view.message_id.as_deref(), &view.references, &folders).await?;
    println!("\nConversation of \"{}\" ({} references), searched {:?} in {:?}:", view.subject, view.references.len(), folders, started.elapsed());
    for e in &thread {
        println!("  [{} uid {}] {} | {}", e.folder, e.card.uid, e.card.from, e.card.subject);
    }
    println!("Quoted text found: html {} / text {}", view.html_main.is_some(), view.text_main.is_some());
    Ok(())
}

async fn test_drafts(session: &mut imap::Session, account: &Account) -> Result<()> {
    use kanbanmail_core::smtp::{self, Draft};
    let caps = imap::server_caps(session).await?;
    let id = smtp::new_message_id(&account.email);
    let mut draft = Draft {
        to: String::new(),
        cc: String::new(),
        subject: "KanbanMail draft test".into(),
        body: "first version".into(),
        in_reply_to: None,
        references: vec![],
        message_id: Some(id.clone()),
    };
    let folder = imap::save_draft(session, caps, &smtp::build_draft(account, &draft, None)?.formatted(), &id).await?;
    draft.body = "second version".into();
    imap::save_draft(session, caps, &smtp::build_draft(account, &draft, None)?.formatted(), &id).await?;
    let mut cache = imap::FolderCache::default();
    let copies = imap::load_cards(session, &folder, &mut cache, 50)
        .await?
        .into_iter()
        .filter(|c| c.subject == "KanbanMail draft test")
        .collect::<Vec<_>>();
    println!("\nDrafts folder: {folder}");
    println!("Copies after two saves: {} (expected 1), preview: {:?}", copies.len(), copies.first().map(|c| &c.preview));
    imap::delete_draft(session, caps, &id).await?;
    let mut cache = imap::FolderCache::default();
    let left = imap::load_cards(session, &folder, &mut cache, 50)
        .await?
        .into_iter()
        .filter(|c| c.subject == "KanbanMail draft test")
        .count();
    println!("Copies after delete: {left} (expected 0)");
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
