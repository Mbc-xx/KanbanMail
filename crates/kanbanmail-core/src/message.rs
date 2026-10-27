//! Message (MIME) parsing for cards and the reader.

use mail_parser::MessageParser;
use serde::Serialize;

/// A board card.
#[derive(Debug, Clone, Serialize)]
pub struct Card {
    pub uid: u32,
    pub from: String,
    pub from_address: String,
    pub subject: String,
    /// Seconds since 1970 (UTC), 0 if unknown.
    pub date: i64,
    pub preview: String,
    pub flagged: bool,
    pub seen: bool,
}

/// The full content of an email, for the reader.
#[derive(Debug, Clone, Serialize)]
pub struct MessageView {
    pub from: String,
    /// Address to reply to (Reply-To if present, otherwise From).
    pub reply_address: String,
    pub to: String,
    /// Addresses in To and Cc, for "Reply all".
    pub all_recipients: Vec<String>,
    pub cc: String,
    pub message_id: Option<String>,
    pub references: Vec<String>,
    pub subject: String,
    pub date: i64,
    pub text: Option<String>,
    /// Sanitized HTML: no scripts, no remote images or resources.
    pub html: Option<String>,
}

fn sender(list: Option<mail_parser::AddressList<'_>>) -> String {
    list.and_then(|l| l.first())
        .map(|m| match (m.name(), m.address()) {
            (Some(n), _) if !n.is_empty() => n.to_string(),
            (_, Some(a)) => a.to_string(),
            _ => String::new(),
        })
        .unwrap_or_default()
}

fn recipients(list: Option<mail_parser::AddressList<'_>>) -> String {
    list.map(|l| {
        l.mailboxes()
            .filter_map(|m| m.address().or(m.name()).map(str::to_string))
            .collect::<Vec<_>>()
            .join(", ")
    })
    .unwrap_or_default()
}

/// Builds a card from the first bytes of a message (may be truncated).
pub fn parse_card(uid: u32, raw: &[u8], flagged: bool, seen: bool, fallback_date: i64) -> Card {
    let parsed = MessageParser::default().parse(raw);
    let from_address = parsed
        .as_ref()
        .and_then(|m| m.from())
        .and_then(|l| l.first())
        .and_then(|m| m.address().map(str::to_string))
        .unwrap_or_default();
    let (from, subject, date, preview) = match &parsed {
        Some(m) => {
            let preview = m
                .body_preview(400)
                .map(|p| p.split_whitespace().collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            (
                sender(m.from()),
                m.subject().unwrap_or_default().to_string(),
                m.date().map(|d| d.to_timestamp()).unwrap_or(fallback_date),
                preview.chars().take(200).collect(),
            )
        }
        None => (String::new(), String::new(), fallback_date, String::new()),
    };
    Card { uid, from, from_address, subject, date, preview, flagged, seen }
}

pub fn parse_view(raw: &[u8]) -> MessageView {
    let Some(m) = MessageParser::default().parse(raw) else {
        return MessageView {
            from: String::new(),
            reply_address: String::new(),
            to: String::new(),
            all_recipients: Vec::new(),
            cc: String::new(),
            message_id: None,
            references: Vec::new(),
            subject: "(unreadable message)".into(),
            date: 0,
            text: Some(String::from_utf8_lossy(raw).into_owned()),
            html: None,
        };
    };
    // Use HTML only if the message really has some: otherwise mail-parser
    // generates it from the text, and we prefer showing plain text.
    let has_real_html = m
        .html_body()
        .any(|p| matches!(p.kind(), mail_parser::PartKind::Html));
    let first_address = |l: Option<mail_parser::AddressList<'_>>| {
        l.and_then(|l| l.first()).and_then(|m| m.address().map(str::to_string))
    };
    let addresses = |l: Option<mail_parser::AddressList<'_>>| -> Vec<String> {
        l.map(|l| l.mailboxes().filter_map(|m| m.address().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    let mut all_recipients = addresses(m.to());
    all_recipients.extend(addresses(m.cc()));
    let mut references: Vec<String> = m
        .references()
        .map(|r| (0..r.len()).filter_map(|i| r.get(i)).map(str::to_string).collect())
        .unwrap_or_default();
    let message_id = m.message_id().map(str::to_string);
    if references.is_empty() {
        if let Some(r) = m.in_reply_to() {
            references.extend((0..r.len()).filter_map(|i| r.get(i)).map(str::to_string));
        }
    }
    MessageView {
        from: sender(m.from()),
        reply_address: first_address(m.reply_to()).or_else(|| first_address(m.from())).unwrap_or_default(),
        to: recipients(m.to()),
        all_recipients,
        cc: recipients(m.cc()),
        message_id,
        references,
        subject: m.subject().unwrap_or_default().to_string(),
        date: m.date().map(|d| d.to_timestamp()).unwrap_or(0),
        text: m.body_text(0).map(|t| t.into_owned()),
        html: if has_real_html {
            m.body_html(0).map(|h| sanitize_html(&h))
        } else {
            None
        },
    }
}

/// Strips scripts, forms, iframes and every reference to external resources.
/// Images survive only when embedded as `data:` (no network requests).
fn sanitize_html(html: &str) -> String {
    ammonia::Builder::default()
        .url_schemes(["data", "mailto"].into_iter().collect())
        .add_generic_attributes(["style", "align", "bgcolor", "width", "height"])
        .link_rel(Some("noopener noreferrer"))
        .clean(html)
        .to_string()
}
