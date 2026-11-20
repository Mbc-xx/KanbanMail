//! A small IMAP server in memory, over TLS, for the tests: enough of the
//! protocol for the commands Pigeonhole sends, so they run against a server
//! that really changes, without a network or a real mailbox.

use super::Session;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use tokio_rustls::rustls::{ClientConfig, RootCertStore, ServerConfig};
use tokio_rustls::{TlsAcceptor, TlsConnector};

#[derive(Clone, Debug)]
pub struct Mail {
    pub uid: u32,
    pub flags: BTreeSet<String>,
    pub raw: Vec<u8>,
    /// INTERNALDATE, as the server writes it.
    pub internal: String,
}

#[derive(Debug)]
pub struct Folder {
    pub uid_validity: u32,
    pub uid_next: u32,
    pub mails: Vec<Mail>,
}

impl Folder {
    fn add(&mut self, mut mail: Mail) -> u32 {
        mail.uid = self.uid_next;
        self.uid_next += 1;
        self.mails.push(mail);
        self.uid_next - 1
    }
}

/// What the server holds, shared with the test that inspects it.
#[derive(Debug)]
pub struct Mailbox {
    pub caps: Vec<&'static str>,
    pub folders: BTreeMap<String, Folder>,
    /// Every command received, without its tag.
    pub log: Vec<String>,
}

impl Mailbox {
    pub fn new(caps: &[&'static str], folders: &[&str]) -> Self {
        let folders = folders
            .iter()
            .map(|name| {
                (
                    name.to_string(),
                    Folder {
                        uid_validity: 1,
                        uid_next: 1,
                        mails: Vec::new(),
                    },
                )
            })
            .collect();
        Mailbox {
            caps: caps.to_vec(),
            folders,
            log: Vec::new(),
        }
    }

    /// Adds an email written and received on `day` of November 2026; returns its UID.
    pub fn deliver(&mut self, folder: &str, raw: &str, flags: &[&str], day: u32) -> u32 {
        let raw = format!("Date: {day:02} Nov 2026 10:00:00 +0000\n{raw}");
        let mail = Mail {
            uid: 0,
            flags: flags.iter().map(|f| f.to_string()).collect(),
            raw: raw.replace('\n', "\r\n").into_bytes(),
            internal: format!("{day:02}-Nov-2026 10:00:00 +0000"),
        };
        self.folders.get_mut(folder).expect("no such folder").add(mail)
    }

    pub fn flags(&self, folder: &str, uid: u32) -> Vec<String> {
        let mail = self.folders[folder]
            .mails
            .iter()
            .find(|m| m.uid == uid)
            .expect("no such email");
        mail.flags.iter().cloned().collect()
    }

    /// The subjects in a folder, in server order.
    pub fn subjects(&self, folder: &str) -> Vec<String> {
        self.folders[folder]
            .mails
            .iter()
            .map(|m| {
                let text = String::from_utf8_lossy(&m.raw);
                text.lines()
                    .find_map(|l| l.strip_prefix("Subject: "))
                    .unwrap_or_default()
                    .to_string()
            })
            .collect()
    }

    /// How many commands started with `prefix` (e.g. "UID FETCH").
    pub fn count(&self, prefix: &str) -> usize {
        self.log
            .iter()
            .filter(|l| l.to_ascii_uppercase().starts_with(prefix))
            .count()
    }
}

pub type Shared = Arc<Mutex<Mailbox>>;

/// An email with the headers Pigeonhole reads.
pub fn email(subject: &str, message_id: &str, extra_headers: &str) -> String {
    format!(
        "From: Anna Bianchi <anna@example.com>\nTo: me@example.com\nSubject: {subject}\nMessage-ID: <{message_id}>\n{extra_headers}Content-Type: text/plain\n\nHello, this is {subject}.\n"
    )
}

/// Starts a server on `mailbox` and returns a session logged in to it.
pub async fn start(mailbox: Mailbox) -> (Shared, Session) {
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let cert_der = cert.cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()));
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());

    let server_config = ServerConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der.clone()], key)
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let shared: Shared = Arc::new(Mutex::new(mailbox));
    let state = shared.clone();
    let acceptor = TlsAcceptor::from(Arc::new(server_config));
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let tls = acceptor.accept(tcp).await.unwrap();
        serve(tls, state).await;
    });

    let mut roots = RootCertStore::empty();
    roots.add(cert_der).unwrap();
    let client_config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let tls = TlsConnector::from(Arc::new(client_config))
        .connect(ServerName::try_from("localhost").unwrap(), tcp)
        .await
        .unwrap();
    let mut client = async_imap::Client::new(tls);
    client.read_response().await.unwrap();
    let conn = client
        .login("me@example.com", "secret")
        .await
        .map_err(|(e, _)| e)
        .unwrap();
    (shared, Session::new(conn))
}

