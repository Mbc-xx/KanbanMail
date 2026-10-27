//! Connessione IMAP su TLS (porta 993).

use crate::account::Account;
use anyhow::{anyhow, Context, Result};
use futures::TryStreamExt;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::{ClientConfig, RootCertStore, pki_types::ServerName};
use tokio_rustls::TlsConnector;

pub type Session = async_imap::Session<TlsStream<TcpStream>>;

/// Apre la connessione TLS e fa il login. Restituisce una sessione autenticata.
pub async fn connect(account: &Account, password: &str) -> Result<Session> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));

    let tcp = TcpStream::connect((account.server.as_str(), account.port))
        .await
        .with_context(|| format!("impossibile raggiungere {}:{}", account.server, account.port))?;
    let name = ServerName::try_from(account.server.clone())
        .map_err(|_| anyhow!("nome server non valido: {}", account.server))?;
    let tls = connector
        .connect(name, tcp)
        .await
        .context("connessione TLS fallita (certificato o server errato?)")?;

    let mut client = async_imap::Client::new(tls);
    // Il server manda per primo il saluto "* OK ..." che va letto prima del login.
    client
        .read_response()
        .await
        .context("nessun saluto dal server IMAP")?;

    client
        .login(&account.email, password)
        .await
        .map_err(|(e, _)| anyhow!("login rifiutato: {e}"))
}

/// Elenca i nomi di tutte le cartelle IMAP.
pub async fn list_folders(session: &mut Session) -> Result<Vec<String>> {
    let names: Vec<_> = session
        .list(Some(""), Some("*"))
        .await
        .context("comando LIST fallito")?
        .try_collect()
        .await?;
    let mut out: Vec<String> = names.iter().map(|n| n.name().to_string()).collect();
    out.sort();
    Ok(out)
}

/// Capacità annunciate dal server (es. MOVE, IDLE).
pub async fn capabilities(session: &mut Session) -> Result<Vec<String>> {
    let caps = session.capabilities().await.context("comando CAPABILITY fallito")?;
    let mut out: Vec<String> = caps.iter().map(|c| format!("{c:?}")).collect();
    out.sort();
    Ok(out)
}

/// Cosa sa fare il server: decide come spostare e come aggiornarsi.
#[derive(Debug, Clone, Copy, Default)]
pub struct ServerCaps {
    pub r#move: bool,
    pub idle: bool,
    pub uidplus: bool,
}

pub async fn server_caps(session: &mut Session) -> Result<ServerCaps> {
    let caps = session.capabilities().await.context("comando CAPABILITY fallito")?;
    Ok(ServerCaps {
        r#move: caps.has_str("MOVE"),
        idle: caps.has_str("IDLE"),
        uidplus: caps.has_str("UIDPLUS"),
    })
}

/// Trova la cartella reale sul server per ogni nome richiesto, creando quelle
/// mancanti. Esempio: su SiteGround "Todo" diventa "INBOX.Todo".
pub async fn resolve_folders(session: &mut Session, wanted: &[String]) -> Result<Vec<String>> {
    let names: Vec<_> = session
        .list(Some(""), Some("*"))
        .await
        .context("comando LIST fallito")?
        .try_collect()
        .await?;
    let delim = names
        .iter()
        .find_map(|n| n.delimiter().map(str::to_string))
        .unwrap_or_else(|| ".".into());
    let existing: Vec<String> = names.iter().map(|n| n.name().to_string()).collect();
    let prefix = format!("INBOX{delim}");
    // Il server vuole tutte le cartelle dentro INBOX?
    let others: Vec<&String> = existing.iter().filter(|n| !n.eq_ignore_ascii_case("INBOX")).collect();
    let uses_prefix = !others.is_empty() && others.iter().all(|n| n.starts_with(&prefix));

    let mut out = Vec::new();
    for want in wanted {
        if want.eq_ignore_ascii_case("INBOX") {
            out.push("INBOX".to_string());
            continue;
        }
        let with_prefix = format!("{prefix}{want}");
        if let Some(f) = existing.iter().find(|n| *n == want || **n == with_prefix) {
            out.push(f.clone());
            continue;
        }
        let target = if uses_prefix && !want.starts_with(&prefix) { with_prefix } else { want.clone() };
        session
            .create(&target)
            .await
            .with_context(|| format!("impossibile creare la cartella {target}"))?;
        session.subscribe(&target).await.ok();
        out.push(target);
    }
    Ok(out)
}

