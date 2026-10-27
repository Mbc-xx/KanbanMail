# KanbanMail

Un "companion kanban" per la tua casella email IMAP: ogni colonna della board
è una cartella IMAP, e trascinare una mail da una colonna all'altra la sposta
davvero sul server. Scritto in Rust con [Tauri](https://tauri.app).

> Stato: **in sviluppo** (prima versione della board).

## Funzionalità (MVP)

- Configurazione al primo avvio (server, email, password).
- Password salvata nel portachiavi del sistema operativo, mai in chiaro.
- Colonne definite in un file TOML (nome visualizzato → cartella IMAP);
  le cartelle mancanti vengono create.
- Card con mittente, oggetto, data e anteprima.
- Drag & drop tra colonne = spostamento sul server (MOVE, oppure COPY + \Deleted + EXPUNGE).
- Pin tramite il flag IMAP `\Flagged`: icona 📌 sulla card; le mail con pin stanno in cima.
- Aggiornamento automatico (IDLE o polling ogni 60 s).
- Lettura della mail, con immagini e contenuti remoti bloccati.
- Menu laterale con tutte le cartelle (Cestino, Inviata, Spam, sottocartelle…)
  e il numero di non lette; si nasconde con ☰ o Ctrl/⌘+B. Un clic apre la
  cartella; trascinare una card su una cartella del menu ve la sposta.
- "Elimina" sposta la mail nel Cestino.
- Mail non lette evidenziate (barra blu e grassetto), contatore per colonna e
  filtro "Solo non lette".
- Una mail aperta viene segnata come letta dopo un numero di secondi
  configurabile (0 = subito, oppure mai); si può anche segnare a mano letta/non letta.
- Scrittura di nuove mail e risposta ("Rispondi" / "Rispondi a tutti") in testo
  semplice, con citazione del messaggio originale. L'invio usa SMTP (porta 465
  SSL/TLS o 587 STARTTLS, stesse credenziali IMAP) e una copia viene salvata
  nella cartella della posta inviata.
- Firma automatica nelle mail nuove e nelle risposte.
- Suggerimento degli indirizzi mentre scrivi: dai mittenti delle mail caricate
  e, se attivato, dalla rubrica di sistema (per ora solo Contatti di macOS;
  la prima volta macOS chiede il permesso).

## Requisiti

- [Rust](https://rustup.rs) (stabile)
- Node.js (servirà per l'interfaccia della board)
- macOS: Xcode Command Line Tools (`xcode-select --install`)

## Struttura

```
crates/kanbanmail-core   logica condivisa: account, board, portachiavi, IMAP, parsing MIME
crates/kanbanmail-cli    test da riga di comando
app/src-tauri         app desktop (backend Tauri)
app/ui                interfaccia (HTML/CSS/JS, nessuna libreria esterna)
```

## Avviare l'app

```bash
cd app
npm install
npx tauri dev
```

Per creare l'app installabile (`.app` / `.dmg` su macOS):

```bash
cd app
npx tauri build
```

## Impostazioni

Dal pulsante ⚙ nella board: nome del mittente, server e porta SMTP, firma,
uso della rubrica di sistema, secondi dopo cui una mail aperta diventa "letta",
e scollegamento dell'account.
Sono salvate in `account.toml` e `settings.toml` nella cartella di configurazione.

## Configurare le colonne

Al primo avvio viene creato `board.toml` nella cartella di configurazione
(`~/Library/Application Support/KanbanMail` su macOS):

```toml
max_cards_per_column = 200

[[column]]
name = "Inbox"
folder = "INBOX"

[[column]]
name = "Todo"
folder = "Todo"
```

Su server che tengono tutte le cartelle dentro `INBOX` (come SiteGround/Dovecot)
basta scrivere `Todo`: l'app usa o crea `INBOX.Todo`. Si può anche indicare il
nome completo, es. `folder = "INBOX.In Attesa"`. Dopo una modifica, riavvia l'app.

## Aggiornamento automatico

Se il server supporta IDLE, l'app tiene aperta una connessione per colonna e
viene avvisata subito dei cambiamenti (anche quelli fatti da altri programmi).
Altrimenti controlla ogni 60 secondi. Alcuni server limitano le connessioni
simultanee: con molte colonne e altri client aperti potresti raggiungere il limite.

## Sicurezza della lettura

L'HTML delle mail viene ripulito (niente script, moduli o link a risorse esterne)
e mostrato in un riquadro isolato che non può caricare nulla dalla rete:
le immagini remote (e i "pixel spia") restano bloccate.

## Test da riga di comando

```bash
cargo run -p kanbanmail-cli
```

La prima volta chiede email, server e password. Se il login riesce, salva
server ed email in `account.toml` nella cartella di configurazione
(`~/Library/Application Support/KanbanMail` su macOS) e la password nel portachiavi.
Le volte successive si collega da solo.

Per vedere le colonne della board e le prime mail di ognuna:

```bash
cargo run -p kanbanmail-cli -- board
```

Per provare il login SMTP e vedere quale cartella riceve le mail inviate
(senza inviare nulla):

```bash
cargo run -p kanbanmail-cli -- invio
```

Per dimenticare account e password:

```bash
cargo run -p kanbanmail-cli -- reset
```

## Non ancora supportato

Allegati (lettura e invio), scrittura in HTML, inoltro, bozze, più account.

## Licenza

[MIT](LICENSE)
