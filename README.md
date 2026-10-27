# KanbanMail

A kanban companion for your IMAP mailbox: every board column is an IMAP folder,
and dragging an email from one column to another really moves it on the server.
Written in Rust with [Tauri](https://tauri.app).

> Status: **in development**.

## Features

- First-run setup (server, email, password).
- Password stored in the operating system keychain, never in plain text.
- Columns defined in a TOML file (display name → IMAP folder); missing folders
  are created.
- Cards show sender, subject, date and a preview.
- Drag & drop between columns moves the email on the server (MOVE, or
  COPY + `\Deleted` + EXPUNGE).
- Pin via the IMAP `\Flagged` flag: 📌 icon on the card; pinned emails stay on top.
- Live updates (IDLE, or polling every 60 s).
- Email reader with images and remote content blocked.
- Sidebar with every folder (Trash, Sent, Junk, subfolders…) and unread counts;
  hide it with ☰ or Ctrl/⌘+B. Click a folder to open it; drop a card on a
  sidebar folder to move it there.
- Quick actions on every card: 🗄 Archive, 🗑 Delete (move to Trash) and 📌 Pin.
  In narrow columns, archive/delete appear on hover.
- Resizable columns: drag the right edge (minimum 160 px); double-click the edge
  to return to automatic width.
- Unread emails highlighted (blue bar and bold), unread count per column and an
  "Unread only" filter.
- An opened email is marked as read after a configurable number of seconds
  (0 = immediately, or never); read/unread can also be toggled by hand.
- Write new emails and reply ("Reply" / "Reply all") in plain text, quoting the
  original message. Sending uses SMTP (port 465 SSL/TLS or 587 STARTTLS, same
  credentials as IMAP) and a copy is saved to the Sent folder.
- Signature added to new emails and replies.
- Address suggestions while writing: from the senders of loaded emails and,
  if enabled, from the system address book (macOS Contacts only for now;
  macOS asks for permission the first time).

## Requirements

- [Rust](https://rustup.rs) (stable)
- Node.js (for the Tauri CLI)
- macOS: Xcode Command Line Tools (`xcode-select --install`)

## Layout

```
crates/kanbanmail-core   shared logic: account, board, keychain, IMAP, SMTP, MIME parsing
crates/kanbanmail-cli    command-line test tool
app/src-tauri            desktop app (Tauri backend)
app/ui                   user interface (HTML/CSS/JS, no external libraries)
```

## Running the app

```bash
cd app
npm install
npx tauri dev
```

To build the installable app (`.app` / `.dmg` on macOS):

```bash
cd app
npx tauri build
```

## Settings

From the ⚙ button on the board: sender name, SMTP server and port, signature,
system address book, seconds before an opened email is marked as read, and
disconnecting the account. They are stored in `account.toml` and
`settings.toml` in the configuration folder.

## Configuring columns

On first run, `board.toml` is created in the configuration folder
(`~/Library/Application Support/KanbanMail` on macOS):

```toml
max_cards_per_column = 200

[[column]]
name = "Inbox"
folder = "INBOX"

[[column]]
name = "Todo"
folder = "Todo"
```

On servers that keep every folder inside `INBOX` (such as SiteGround/Dovecot),
writing `Todo` is enough: the app uses or creates `INBOX.Todo`. You can also
give the full name, e.g. `folder = "INBOX.Waiting"`. Restart the app after
editing.

## Live updates

If the server supports IDLE, the app keeps one connection open per column and
is notified of changes right away (including those made by other clients).
Otherwise it checks every 60 seconds. Some servers limit simultaneous
connections: with many columns and other clients open you may hit that limit.

## Reading safely

Email HTML is sanitized (no scripts, forms or links to external resources) and
shown in an isolated frame that cannot load anything from the network: remote
images (and tracking pixels) stay blocked.

## Command-line tool

```bash
cargo run -p kanbanmail-cli
```

The first time it asks for email, server and password. If login succeeds, it
saves server and email to `account.toml` in the configuration folder and the
password to the keychain. Later runs connect on their own.

Show the board columns and the first emails of each:

```bash
cargo run -p kanbanmail-cli -- board
```

List every folder with its kind and unread count:

```bash
cargo run -p kanbanmail-cli -- folders
```

Test the SMTP login and find the folder that receives sent emails (sends nothing):

```bash
cargo run -p kanbanmail-cli -- smtp
```

Forget the saved account and password:

```bash
cargo run -p kanbanmail-cli -- reset
```

## Not supported yet

Attachments (reading and sending), HTML composing, forwarding, drafts, multiple
accounts.

## License

[MIT](LICENSE)