/// Card già scaricate di una cartella, per non riscaricarle a ogni aggiornamento.
#[derive(Debug, Default)]
pub struct FolderCache {
    uid_validity: Option<u32>,
    cards: std::collections::HashMap<u32, crate::message::Card>,
}

/// Carica le card più recenti di una cartella (al massimo `limit`).
/// Scarica solo le mail nuove; per le altre aggiorna solo i flag.
pub async fn load_cards(
    session: &mut Session,
    folder: &str,
    cache: &mut FolderCache,
    limit: u32,
) -> Result<Vec<crate::message::Card>> {
    use async_imap::types::Flag;

    let mailbox = session
        .select(folder)
        .await
        .with_context(|| format!("impossibile aprire la cartella {folder}"))?;
    if mailbox.uid_validity != cache.uid_validity {
        cache.cards.clear();
        cache.uid_validity = mailbox.uid_validity;
    }
    if mailbox.exists == 0 {
        cache.cards.clear();
        return Ok(Vec::new());
    }
    let start = mailbox.exists.saturating_sub(limit.max(1) - 1).max(1);
    let range = format!("{start}:*");

    // 1) Elenco UID + flag (leggero).
    let flags: Vec<_> = session
        .fetch(&range, "(UID FLAGS)")
        .await
        .context("lettura dei flag fallita")?
        .try_collect()
        .await?;
    let mut current = std::collections::HashMap::new();
    for f in &flags {
        let Some(uid) = f.uid else { continue };
        let flagged = f.flags().any(|x| matches!(x, Flag::Flagged));
        let seen = f.flags().any(|x| matches!(x, Flag::Seen));
        current.insert(uid, (flagged, seen));
    }

    // 2) Scarica l'inizio (32 KB) solo delle mail che non abbiamo ancora.
    let missing: Vec<u32> = current.keys().filter(|u| !cache.cards.contains_key(u)).copied().collect();
    for chunk in missing.chunks(50) {
        let set = chunk.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let fetched: Vec<_> = session
            .uid_fetch(&set, "(UID INTERNALDATE BODY.PEEK[]<0.32768>)")
            .await
            .context("lettura delle mail fallita")?
            .try_collect()
            .await?;
        for f in fetched {
            let Some(uid) = f.uid else { continue };
            let date = f.internal_date().map(|d| d.timestamp()).unwrap_or(0);
            let card = crate::message::parse_card(uid, f.body().unwrap_or_default(), false, false, date);
            cache.cards.insert(uid, card);
        }
    }

    cache.cards.retain(|uid, _| current.contains_key(uid));
    let mut cards: Vec<_> = cache
        .cards
        .values_mut()
        .map(|c| {
            let (flagged, seen) = current[&c.uid];
            c.flagged = flagged;
            c.seen = seen;
            c.clone()
        })
        .collect();
    // Prima le mail con pin, poi dalla più recente.
    cards.sort_by(|a, b| b.flagged.cmp(&a.flagged).then(b.date.cmp(&a.date)));
    Ok(cards)
}

/// Scarica la mail completa per la vista di lettura (senza segnarla come letta).
pub async fn load_message(session: &mut Session, folder: &str, uid: u32) -> Result<crate::message::MessageView> {
    session.select(folder).await.with_context(|| format!("impossibile aprire {folder}"))?;
    let fetched: Vec<_> = session
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
        .await
        .context("lettura della mail fallita")?
        .try_collect()
        .await?;
    let raw = fetched
        .iter()
        .find_map(|f| f.body())
        .ok_or_else(|| anyhow!("la mail non esiste più (spostata da un altro programma?)"))?;
    Ok(crate::message::parse_view(raw))
}

/// Sposta una mail: MOVE se il server lo supporta, altrimenti COPY + \Deleted + EXPUNGE.
pub async fn move_message(session: &mut Session, caps: ServerCaps, from: &str, uid: u32, to: &str) -> Result<()> {
    session.select(from).await.with_context(|| format!("impossibile aprire {from}"))?;
    let set = uid.to_string();
    if caps.r#move {
        session.uid_mv(&set, to).await.context("spostamento (MOVE) fallito")?;
        return Ok(());
    }
    session.uid_copy(&set, to).await.context("copia (COPY) fallita")?;
    let _: Vec<_> = session
        .uid_store(&set, "+FLAGS.SILENT (\\Deleted)")
        .await
        .context("marcatura \\Deleted fallita")?
        .try_collect()
        .await?;
    if caps.uidplus {
        let _: Vec<_> = session.uid_expunge(&set).await?.try_collect().await?;
    } else {
        let _: Vec<_> = session.expunge().await?.try_collect().await?;
    }
    Ok(())
}