async fn serve<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(stream: S, state: Shared) {
    let (read, mut write) = tokio::io::split(stream);
    let mut lines = BufReader::new(read).lines();
    write.write_all(b"* OK fake IMAP ready\r\n").await.unwrap();
    let mut selected: Option<String> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        let (tag, command) = line.split_once(' ').unwrap_or((line.as_str(), ""));
        let out = {
            let mut mailbox = state.lock().unwrap();
            mailbox.log.push(command.to_string());
            answer(&mut mailbox, &mut selected, tag, command)
        };
        write.write_all(&out).await.unwrap();
        if command.eq_ignore_ascii_case("LOGOUT") {
            break;
        }
    }
}

/// Splits arguments, keeping "quoted strings" and (lists) whole.
fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let (mut quoted, mut depth) = (false, 0);
    for c in text.chars() {
        match c {
            '"' if depth == 0 => quoted = !quoted,
            '(' if !quoted => {
                depth += 1;
                word.push(c);
            }
            ')' if !quoted => {
                depth -= 1;
                word.push(c);
            }
            ' ' if !quoted && depth == 0 => {
                if !word.is_empty() {
                    out.push(std::mem::take(&mut word));
                }
            }
            _ => word.push(c),
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// The numbers of an IMAP set ("1,3:5,7:*"), `max` standing for "*".
fn set(text: &str, max: u32) -> BTreeSet<u32> {
    let num = |s: &str| if s == "*" { max } else { s.parse().unwrap() };
    let mut out = BTreeSet::new();
    for part in text.split(',') {
        match part.split_once(':') {
            Some((a, b)) => {
                let (a, b) = (num(a), num(b));
                out.extend(a.min(b)..=a.max(b));
            }
            None => {
                out.insert(num(part));
            }
        }
    }
    out
}

fn flag_list(flags: &BTreeSet<String>) -> String {
    flags.iter().cloned().collect::<Vec<_>>().join(" ")
}

/// One FETCH response for the email at `seq`, with the items asked for.
fn fetch_line(seq: usize, mail: &Mail, items: &str) -> Vec<u8> {
    let items = items.to_ascii_uppercase();
    let mut out = format!("* {seq} FETCH (UID {}", mail.uid).into_bytes();
    if items.contains("FLAGS") {
        out.extend(format!(" FLAGS ({})", flag_list(&mail.flags)).bytes());
    }
    if items.contains("INTERNALDATE") {
        out.extend(format!(" INTERNALDATE \"{}\"", mail.internal).bytes());
    }
    if items.contains("BODY.PEEK[]") || items.contains("BODY[]") {
        let len = if items.contains("<0.") {
            mail.raw.len().min(32768)
        } else {
            mail.raw.len()
        };
        out.extend(format!(" BODY[] {{{len}}}\r\n").bytes());
        out.extend(&mail.raw[..len]);
    }
    out.extend(b")\r\n");
    out
}

fn answer(mailbox: &mut Mailbox, selected: &mut Option<String>, tag: &str, command: &str) -> Vec<u8> {
    let args = words(command);
    let upper: Vec<String> = args.iter().map(|a| a.to_ascii_uppercase()).collect();
    let ok = |text: &str| format!("{tag} OK {text}\r\n").into_bytes();
    let no = |text: &str| format!("{tag} NO {text}\r\n").into_bytes();
    let mut out = Vec::new();
    match upper.first().map(String::as_str) {
        Some("CAPABILITY") => {
            out.extend(format!("* CAPABILITY IMAP4rev1 {}\r\n", mailbox.caps.join(" ")).bytes());
            out.extend(ok("done"));
        }
        Some("LOGIN") | Some("NOOP") => out.extend(ok("done")),
        Some("LOGOUT") => {
            out.extend(b"* BYE\r\n");
            out.extend(ok("bye"));
        }
        Some("LIST") => {
            for name in mailbox.folders.keys() {
                out.extend(format!("* LIST () \"/\" \"{name}\"\r\n").bytes());
            }
            out.extend(ok("done"));
        }
        Some("SELECT") | Some("EXAMINE") => {
            let name = &args[1];
            let Some(folder) = mailbox.folders.get(name) else {
                return no("no such folder");
            };
            *selected = Some(name.clone());
            out.extend(b"* FLAGS (\\Seen \\Flagged \\Deleted \\Answered \\Draft)\r\n");
            out.extend(format!("* {} EXISTS\r\n* 0 RECENT\r\n", folder.mails.len()).bytes());
            out.extend(
                format!(
                    "* OK [UIDVALIDITY {}] ok\r\n* OK [UIDNEXT {}] ok\r\n",
                    folder.uid_validity, folder.uid_next
                )
                .bytes(),
            );
            let mode = if upper[0] == "SELECT" {
                "[READ-WRITE]"
            } else {
                "[READ-ONLY]"
            };
            out.extend(ok(&format!("{mode} done")));
        }
        Some(_) if selected.is_none() => return no("no folder selected"),
        Some("FETCH") => {
            let folder = &mailbox.folders[selected.as_ref().unwrap()];
            let wanted = set(&args[1], folder.mails.len() as u32);
            for (i, mail) in folder.mails.iter().enumerate() {
                if wanted.contains(&(i as u32 + 1)) {
                    out.extend(fetch_line(i + 1, mail, &args[2]));
                }
            }
            out.extend(ok("done"));
        }
        Some("EXPUNGE") => {
            let folder = mailbox.folders.get_mut(selected.as_ref().unwrap()).unwrap();
            out.extend(expunge(folder, |m| m.flags.contains("\\Deleted")));
            out.extend(ok("done"));
        }
        Some("UID") => {
            let name = selected.clone().unwrap();
            let max = mailbox.folders[&name].uid_next.saturating_sub(1).max(1);
            let uids = if upper[1] == "SEARCH" {
                BTreeSet::new()
            } else {
                set(&args[2], max)
            };
            match upper[1].as_str() {
                "FETCH" => {
                    for (i, mail) in mailbox.folders[&name].mails.iter().enumerate() {
                        if uids.contains(&mail.uid) {
                            out.extend(fetch_line(i + 1, mail, &args[3]));
                        }
                    }
                }
                "STORE" => {
                    let op = &upper[3];
                    let flags: Vec<String> = args[4]
                        .trim_matches(|c| c == '(' || c == ')')
                        .split_whitespace()
                        .map(String::from)
                        .collect();
                    let folder = mailbox.folders.get_mut(&name).unwrap();
                    for (i, mail) in folder.mails.iter_mut().enumerate() {
                        if !uids.contains(&mail.uid) {
                            continue;
                        }
                        match op.chars().next() {
                            Some('+') => mail.flags.extend(flags.iter().cloned()),
                            Some('-') => mail.flags.retain(|f| !flags.contains(f)),
                            _ => mail.flags = flags.iter().cloned().collect(),
                        }
                        if !op.ends_with(".SILENT") {
                            out.extend(fetch_line(i + 1, mail, "FLAGS"));
                        }
                    }
                }
                "COPY" | "MOVE" => {
                    let to = &args[3];
                    if !mailbox.folders.contains_key(to) {
                        return no("[TRYCREATE] no such folder");
                    }
                    let picked: Vec<Mail> = mailbox.folders[&name]
                        .mails
                        .iter()
                        .filter(|m| uids.contains(&m.uid))
                        .cloned()
                        .collect();
                    let target = mailbox.folders.get_mut(to).unwrap();
                    for mail in picked {
                        target.add(mail);
                    }
                    if upper[1] == "MOVE" {
                        out.extend(expunge(mailbox.folders.get_mut(&name).unwrap(), |m| {
                            uids.contains(&m.uid)
                        }));
                    }
                }
                "EXPUNGE" => {
                    out.extend(expunge(mailbox.folders.get_mut(&name).unwrap(), |m| {
                        uids.contains(&m.uid) && m.flags.contains("\\Deleted")
                    }));
                }
                "SEARCH" => {
                    // Only HEADER Message-ID "<id>" is understood.
                    let id = args.last().unwrap().trim_matches(|c| c == '<' || c == '>');
                    let found: Vec<String> = mailbox.folders[&name]
                        .mails
                        .iter()
                        .filter(|m| String::from_utf8_lossy(&m.raw).contains(&format!("Message-ID: <{id}>")))
                        .map(|m| m.uid.to_string())
                        .collect();
                    out.extend(format!("* SEARCH {}\r\n", found.join(" ")).trim_end().bytes());
                    out.extend(b"\r\n");
                }
                _ => return format!("{tag} BAD unknown UID command\r\n").into_bytes(),
            }
            out.extend(ok("done"));
        }
        _ => return format!("{tag} BAD unknown command\r\n").into_bytes(),
    }
    out
}

/// Removes the emails `gone` picks and reports them, highest number first so
/// the numbers still to report do not shift.
fn expunge(folder: &mut Folder, gone: impl Fn(&Mail) -> bool) -> Vec<u8> {
    let mut out = Vec::new();
    for i in (0..folder.mails.len()).rev() {
        if gone(&folder.mails[i]) {
            folder.mails.remove(i);
            out.extend(format!("* {} EXPUNGE\r\n", i + 1).bytes());
        }
    }
    out
}
