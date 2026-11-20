// Runs the real interface (app/ui) in jsdom against a fake backend, so its
// logic can be tested without Tauri, a mail server or real mail.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

// The app's timers keep the process alive: every window is closed after its
// test, also when the test failed halfway. An error thrown in the page fails
// the test, even when nothing checked for it.
const openWindows = new Map(); // window -> errors in it
afterEach(() => {
  const errors = [...openWindows.values()].flat();
  for (const w of openWindows.keys()) w.close();
  openWindows.clear();
  if (errors.length) throw new Error("errors in the page:\n" + errors.map((e) => e?.stack || String(e)).join("\n"));
});

const UI = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
const NOW = Math.floor(Date.now() / 1000);

/// A card as the backend sends it, with test defaults.
export function card(uid, fields = {}) {
  return {
    uid,
    from: "Anna Bianchi",
    from_address: "anna@example.com",
    to: "me@example.com",
    subject: "Email " + uid,
    date: NOW - uid * 3600,
    preview: "Preview of email " + uid,
    flagged: false,
    seen: false,
    has_attachments: false,
    message_id: `<m${uid}@example.com>`,
    automated: false,
    thread_refs: [],
    ...fields,
  };
}

const COLUMNS = [
  ["Inbox", "INBOX"],
  ["Todo", "INBOX.Todo"],
  ["Waiting", "INBOX.Waiting"],
  ["Done", "INBOX.Done"],
];

const SETTINGS = {
  email: "me@example.com", display_name: "", smtp_server: "mail.example.com", smtp_port: 465,
  mark_read_after_seconds: 0, signature: "", signature_html: "", use_system_contacts: false,
  load_remote_images: false, important_allow: [], important_block: [], important_same_domain: true,
  default_bcc: "", group_threads: false, folders: [], rules: [], notify: "important", theme: "system",
  zoom: 100, undo_seconds: 8, undo_send_seconds: 5, senders: [],
};

/// The email `read_message` returns for a card.
function message(c) {
  return {
    from: c.from, reply_address: c.from_address, to: c.to, all_recipients: [c.to], cc: "", bcc: "",
    message_id: c.message_id, in_reply_to: c.thread_refs.at(-1) || null, references: c.thread_refs,
    subject: c.subject, date: c.date, text: c.preview, text_main: c.preview,
    html: `<p>${c.preview}</p>`, html_main: `<p>${c.preview}</p>`,
    has_remote_content: false, invite: null, attachments: [],
  };
}