/// Attiva o disattiva il pin (flag IMAP \Flagged).
pub async fn set_flagged(session: &mut Session, folder: &str, uid: u32, flagged: bool) -> Result<()> {
    session.select(folder).await.with_context(|| format!("impossibile aprire {folder}"))?;
    let op = if flagged { "+FLAGS.SILENT (\\Flagged)" } else { "-FLAGS.SILENT (\\Flagged)" };
    let _: Vec<_> = session
        .uid_store(uid.to_string(), op)
        .await
        .context("modifica del pin fallita")?
        .try_collect()
        .await?;
    Ok(())
}

/// Resta in attesa di novità su una cartella. Torna quando il server segnala
/// un cambiamento oppure dopo `max_wait`. Restituisce la sessione per riusarla.
pub async fn wait_for_change(mut session: Session, folder: &str, max_wait: std::time::Duration) -> Result<Session> {
    session.select(folder).await.with_context(|| format!("impossibile aprire {folder}"))?;
    let mut idle = session.idle();
    idle.init().await.context("IDLE non avviato")?;
    let (wait, _stop) = idle.wait_with_timeout(max_wait);
    wait.await.context("IDLE interrotto")?;
    idle.done().await.context("chiusura IDLE fallita")
}

/// Segna una mail come letta o non letta (flag \Seen).
pub async fn set_seen(session: &mut Session, folder: &str, uid: u32, seen: bool) -> Result<()> {
    session.select(folder).await.with_context(|| format!("impossibile aprire {folder}"))?;
    let op = if seen { "+FLAGS.SILENT (\\Seen)" } else { "-FLAGS.SILENT (\\Seen)" };
    let _: Vec<_> = session
        .uid_store(uid.to_string(), op)
        .await
        .context("modifica letto/non letto fallita")?
        .try_collect()
        .await?;
    Ok(())
}

/// Segna una mail come "risposta inviata" (flag \Answered).
pub async fn set_answered(session: &mut Session, folder: &str, uid: u32) -> Result<()> {
    session.select(folder).await.with_context(|| format!("impossibile aprire {folder}"))?;
    let _: Vec<_> = session
        .uid_store(uid.to_string(), "+FLAGS.SILENT (\\Answered)")
        .await?
        .try_collect()
        .await?;
    Ok(())
}

/// Trova la cartella della posta inviata: quella marcata \Sent dal server,
/// altrimenti per nome (Sent, Inviata, Sent Messages...). Se non c'è, la crea.
pub async fn sent_folder(session: &mut Session) -> Result<String> {
    use async_imap::types::NameAttribute;
    let names: Vec<_> = session
        .list(Some(""), Some("*"))
        .await
        .context("comando LIST fallito")?
        .try_collect()
        .await?;
    if let Some(n) = names.iter().find(|n| n.attributes().iter().any(|a| matches!(a, NameAttribute::Sent))) {
        return Ok(n.name().to_string());
    }
    let delim = names.iter().find_map(|n| n.delimiter()).unwrap_or(".");
    for candidate in ["Sent", "Sent Items", "Inviata", "Posta inviata", "Sent Messages"] {
        for full in [format!("INBOX{delim}{candidate}"), candidate.to_string()] {
            if let Some(n) = names.iter().find(|n| n.name().eq_ignore_ascii_case(&full)) {
                return Ok(n.name().to_string());
            }
        }
    }
    let resolved = resolve_folders(session, &["Sent".to_string()]).await?;
    Ok(resolved.into_iter().next().unwrap())
}

/// Salva una copia della mail inviata nella cartella indicata, già segnata come letta.
pub async fn append_sent(session: &mut Session, folder: &str, raw: &[u8]) -> Result<()> {
    session
        .append(folder, Some("(\\Seen)"), None, raw)
        .await
        .with_context(|| format!("copia in {folder} non riuscita"))
}

/// Una cartella per il menu laterale.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FolderInfo {
    /// Nome completo sul server, es. "INBOX.Clienti.Rossi".
    pub name: String,
    /// Nome da mostrare (ultimo pezzo), es. "Rossi".
    pub label: String,
    /// Livello di annidamento (0 = principale).
    pub depth: usize,
    /// inbox, sent, trash, junk, drafts, archive oppure "".
    pub kind: String,
    /// La cartella può contenere mail (alcune sono solo "contenitori").
    pub selectable: bool,
    pub unseen: Option<u32>,
}

