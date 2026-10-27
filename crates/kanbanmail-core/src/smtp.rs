//! Sending email over SMTP (port 465 SSL/TLS or 587 STARTTLS).

use crate::account::Account;
use anyhow::{anyhow, Context, Result};
use lettre::message::{header::ContentType, Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Deserialize;

/// An email written in the app. Addresses are comma-separated.
#[derive(Debug, Clone, Deserialize)]
pub struct Draft {
    pub to: String,
    #[serde(default)]
    pub cc: String,
    /// Blind copies: they receive the email but nobody sees them.
    #[serde(default)]
    pub bcc: String,
    pub subject: String,
    pub body: String,
    /// Message-ID of the email being replied to (keeps the conversation threaded).
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
    /// Write the body in Markdown (inline HTML allowed): the email gets an HTML version.
    #[serde(default)]
    pub markdown: bool,
    /// Files attached to the email.
    #[serde(default)]
    pub attachments: Vec<OutgoingAttachment>,
    /// Message-ID of this email. The composer keeps the same one across draft
    /// saves and the final send, so older draft versions can be found and removed.
    #[serde(default)]
    pub message_id: Option<String>,
}

/// A file attached to an outgoing email, as sent by the UI.
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct OutgoingAttachment {
    pub name: String,
    #[serde(default)]
    pub mime: String,
    /// File content, base64.
    pub data: String,
}

fn parse_list(list: &str) -> Result<Vec<Mailbox>> {
    list.split([',', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<Mailbox>().map_err(|_| anyhow!("invalid address: {s}")))
        .collect()
}

fn parse_list_lenient(list: &str) -> Vec<Mailbox> {
    list.split([',', ';']).filter_map(|s| s.trim().parse::<Mailbox>().ok()).collect()
}

/// A new unique Message-ID on the account's domain.
pub fn new_message_id(email: &str) -> String {
    let domain = email.split('@').nth(1).unwrap_or("localhost");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("<{nanos}.{}@{domain}>", std::process::id())
}

fn angle(id: &str) -> String {
    if id.starts_with('<') { id.to_string() } else { format!("<{id}>") }
}

/// A rich signature. The composer shows `text` (after a "-- " line); when the
/// body still contains it unchanged, the email also gets an HTML version where
/// that block is replaced by `html`.
#[derive(Debug, Clone, Default)]
pub struct HtmlSignature {
    pub text: String,
    pub html: String,
}

/// Builds the message to send (UTF-8 plain text, plus HTML with a rich signature).
/// The Bcc header is removed: Bcc recipients only appear in the SMTP envelope.
pub fn build(account: &Account, draft: &Draft, signature: Option<&HtmlSignature>) -> Result<Message> {
    build_message(account, draft, false, signature, false)
}

/// The copy of a sent email kept in the Sent folder: same as [`build`], but it
/// keeps the Bcc header so you can see who was in blind copy.
pub fn build_sent_copy(account: &Account, draft: &Draft, signature: Option<&HtmlSignature>) -> Result<Message> {
    build_message(account, draft, false, signature, true)
}

/// Builds a draft: recipients may be missing and unfinished addresses are skipped.
pub fn build_draft(account: &Account, draft: &Draft, signature: Option<&HtmlSignature>) -> Result<Message> {
    build_message(account, draft, true, signature, true)
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn text_block(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    format!("<div style=\"white-space:pre-wrap\">{}</div>", escape_html(text))
}

/// Moves `data:` images of the signature into inline parts (`cid:`), which mail
/// clients show more reliably than `data:` URIs.
fn extract_inline_images(html: &str) -> (String, Vec<SinglePart>) {
    use base64::Engine;
    let mut out = String::with_capacity(html.len());
    let mut parts = Vec::new();
    let mut rest = html;
    while let Some(pos) = rest.find("data:image/") {
        let (before, tail) = rest.split_at(pos);
        out.push_str(before);
        let end = tail.find(['"', '\'', ')', ' ']).unwrap_or(tail.len());
        let uri = &tail[..end];
        rest = &tail[end..];
        let decoded = uri.split_once(";base64,").and_then(|(head, data)| {
            let mime = head.trim_start_matches("data:");
            let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()?;
            Some((ContentType::parse(mime).ok()?, bytes))
        });
        match decoded {
            Some((ctype, bytes)) => {
                let cid = format!("sig{}.{}@kanbanmail", parts.len() + 1, std::process::id());
                parts.push(Attachment::new_inline(cid.clone()).body(bytes, ctype));
                out.push_str(&format!("cid:{cid}"));
            }
            None => out.push_str(uri),
        }
    }
    out.push_str(rest);
    (out, parts)
}

/// Markdown (with inline HTML) to sanitized HTML.
pub fn markdown_to_html(text: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    let mut out = String::new();
    // Single line breaks are kept as line breaks, as people expect in emails.
    html::push_html(&mut out, Parser::new_ext(&text.replace('\n', "  \n"), opts));
    crate::message::sanitize_signature(&out)
}

/// The HTML version of the body, if it should have one: when the body is
/// Markdown, or when a rich signature is present (and its text left unchanged).
fn html_body(body: &str, markdown: bool, signature: Option<&HtmlSignature>) -> Option<MultiPart> {
    let body = body.replace("\r\n", "\n");
    let sig = signature.filter(|s| !s.html.trim().is_empty() && !s.text.trim().is_empty());
    let marker = sig.map(|s| format!("-- \n{}", s.text.trim_end().replace("\r\n", "\n")));
    let split = marker.as_ref().and_then(|m| body.find(m.as_str()).map(|pos| (pos, m.len())));
    if !markdown && split.is_none() {
        return None;
    }
    let render = |text: &str| if markdown { markdown_to_html(text) } else { text_block(text) };
    let (inner, images) = match (split, sig) {
        (Some((pos, len)), Some(sig)) => {
            let (sig_html, images) = extract_inline_images(&sig.html);
            let after = body[pos + len..].trim_start_matches('\n');
            (format!("{}<div>-- <br>{}</div>{}", render(&body[..pos]), sig_html, render(after)), images)
        }
        _ => (render(&body), Vec::new()),
    };
    let html = format!(
        "<!doctype html><html><body style=\"font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px\">{inner}</body></html>"
    );
    let html_part = SinglePart::html(html);
    let alternative = MultiPart::alternative().singlepart(SinglePart::plain(body.clone()));
    Some(if images.is_empty() {
        alternative.singlepart(html_part)
    } else {
        let related = images.into_iter().fold(MultiPart::related().singlepart(html_part), |mp, p| mp.singlepart(p));
        alternative.multipart(related)
    })
}

/// The attachments as MIME parts.
fn attachment_parts(list: &[OutgoingAttachment]) -> Result<Vec<SinglePart>> {
    use base64::Engine;
    list.iter()
        .map(|a| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(a.data.trim())
                .map_err(|_| anyhow!("attachment {} is not valid", a.name))?;
            let ctype = ContentType::parse(if a.mime.is_empty() { "application/octet-stream" } else { &a.mime })
                .unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
            Ok(Attachment::new(a.name.clone()).body(bytes, ctype))
        })
        .collect()
}

fn build_message(
    account: &Account,
    draft: &Draft,
    is_draft: bool,
    signature: Option<&HtmlSignature>,
    keep_bcc: bool,
) -> Result<Message> {
    let from: Mailbox = match account.display_name.as_deref().filter(|n| !n.trim().is_empty()) {
        Some(name) => format!("{} <{}>", name.trim(), account.email).parse(),
        None => account.email.parse(),
    }
    .map_err(|_| anyhow!("invalid sender address: {}", account.email))?;

    let (to, cc, bcc) = if is_draft {
        (parse_list_lenient(&draft.to), parse_list_lenient(&draft.cc), parse_list_lenient(&draft.bcc))
    } else {
        (parse_list(&draft.to)?, parse_list(&draft.cc)?, parse_list(&draft.bcc)?)
    };
    anyhow::ensure!(is_draft || !to.is_empty() || !cc.is_empty() || !bcc.is_empty(), "missing recipient");

    let mut builder = Message::builder().from(from.clone()).subject(draft.subject.trim()).date_now();
    if is_draft {
        // A draft is never sent, but lettre requires an envelope with a recipient.
        builder = builder.envelope(lettre::address::Envelope::new(Some(from.email.clone()), vec![from.email.clone()])?);
    }
    for m in to {
        builder = builder.to(m);
    }
    for m in cc {
        builder = builder.cc(m);
    }
    for m in bcc {
        builder = builder.bcc(m);
    }
    if keep_bcc {
        builder = builder.keep_bcc();
    }
    if let Some(id) = draft.in_reply_to.as_deref().filter(|s| !s.is_empty()) {
        builder = builder.in_reply_to(angle(id));
        let mut refs: Vec<String> = draft.references.iter().map(|r| angle(r)).collect();
        refs.push(angle(id));
        builder = builder.references(refs.join(" "));
    }
    let message_id = match draft.message_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => angle(id),
        None => new_message_id(&account.email),
    };
    builder = builder.message_id(Some(message_id));
    let content = html_body(&draft.body, draft.markdown, signature);
    let files = attachment_parts(&draft.attachments)?;
    if files.is_empty() {
        return match content {
            Some(multipart) => builder.multipart(multipart),
            None => builder.header(ContentType::TEXT_PLAIN).body(draft.body.clone()),
        }
        .context("building the message failed");
    }
    // Text (and HTML) first, then the files.
    let mixed = match content {
        Some(multipart) => MultiPart::mixed().multipart(multipart),
        None => MultiPart::mixed().singlepart(SinglePart::plain(draft.body.clone())),
    };
    builder
        .multipart(files.into_iter().fold(mixed, |mp, part| mp.singlepart(part)))
        .context("building the message failed")
}

fn transport(account: &Account, password: &str) -> Result<AsyncSmtpTransport<Tokio1Executor>> {
    let host = account.smtp_host();
    let builder = if account.smtp_port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(host)
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
    }
    .with_context(|| format!("invalid SMTP server: {host}"))?;
    Ok(builder
        .port(account.smtp_port)
        .credentials(Credentials::new(account.email.clone(), password.to_string()))
        .timeout(Some(std::time::Duration::from_secs(30)))
        .build())
}

