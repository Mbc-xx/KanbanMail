//! Invio delle mail via SMTP (porta 465 SSL/TLS oppure 587 STARTTLS).

use crate::account::Account;
use anyhow::{anyhow, Context, Result};
use lettre::message::{header::ContentType, Mailbox};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Deserialize;

/// Una mail scritta nell'app. Gli indirizzi sono separati da virgola.
#[derive(Debug, Clone, Deserialize)]
pub struct Draft {
    pub to: String,
    #[serde(default)]
    pub cc: String,
    pub subject: String,
    pub body: String,
    /// Message-ID della mail a cui si risponde (per tenere il filo della conversazione).
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
}

fn parse_list(list: &str) -> Result<Vec<Mailbox>> {
    list.split([',', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<Mailbox>().map_err(|_| anyhow!("indirizzo non valido: {s}")))
        .collect()
}

fn angle(id: &str) -> String {
    if id.starts_with('<') { id.to_string() } else { format!("<{id}>") }
}

/// Costruisce il messaggio (testo semplice, UTF-8).
pub fn build(account: &Account, draft: &Draft) -> Result<Message> {
    let from: Mailbox = match account.display_name.as_deref().filter(|n| !n.trim().is_empty()) {
        Some(name) => format!("{} <{}>", name.trim(), account.email).parse(),
        None => account.email.parse(),
    }
    .map_err(|_| anyhow!("indirizzo mittente non valido: {}", account.email))?;

    let to = parse_list(&draft.to)?;
    let cc = parse_list(&draft.cc)?;
    anyhow::ensure!(!to.is_empty(), "manca il destinatario");

    let mut builder = Message::builder().from(from).subject(draft.subject.trim()).date_now();
    for m in to {
        builder = builder.to(m);
    }
    for m in cc {
        builder = builder.cc(m);
    }
    if let Some(id) = draft.in_reply_to.as_deref().filter(|s| !s.is_empty()) {
        builder = builder.in_reply_to(angle(id));
        let mut refs: Vec<String> = draft.references.iter().map(|r| angle(r)).collect();
        refs.push(angle(id));
        builder = builder.references(refs.join(" "));
    }
    let domain = account.email.split('@').nth(1).unwrap_or("localhost");
    builder = builder.message_id(Some(format!(
        "<{}.{}@{domain}>",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos(),
        std::process::id()
    )));
    builder
        .header(ContentType::TEXT_PLAIN)
        .body(draft.body.clone())
        .context("costruzione del messaggio fallita")
}

fn transport(account: &Account, password: &str) -> Result<AsyncSmtpTransport<Tokio1Executor>> {
    let host = account.smtp_host();
    let builder = if account.smtp_port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(host)
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
    }
    .with_context(|| format!("server SMTP non valido: {host}"))?;
    Ok(builder
        .port(account.smtp_port)
        .credentials(Credentials::new(account.email.clone(), password.to_string()))
        .timeout(Some(std::time::Duration::from_secs(30)))
        .build())
}

/// Si collega al server SMTP e fa il login, senza inviare nulla.
pub async fn test_login(account: &Account, password: &str) -> Result<()> {
    let ok = transport(account, password)?
        .test_connection()
        .await
        .with_context(|| format!("login SMTP su {}:{} fallito", account.smtp_host(), account.smtp_port))?;
    anyhow::ensure!(ok, "il server SMTP non risponde");
    Ok(())
}

/// Invia il messaggio.
pub async fn send(account: &Account, password: &str, message: &Message) -> Result<()> {
    let host = account.smtp_host();
    transport(account, password)?
        .send(message.clone())
        .await
        .with_context(|| format!("invio tramite {host}:{} fallito", account.smtp_port))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_keeps_thread_headers() {
        let mut acc = Account::new("mail.example.com".into(), "me@example.com".into());
        acc.display_name = Some("Mario Rossi".into());
        let draft = Draft {
            to: "a@example.com".into(),
            cc: "b@example.com; c@example.com".into(),
            subject: "Re: Prova àèì".into(),
            body: "Ciao\n> citato".into(),
            in_reply_to: Some("orig@example.com".into()),
            references: vec!["first@example.com".into()],
        };
        let raw = String::from_utf8(build(&acc, &draft).unwrap().formatted()).unwrap();
        assert!(raw.contains("From: \"Mario Rossi\" <me@example.com>"), "{raw}");
        assert!(raw.contains("In-Reply-To: <orig@example.com>"), "{raw}");
        assert!(raw.contains("References: <first@example.com> <orig@example.com>"), "{raw}");
        assert!(raw.contains("Cc: b@example.com, c@example.com"), "{raw}");
    }

    #[test]
    fn rejects_bad_address() {
        let acc = Account::new("mail.example.com".into(), "me@example.com".into());
        let draft = Draft { to: "non-un-indirizzo".into(), cc: String::new(), subject: "x".into(), body: String::new(), in_reply_to: None, references: vec![] };
        assert!(build(&acc, &draft).is_err());
    }
}