fn folder_kind(name: &str, attrs: &[async_imap::types::NameAttribute<'_>], delim: &str) -> &'static str {
    use async_imap::types::NameAttribute as A;
    for a in attrs {
        match a {
            A::Sent => return "sent",
            A::Trash => return "trash",
            A::Junk => return "junk",
            A::Drafts => return "drafts",
            A::Archive => return "archive",
            _ => {}
        }
    }
    if name.eq_ignore_ascii_case("INBOX") {
        return "inbox";
    }
    let leaf = name.rsplit(delim).next().unwrap_or(name).to_lowercase();
    match leaf.as_str() {
        "sent" | "sent items" | "sent messages" | "inviata" | "posta inviata" => "sent",
        "trash" | "deleted messages" | "deleted items" | "cestino" | "eliminati" => "trash",
        "junk" | "spam" | "posta indesiderata" => "junk",
        "drafts" | "bozze" => "drafts",
        "archive" | "archivio" => "archive",
        _ => "",
    }
}

/// Tutte le cartelle, ordinate ad albero, con il numero di non lette.
pub async fn folder_tree(session: &mut Session) -> Result<Vec<FolderInfo>> {
    use async_imap::types::NameAttribute;
    let names: Vec<_> = session
        .list(Some(""), Some("*"))
        .await
        .context("comando LIST fallito")?
        .try_collect()
        .await?;
    let delim = names.iter().find_map(|n| n.delimiter()).unwrap_or(".").to_string();
    let prefix = format!("INBOX{delim}");
    let mut out: Vec<FolderInfo> = names
        .iter()
        .map(|n| {
            let name = n.name().to_string();
            // Su server con tutto dentro INBOX mostriamo le sottocartelle come principali.
            let shown = name.strip_prefix(&prefix).unwrap_or(&name);
            let depth = shown.matches(delim.as_str()).count();
            FolderInfo {
                label: shown.rsplit(delim.as_str()).next().unwrap_or(shown).to_string(),
                depth,
                kind: folder_kind(&name, n.attributes(), &delim).to_string(),
                selectable: !n.attributes().iter().any(|a| matches!(a, NameAttribute::NoSelect)),
                unseen: None,
                name,
            }
        })
        .collect();
    // INBOX per prima, poi le cartelle speciali, poi le altre in ordine alfabetico.
    // Ogni sottocartella segue la cartella principale a cui appartiene.
    let rank = |k: &str| match k {
        "inbox" => 0,
        "drafts" => 1,
        "sent" => 2,
        "archive" => 3,
        "junk" => 4,
        "trash" => 5,
        _ => 6,
    };
    let path = |f: &FolderInfo| f.name.strip_prefix(&prefix).unwrap_or(&f.name).to_lowercase();
    let root_rank: std::collections::HashMap<String, i32> = out
        .iter()
        .filter(|f| f.depth == 0)
        .map(|f| (path(f), rank(&f.kind)))
        .collect();
    let key = |f: &FolderInfo| {
        let p = path(f);
        let root = p.split(delim.as_str()).next().unwrap_or("").to_string();
        let r = if f.name.eq_ignore_ascii_case("INBOX") { -1 } else { *root_rank.get(&root).unwrap_or(&6) };
        (r, root, p)
    };
    out.sort_by_key(key);
    for f in out.iter_mut().filter(|f| f.selectable) {
        if let Ok(mb) = session.status(&f.name, "(UNSEEN)").await {
            f.unseen = mb.unseen;
        }
    }
    Ok(out)
}

/// Cartella del cestino: quella marcata \Trash dal server, altrimenti per nome.
/// Se non esiste la crea.
pub async fn trash_folder(session: &mut Session) -> Result<String> {
    use async_imap::types::NameAttribute;
    let names: Vec<_> = session.list(Some(""), Some("*")).await?.try_collect().await?;
    if let Some(n) = names.iter().find(|n| n.attributes().iter().any(|a| matches!(a, NameAttribute::Trash))) {
        return Ok(n.name().to_string());
    }
    let delim = names.iter().find_map(|n| n.delimiter()).unwrap_or(".").to_string();
    if let Some(n) = names.iter().find(|n| folder_kind(n.name(), &[], &delim) == "trash") {
        return Ok(n.name().to_string());
    }
    Ok(resolve_folders(session, &["Trash".to_string()]).await?.remove(0))
}