/// Connects to the SMTP server and logs in, without sending anything.
pub async fn test_login(account: &Account, password: &str) -> Result<()> {
    let ok = transport(account, password)?
        .test_connection()
        .await
        .with_context(|| format!("SMTP login to {}:{} failed", account.smtp_host(), account.smtp_port))?;
    anyhow::ensure!(ok, "the SMTP server does not respond");
    Ok(())
}

/// Sends the message.
pub async fn send(account: &Account, password: &str, message: &Message) -> Result<()> {
    let host = account.smtp_host();
    transport(account, password)?
        .send(message.clone())
        .await
        .with_context(|| format!("sending via {host}:{} failed", account.smtp_port))?;
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
            subject: "Re: Test àèì".into(),
            body: "Ciao\n> citato".into(),
            in_reply_to: Some("orig@example.com".into()),
            references: vec!["first@example.com".into()],
            message_id: Some("fixed@example.com".into()),
            bcc: "boss@example.com".into(),
            markdown: false,
            attachments: vec![],
        };
        let raw = String::from_utf8(build(&acc, &draft, None).unwrap().formatted()).unwrap();
        assert!(raw.contains("From: \"Mario Rossi\" <me@example.com>"), "{raw}");
        assert!(raw.contains("In-Reply-To: <orig@example.com>"), "{raw}");
        assert!(raw.contains("References: <first@example.com> <orig@example.com>"), "{raw}");
        assert!(raw.contains("Cc: b@example.com, c@example.com"), "{raw}");
        assert!(raw.contains("Message-ID: <fixed@example.com>"), "{raw}");
        // Sent on the wire without Bcc header, but delivered to the Bcc recipient.
        let sent = build(&acc, &draft, None).unwrap();
        assert!(!String::from_utf8(sent.formatted()).unwrap().contains("Bcc:"));
        assert!(sent.envelope().to().iter().any(|a| a.to_string() == "boss@example.com"));
        // The Sent copy keeps it.
        let copy = String::from_utf8(build_sent_copy(&acc, &draft, None).unwrap().formatted()).unwrap();
        assert!(copy.contains("Bcc: boss@example.com"), "{copy}");
    }

    #[test]
    fn draft_allows_missing_and_unfinished_recipients() {
        let acc = Account::new("mail.example.com".into(), "me@example.com".into());
        let draft = Draft { to: "a@example.com, mar".into(), cc: String::new(), subject: String::new(), body: "half written".into(), in_reply_to: None, references: vec![], message_id: None, bcc: String::new(), markdown: false, attachments: vec![] };
        let raw = String::from_utf8(build_draft(&acc, &draft, None).unwrap().formatted()).unwrap();
        assert!(raw.contains("To: a@example.com"), "{raw}");
        let empty = Draft { to: String::new(), ..draft };
        assert!(build_draft(&acc, &empty, None).is_ok());
        assert!(build(&acc, &empty, None).is_err());
    }

    #[test]
    fn rejects_bad_address() {
        let acc = Account::new("mail.example.com".into(), "me@example.com".into());
        let draft = Draft { to: "not-an-address".into(), cc: String::new(), subject: "x".into(), body: String::new(), in_reply_to: None, references: vec![], message_id: None, bcc: String::new(), markdown: false, attachments: vec![] };
        assert!(build(&acc, &draft, None).is_err());
    }

    #[test]
    fn html_signature_with_inline_image() {
        let acc = Account::new("mail.example.com".into(), "me@example.com".into());
        let sig = HtmlSignature {
            text: "Jane Doe\nExample Inc.".into(),
            html: "<b>Jane Doe</b><br><img src=\"data:image/png;base64,iVBORw0KGgo=\" width=\"80\"><br>Example Inc.".into(),
        };
        let draft = Draft {
            to: "a@example.com".into(),
            cc: String::new(),
            subject: "Hi".into(),
            body: "Hello <there>\n\n-- \nJane Doe\nExample Inc.\n\nOn Monday, Bob wrote:\n> hi".into(),
            in_reply_to: None,
            references: vec![],
            message_id: None,
            bcc: String::new(),
            markdown: false,
            attachments: vec![],
        };
        let raw = String::from_utf8(build(&acc, &draft, Some(&sig)).unwrap().formatted()).unwrap();
        assert!(raw.contains("multipart/alternative"), "{raw}");
        assert!(raw.contains("multipart/related"), "{raw}");
        assert!(raw.contains("Content-ID: <sig1."), "{raw}");
        assert!(raw.contains("src=3D\"cid:sig1.") || raw.contains("src=\"cid:sig1."), "{raw}");
        assert!(raw.contains("Hello &lt;there&gt;"), "{raw}");

        // Signature text edited by hand: plain text only.
        let edited = Draft { body: "Hello\n\n-- \nJane".into(), ..draft };
        let raw = String::from_utf8(build(&acc, &edited, Some(&sig)).unwrap().formatted()).unwrap();
        assert!(!raw.contains("multipart"), "{raw}");
    }

    #[test]
    fn markdown_body_and_attachments() {
        let acc = Account::new("mail.example.com".into(), "me@example.com".into());
        let draft = Draft {
            to: "a@example.com".into(),
            cc: String::new(),
            bcc: String::new(),
            subject: "Report".into(),
            body: "Hello **team**\nsecond line\n\n- one\n- two\n\n<script>x</script>".into(),
            in_reply_to: None,
            references: vec![],
            message_id: None,
            markdown: true,
            attachments: vec![OutgoingAttachment { name: "notes.txt".into(), mime: "text/plain".into(), data: "aGVsbG8=".into() }],
        };
        let html = markdown_to_html(&draft.body);
        assert!(html.contains("<strong>team</strong>") && html.contains("<br") && html.contains("<li>one</li>"), "{html}");
        assert!(!html.contains("<script"), "{html}");
        let raw = String::from_utf8(build(&acc, &draft, None).unwrap().formatted()).unwrap();
        assert!(raw.contains("multipart/mixed") && raw.contains("multipart/alternative"), "{raw}");
        assert!(raw.contains("filename=\"notes.txt\"") && raw.contains("hello"), "{raw}");
        // Plain text with an attachment: mixed, no HTML.
        let plain = Draft { markdown: false, ..draft };
        let raw = String::from_utf8(build(&acc, &plain, None).unwrap().formatted()).unwrap();
        assert!(raw.contains("multipart/mixed") && !raw.contains("text/html"), "{raw}");
    }
}