/// A fake backend over `data` ({ folder: [card] }). Every call is recorded in
/// `calls`; `handlers` replace or add commands.
function backend(data, settings, handlers, calls) {
  const find = (folder, uid) => (data[folder] || []).find((c) => c.uid === uid);
  const all = () => Object.entries(data).flatMap(([folder, list]) => list.map((c) => ({ folder, card: { ...c } })));
  const take = (folder, uids) => {
    const moved = (data[folder] || []).filter((c) => uids.includes(c.uid));
    data[folder] = (data[folder] || []).filter((c) => !uids.includes(c.uid));
    return moved;
  };
  const builtIn = {
    oauth_providers: () => [],
    get_status: () => ({ configured: true, id: settings.email, email: settings.email, server: "mail.example.com" }),
    list_accounts: () => [{ id: settings.email, email: settings.email, server: "mail.example.com" }],
    get_settings: () => structuredClone(settings),
    save_settings: ({ settings: s }) => void Object.assign(settings, s),
    open_board: () => ({ columns: COLUMNS.map(([name, folder]) => ({ name, folder })), config_path: "/tmp/board.toml", can_idle: true, limit: 200 }),
    list_folders: () => [["INBOX", "Inbox", "inbox"], ["INBOX.Archive", "Archive", "archive"], ["INBOX.Trash", "Trash", "trash"], ["INBOX.Drafts", "Drafts", "drafts"], ["INBOX.Sent", "Sent", "sent"], ["INBOX.Junk", "Junk", "junk"]]
      .map(([name, label, kind]) => ({ name, label, kind, depth: 0, selectable: true, unseen: (data[name] || []).filter((c) => !c.seen).length })),
    folder_unseen: ({ folders }) => Object.fromEntries(folders.map((f) => [f, (data[f] || []).filter((c) => !c.seen).length])),
    load_column: ({ folder, limit }) => (data[folder] || []).slice(0, limit || 200).map((c) => ({ ...c })),
    cached_column: ({ folder }) => (data[folder] || []).map((c) => ({ ...c })),
    load_all_mail: all,
    cached_all_mail: all,
    read_message: ({ folder, uid }) => message(find(folder, uid) || Object.values(data).flat().find((c) => c.uid === uid)),
    load_thread: () => [],
    local_thread: () => [],
    set_seen: ({ folder, uid, seen }) => { const c = find(folder, uid); if (c) c.seen = seen; return true; },
    set_seen_many: ({ folder, uids, seen }) => { for (const c of data[folder] || []) if (uids.includes(c.uid)) c.seen = seen; return true; },
    set_pin: ({ folder, uid, flagged }) => { const c = find(folder, uid); if (c) c.flagged = flagged; return true; },
    move_card: ({ from, to, uid }) => { (data[to] ||= []).unshift(...take(from, [uid])); return true; },
    move_cards: ({ from, to, uids }) => { (data[to] ||= []).unshift(...take(from, uids)); return true; },
    file_cards: ({ folder, uids, kind }) => { const to = kind === "trash" ? "INBOX.Trash" : kind === "junk" ? "INBOX.Junk" : "INBOX.Archive"; (data[to] ||= []).unshift(...take(folder, uids)); return to; },
    ensure_folder: ({ name }) => name || "INBOX.Archive",
    list_tasks: () => [],
    list_snoozed: () => [],
    known_senders: () => [],
    search_local: () => [],
    take_opened_files: () => [],
    queue_count: () => 0,
    flush_queue: () => 0,
    cache_stats: () => ({ emails: 0, bodies: 0, bytes: 0, queued: 0 }),
    account_unread: () => 0,
    new_message_id: () => "<new@example.com>",
    security_status: () => ({ checked_at: 0, app_version: "test", components: 0, advisories: [], seen: [], auto: false, error: null, unseen: 0, new: [], running: "test" }),
    ...handlers,
  };
  const listeners = {};
  return {
    listeners,
    tauri: {
      core: {
        invoke: async (cmd, args = {}) => {
          calls.push([cmd, structuredClone(args)]);
          const fn = builtIn[cmd];
          return fn ? fn(args) : null;
        },
      },
      event: { listen: async (name, fn) => { listeners[name] = fn; return () => {}; } },
    },
  };
}

/// Browser features jsdom lacks, as harmless stand-ins.
function polyfill(window) {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.Element.prototype.scrollIntoView = function () {};
  window.Element.prototype.scrollTo = function () {};
  window.document.execCommand = () => true;
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
}

/// Opens the app on `data` and waits for the board. Returns helpers to drive it.
export async function openApp({ data = {}, settings = {}, handlers = {} } = {}) {
  const calls = [];
  const errors = [];
  const { tauri, listeners } = backend(data, { ...SETTINGS, ...settings }, handlers, calls);
  const html = readFileSync(join(UI, "index.html"), "utf8")
    .replace(/<link rel="stylesheet"[^>]*>/, "")
    .replace(/<script src="([^"]+)"><\/script>/g, (_, file) => `<script>${readFileSync(join(UI, file), "utf8")}</script>`);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e));
  virtualConsole.on("error", (...args) => errors.push(new Error(args.join(" "))));
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      polyfill(window);
      window.__TAURI__ = tauri;
    },
  });
  const { window } = dom;
  openWindows.set(window, errors);
  window.addEventListener("unhandledrejection", (ev) => errors.push(ev.reason));
  const app = {
    window,
    document: window.document,
    calls,
    errors,
    data,
    /// Evaluates code in the app's global scope, where its `const`s live.
    run: (code) => window.eval(code),
    /// Like run, as plain data (values from the page's realm compare badly).
    get: (code) => JSON.parse(JSON.stringify(window.eval(code)) ?? "null"),
    /// The cards shown in a column: uid -> whether it shows as unread.
    shown: (folder) => Object.fromEntries([...window.eval(`columnEl(${JSON.stringify(folder)})`).querySelectorAll(".card")].map((c) => [c.dataset.uid, c.classList.contains("unseen")])),
    $: (id) => window.document.getElementById(id),
    called: (cmd) => calls.filter(([c]) => c === cmd).map(([, args]) => args),
    emit: (name, payload) => listeners[name]?.({ payload }),
    async until(check, what = "condition", ms = 2000) {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) throw new Error("timed out waiting for " + what);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close: () => window.close(),
  };
  await app.until(() => app.run("state.columns.length") > 0 && !app.$("board").hidden, "the board");
  await app.until(() => app.called("load_column").length >= COLUMNS.length, "the columns");
  await new Promise((r) => setTimeout(r, 50));
  return app;
}
