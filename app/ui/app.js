// Pigeonhole user interface. Talks to the Rust backend through `invoke`.
// The interface is split in files loaded in this order, sharing one global
// scope: app.js (start, login, appearance), board.js, organize.js, reader.js,
// compose.js, settings.js (which starts everything at its end). Code that runs
// while a file loads may only use what earlier files (or itself) define.
const { invoke: tauriInvoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

/// "<Abc@Host>" -> "abc@host": the form used to compare Message-IDs.
const mailId = (id) => (id || "").replace(/^<|>$/g, "").trim().toLowerCase();

// Calls that read the server turn the connection light yellow while they run.
// Part of the error of a browser sign-in that stopped working (see oauth.rs).
const SIGN_IN_AGAIN = "Sign in again";
const SERVER_READS = new Set(["open_board", "load_column", "list_folders", "folder_unseen", "load_all_mail", "search_emails", "flush_queue"]);
// The backend's answer to something it gave up because the account changed.
const LEFT_ACCOUNT = "left this account";
let serverBusy = 0;
function invoke(cmd, args) {
  const call = tauriInvoke(cmd, args).catch((e) => {
    // Nobody is waiting for it any more: the interface is starting again.
    if (String(e) === LEFT_ACCOUNT) return new Promise(() => {});
    if (String(e).includes(SIGN_IN_AGAIN)) askToSignInAgain(String(e));
    throw e;
  });
  if (!SERVER_READS.has(cmd)) return call;
  serverBusy++;
  setSyncStatus();
  const done = () => {
    serverBusy--;
    setSyncStatus();
  };
  call.then(done, done);
  return call;
}

const state = {
  columns: [], // [{ name, folder }]
  cards: {}, // folder -> [card]
  dragging: null, // { folder, uid }
  pendingReload: new Set(), // folders to reload once dragging ends
  reloadTimers: {},
  email: "", // account address
  markReadAfter: 3, // seconds; -1 = never
  signature: "",
  signatureHtml: "",
  senders: [], // extra mailboxes used only to send from
  displayName: "", // sender name of the main account
  accounts: [], // in the order chosen by the user
  accountUnread: {}, // account -> unread Inbox emails, as last seen
  unreadChecked: {}, // account -> when it was last asked
  defaultBcc: "", // addresses added in Bcc of every new email and reply
  loadRemoteImages: false, // load remote images in every email without asking
  onlyUnread: false,
  onlyImportant: false,
  known: new Set(), // addresses you have written to
  allow: [], // "Important only" rules: addresses or @domains always shown
  block: [], // ... never shown
  sameDomain: true, // colleagues of your own domain count as known
  view: null, // null = board; otherwise { folder, label } of the folder opened from the sidebar
  folders: [], // folders for the sidebar
  contacts: [], // [{ name, email }] from the system address book
};

// Local-only preferences (appearance); harmless if lost.
const local = {
  get(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  },
};

// ---------- utilities ----------

function show(screenId) {
  for (const id of ["login", "board-screen", "loading"]) $(id).hidden = id !== screenId;
}

let toastTimer;
/// A message at the bottom. With `action` ({ label, run }) it shows a button
/// (e.g. "Undo") and stays a little longer.
function toast(message, kind = "error", action = null, seconds = null) {
  const el = $("toast");
  el.replaceChildren(el_text(message));
  el.title = "";
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    if (action.primary) b.className = "toast-primary";
    b.addEventListener("click", () => {
      el.hidden = true;
      action.run();
    });
    el.append(b);
  }
  // Closing only takes the message away: what it announces carries on.
  const close = document.createElement("button");
  close.className = "toast-close";
  close.append(icon("close"));
  close.title = "Close";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", () => {
    clearTimeout(toastTimer);
    el.hidden = true;
  });
  el.append(close);
  el.className = "toast" + (kind.startsWith("info") ? " " + kind : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  const ms = seconds ? seconds * 1000 : action ? (state.undoSeconds || 8) * 1000 : kind === "info" ? 2500 : 7000;
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function el_text(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

// ---------- multiple selection ----------

state.selection = new Map(); // "folder/uid" -> { folder, card }
const selKey = (folder, card) => folder + "/" + card.uid;
let lastSelectedEl = null;

function updateSelectionBar() {
  const n = state.selection.size;
  $("selection-bar").hidden = !n;
  $("selection-count").textContent = `${n} selected`;
  for (const c of document.querySelectorAll(".card")) {
    const key = c.dataset.folder + "/" + c.dataset.uid;
    c.classList.toggle("multi-selected", state.selection.has(key));
  }
}

function toggleSelection(members, cardEl) {
  const all = members.every((m) => state.selection.has(selKey(m.folder, m.card)));
  for (const m of members) {
    if (all) state.selection.delete(selKey(m.folder, m.card));
    else state.selection.set(selKey(m.folder, m.card), m);
  }
  lastSelectedEl = cardEl;
  updateSelectionBar();
}

/// Shift-click: everything between the last selected card and this one (same column).
function selectRange(cardEl) {
  const container = cardEl.closest(".cards");
  const cards = [...container.querySelectorAll(".card")];
  const from = lastSelectedEl && container.contains(lastSelectedEl) ? cards.indexOf(lastSelectedEl) : cards.indexOf(cardEl);
  const to = cards.indexOf(cardEl);
  const columnFolder = container.closest(".column").dataset.folder;
  for (const c of cards.slice(Math.min(from, to), Math.max(from, to) + 1)) {
    const list = state.cards[columnFolder] || [];
    const card = list.find((x) => String(x.uid) === c.dataset.uid && (x.__folder || columnFolder) === c.dataset.folder);
    if (card) state.selection.set(c.dataset.folder + "/" + c.dataset.uid, { folder: c.dataset.folder, card });
  }
  lastSelectedEl = cardEl;
  updateSelectionBar();
}

function clearSelection() {
  state.selection.clear();
  lastSelectedEl = null;
  updateSelectionBar();
}

async function markMany(members, seen) {
  const byFolder = new Map();
  for (const m of members) {
    if (m.card.seen !== seen) changeUnseen(m.folder, seen ? -1 : 1);
    seenEverywhere(m.folder, m.card, seen);
    if (!byFolder.has(m.folder)) byFolder.set(m.folder, []);
    byFolder.get(m.folder).push(m.card.uid);
  }
  renderSoon();
  paintFolderCounts();
  try {
    for (const [folder, uids] of byFolder) await invoke("set_seen_many", { folder, uids, seen });
    scheduleFolderCounts();
  } catch (e) {
    toast("Read state not changed: " + e);
    await afterBulkChange();
  }
}

function markAllRead(folder) {
  const members = (state.cards[folder] || []).filter((c) => !c.seen).map((card) => ({ folder: card.__folder || folder, card }));
  if (members.length) markMany(members, true);
}

for (const b of document.querySelectorAll("#selection-bar [data-sel]")) {
  b.addEventListener("click", (ev) => {
    const members = [...state.selection.values()];
    const action = b.dataset.sel;
    // "Move…" keeps the selection until a folder is chosen.
    if (action === "move") {
      ev.stopPropagation();
      const from = new Set(members.map((m) => m.folder));
      return showFolderMenu(b, (to) => {
        clearSelection();
        moveMany(members, to);
      }, from.size === 1 ? [...from][0] : null);
    }
    clearSelection();
    if (action === "clear" || !members.length) return;
    if (action === "read" || action === "unread") return markMany(members, action === "read");
    if (action === "pin") return pinMany(members, !members.every((m) => m.card.flagged), b);
    fileMany(members, action);
  });
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && state.selection.size && $("reader").hidden && ($("composer").hidden || composerMinimized()) && $("settings").hidden) clearSelection();
});

// ---------- calendar invitations ----------

function icsDate(t) {
  if (!t?.date) return null;
  const [y, m, d] = t.date.split("-").map(Number);
  if (!t.time) return { date: new Date(y, m - 1, d), allDay: true };
  const [hh, mm] = t.time.split(":").map(Number);
  return { date: t.utc ? new Date(Date.UTC(y, m - 1, d, hh, mm)) : new Date(y, m - 1, d, hh, mm), allDay: false };
}

function describeWhen(inv) {
  const s = icsDate(inv.start);
  if (!s) return "";
  const e = icsDate(inv.end);
  const day = s.date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (s.allDay) return day + " (all day)";
  const time = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const sameDay = e && e.date.toDateString() === s.date.toDateString();
  return `${day}, ${time(s.date)}${e ? " – " + (sameDay ? time(e.date) : e.date.toLocaleString()) : ""}`;
}

function renderInvite(inv) {
  const box = $("reader-invite");
  box.hidden = !inv;
  if (!inv) return;
  const cancelled = inv.method === "CANCEL";
  const isReply = inv.method === "REPLY";
  $("invite-title").textContent = (cancelled ? "Cancelled: " : isReply ? "Answer to: " : "") + (inv.summary || "Calendar event");
  $("invite-when").textContent = describeWhen(inv);
  const organizer = inv.organizer_name || inv.organizer;
  $("invite-where").textContent = [inv.location && "📍 " + inv.location, organizer && "Organizer: " + organizer].filter(Boolean).join(" · ");
  for (const b of box.querySelectorAll("[data-rsvp]")) {
    b.hidden = cancelled || isReply || !inv.organizer;
    b.classList.remove("chosen");
  }
}

for (const b of document.querySelectorAll("#reader-invite [data-rsvp]")) {
  b.addEventListener("click", async () => {
    const { folder, card } = readerCard;
    const response = b.dataset.rsvp;
    b.disabled = true;
    try {
      await invoke("respond_invite", { folder, uid: card.uid, response });
      for (const x of document.querySelectorAll("#reader-invite [data-rsvp]")) x.classList.toggle("chosen", x === b);
      toast({ ACCEPTED: "Accepted", TENTATIVE: "Answered “maybe”", DECLINED: "Declined" }[response] + " — the organizer has been told", "info");
    } catch (e) {
      toast("Could not send the answer: " + e);
    } finally {
      b.disabled = false;
    }
  });
}

$("invite-add").addEventListener("click", async () => {
  const { folder, card } = readerCard;
  try {
    await invoke("add_to_calendar", { folder, uid: card.uid });
  } catch (e) {
    toast("Could not open the calendar: " + e);
  }
});

// ---------- spam and emptying ----------

async function emptyFolder(kind) {
  const name = kind === "trash" ? "Trash" : "Junk";
  const choice = await ask(`Permanently delete every email in ${name}? This cannot be undone.`, [
    { label: "Cancel", value: null },
    { label: `Empty ${name}`, value: "yes", kind: "danger" },
  ]);
  if (choice !== "yes") return;
  try {
    const n = await invoke("empty_folder", { kind });
    toast(`${n} email${n === 1 ? "" : "s"} deleted permanently`, "info");
  } catch (e) {
    toast(`Could not empty ${name}: ${e}`);
  }
  await afterBulkChange();
}

// ---------- undo ----------

/// After a move: "Undo" puts the emails back where they were.
/// `moves`: [{ message_id, now, back }] (emails without Message-ID cannot be undone).
function offerUndo(message, moves) {
  const undoable = moves.filter((m) => m.message_id && m.now && m.back && m.now !== m.back);
  if (!undoable.length || state.undoSeconds === 0) return toast(message, "info");
  // Moving several emails at once is easier to regret: the Undo stays longer.
  const seconds = undoable.length > 1 ? Math.max(state.undoSeconds || 8, 15) : null;
  toast(message, undoable.length > 1 ? "info wide" : "info", {
    label: "Undo",
    run: async () => {
      let failed = 0;
      for (const m of undoable) {
        try {
          await invoke("undo_move", { messageId: m.message_id, nowIn: m.now, backTo: m.back });
        } catch (e) {
          failed++;
          console.error(e);
        }
      }
      toast(failed ? `${failed} of ${undoable.length} could not be restored` : "Restored", failed ? "error" : "info");
      await afterBulkChange(undoable.flatMap((m) => [m.now, m.back]));
    },
  }, seconds);
}

// ---------- appearance ----------

// A theme of one's own is a color: every tone is worked out from it in OKLCH, where
// equal steps of lightness look equal, and text is moved until it is readable.
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const hexChannels = (hex) => [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));

function hexToOklch(hex) {
  const [r, g, b] = hexChannels(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, C: Math.hypot(A, B), H: Math.atan2(B, A) };
}

function oklchToLinear({ L, C, H }) {
  const A = C * Math.cos(H);
  const B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/// Less saturated until the screen can show it.
function oklchToHex(color) {
  let c = color;
  let rgb = oklchToLinear(c);
  while (rgb.some((v) => v < -0.0005 || v > 1.0005) && c.C > 0) rgb = oklchToLinear((c = { ...c, C: c.C - 0.004 }));
  return "#" + rgb.map((v) => Math.round(linearToSrgb(Math.min(1, Math.max(0, v))) * 255).toString(16).padStart(2, "0")).join("");
}

function contrast(a, b) {
  const luminance = (hex) => {
    const [r, g, b] = hexChannels(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/// The color moved just enough in lightness to be readable on `surface`.
function readableOn(surface, color, lighter) {
  const c = { ...color };
  for (let i = 0; i < 60 && contrast(oklchToHex(c), surface) < 4.5; i++) c.L += lighter ? 0.01 : -0.01;
  return oklchToHex(c);
}

/// "custom:#e0683c:dark:tinted" as stored in the settings.
function parseCustomTheme(theme) {
  const [name, color, mode, tint] = (theme || "").split(":");
  if (name !== "custom" || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  return { color, mode: mode === "light" ? "light" : "dark", tint: tint === "tinted" ? "tinted" : "neutral" };
}

function customThemeVars({ color, mode, tint }) {
  const dark = mode === "dark";
  const base = hexToOklch(color);
  const tinted = tint === "tinted";
  const tone = (L, C = dark ? 0.022 : 0.016) => oklchToHex({ L, C: tinted ? C : 0, H: base.H });
  const card = dark ? tone(0.265) : "#ffffff";
  const accent = dark && base.L < 0.45 ? oklchToHex({ ...base, L: 0.6 }) : color;
  return {
    "--bg": tone(dark ? 0.19 : 0.965),
    "--panel": tone(dark ? 0.225 : 0.935),
    "--card": card,
    "--text": tone(dark ? 0.95 : 0.24, 0.006),
    "--muted": tone(dark ? 0.72 : 0.48, 0.01),
    "--border": tone(dark ? 0.34 : 0.88),
    "--accent": accent,
    "--accent-text": contrast(accent, "#ffffff") >= 3.2 ? "#ffffff" : tone(0.2, 0.01),
    "--accent-ink": readableOn(card, hexToOklch(accent), dark),
    "--pin": dark ? "#f0a43a" : "#b86a06",
    "--pinned-bg": dark ? "#3a3021" : "#fff6e5",
    "--error": dark ? "#f97066" : "#b42318",
    "--drop": `color-mix(in srgb, ${accent} ${dark ? 26 : 16}%, transparent)`,
    "color-scheme": mode,
  };
}
let customThemeNames = [];

/// Theme ("system", "light", "dark") and interface size (percent).
/// Theme, size and preview lines: { theme, zoom, preview_board, preview_list }.
function applyAppearance(a) {
  const root = document.documentElement;
  const custom = parseCustomTheme(a.theme);
  for (const name of customThemeNames) root.style.removeProperty(name);
  customThemeNames = [];
  delete root.dataset.customMode;
  if (custom) {
    root.dataset.theme = "custom";
    root.dataset.customMode = custom.mode;
    const vars = customThemeVars(custom);
    customThemeNames = Object.keys(vars);
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  } else if (a.theme && a.theme !== "system") root.dataset.theme = a.theme;
  else delete root.dataset.theme;
  root.style.zoom = String((a.zoom || 100) / 100);
  root.dataset.previewBoard = String(a.preview_board ?? 2);
  root.dataset.previewList = String(a.preview_list ?? 1);
  root.dataset.compactActions = String(a.compact_actions ?? true);
  root.dataset.mailSurface = a.mail_surface || "light";
  local.set("appearance", JSON.stringify(a));
  // Each account's own look, ready for the next switch to it.
  if (state?.accountId) local.set("appearance:" + state.accountId, JSON.stringify(a));
}
try {
  const a = JSON.parse(localStorage.getItem("appearance") || "null");
  if (a) applyAppearance(a);
} catch (_) {}

/// The appearance chosen in the settings dialog (previewed before saving).
function appearanceFromForm() {
  const theme = $("set-theme").value;
  $("custom-theme").hidden = theme !== "custom";
  return {
    theme: theme === "custom" ? `custom:${$("set-theme-color").value}:${$("set-theme-mode").value}:${$("set-theme-tint").value}` : theme,
    zoom: parseInt($("set-zoom").value, 10),
    preview_board: parseInt($("set-preview-board").value, 10),
    preview_list: parseInt($("set-preview-list").value, 10),
    compact_actions: $("set-compact").checked,
    mail_surface: $("set-mail-surface").value,
    theme_per_account: $("set-theme-per-account").checked,
  };
}

function formatDate(ts, long = false) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  if (long) return d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/// An SVG line icon from the sprite in index.html.
function icon(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", ("icon " + className).trim());
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

let syncText = "";
/// The connection light: green when connected, yellow while the server is being read,
/// red when offline. The text shows only when something needs attention.
function setSyncStatus(text) {
  if (text !== undefined) syncText = text;
  const level = state.offline || /not connected/i.test(syncText) ? "off" : serverBusy || /updating/i.test(syncText) ? "busy" : "on";
  const waiting = state.queued ? `${state.queued} change${state.queued === 1 ? "" : "s"} waiting for the connection` : "";
  const full = [level === "busy" ? "Updating…" : syncText, waiting].filter(Boolean).join(" · ");
  $("sync").dataset.level = level;
  $("sync").title = [state.email, full].filter(Boolean).join(" · ");
  $("sync-status").textContent = level === "off" ? full : waiting;
}

/// The error means the server could not be reached (not that it refused).
function isOfflineError(e) {
  return /offline|no answer|did not answer|cannot reach|timed out|connection|broken pipe|network|tls|dns|os error|unexpected eof/i.test(String(e));
}

state.queued = 0;
let offlineTimer = null;
/// No connection: keep working on the copy on this Mac and try again regularly.
function goOffline() {
  if (!state.offline) {
    state.offline = true;
    toast("No connection to the server: showing the emails on this Mac. Changes are sent when it is back.", "info");
  }
  setSyncStatus("Offline · emails on this Mac");
  invoke("queue_count").then((n) => {
    state.queued = n;
    setSyncStatus();
  }).catch(() => {});
  clearTimeout(offlineTimer);
  offlineTimer = setTimeout(() => openBoard({ fromCache: true, retry: true }), 30_000);
}

// ---------- startup and login ----------

async function start() {
  show("loading");
  state.browserSignIn = await invoke("oauth_providers").catch(() => []);
  setLoginProvider("other");
  try {
    const status = await invoke("get_status");
    if (status.configured) {
      setAccount(status);
      flashAccountAfterSwitch();
      const fromCache = showCachedBoard();
      showOpenedFiles();
      await openBoard({ fromCache });
    } else {
      prepareLogin(status);
      show("login");
    }
  } catch (e) {
    show("login");
    showLoginError(String(e));
  }
}

/// The badge of an account: its chosen icon and color, otherwise its initial.
function accountBadge(a, account) {
  setAvatar(a, account.email);
  if (account.icon) a.textContent = account.icon;
  if (account.color) a.style.background = account.color;
  return a;
}

const readLocal = (key, fallback) => {
  try {
    return JSON.parse(local.get(key)) || fallback;
  } catch (_) {
    return fallback;
  }
};

const currentAccount = () => state.accounts.find((a) => a.id === state.accountId) || { id: state.accountId, email: state.email };
const severalAccounts = () => state.accounts.length > 1;

function sortAccounts(accounts) {
  const order = readLocal("accountOrder", []);
  const rank = (a) => (order.includes(a.id) ? order.indexOf(a.id) : order.length);
  return [...accounts].sort((a, b) => rank(a) - rank(b));
}

/// Reads the accounts again; until then the list remembered from last time is shown.
async function loadAccounts() {
  const accounts = await invoke("list_accounts").catch(() => null);
  if (!accounts) return;
  state.accounts = sortAccounts(accounts);
  local.set("accounts", JSON.stringify(state.accounts));
  paintAccount();
}

/// The account in use, shown in the top bar.
function setAccount({ id, email }) {
  state.accountId = id;
  state.email = email;
  state.accounts = readLocal("accounts", []);
  ({ unread: state.accountUnread = {}, checked: state.unreadChecked = {} } = readLocal("accountCounts", {}));
  paintAccount();
  loadAccounts();
}

/// Everything that shows which account is in use.
function paintAccount() {
  const account = currentAccount();
  renderAccountRail();
  const root = document.documentElement.style;
  if (severalAccounts()) root.setProperty("--account-color", account.color || avatarColor(account.email));
  else root.removeProperty("--account-color");
  const title = severalAccounts() ? `Pigeonhole — ${account.label || account.email}` : "Pigeonhole";
  invoke("set_window_title", { title }).catch(() => {});
}

/// Moving to another account starts the interface again, so nothing may be in progress.
function canLeaveAccount() {
  if ($("composer").hidden && !state.sending) return true;
  toast(state.sending ? "Wait for the email to be sent first." : "Send or close the email you are writing first.");
  return false;
}

async function switchAccount(id) {
  if (!canLeaveAccount()) return;
  for (const b of $("account-rail").children) b.classList.toggle("here", b.dataset.id === id);
  local.set("accountSwitched", "1");
  // The count of the account left is right as it is: asking its server again
  // at once would only risk an older number.
  state.unreadChecked[state.accountId] = Date.now();
  setAccountUnread(state.accountId, inboxUnread());
  // The next account's look from the first frame, when it has its own.
  const look = local.get("appearance:" + id);
  if (look && state.appearance?.theme_per_account) local.set("appearance", look);
  await invoke("switch_account", { id }).catch((e) => console.error(e));
  location.reload();
}

/// After a switch the new account shows itself for a moment.
function flashAccountAfterSwitch() {
  if (!local.get("accountSwitched")) return;
  local.set("accountSwitched", "");
  const account = currentAccount();
  const flash = el("div", "account-flash");
  flash.append(accountBadge(el("span", "avatar"), account), el("span", "", account.label || account.email));
  flash.addEventListener("animationend", () => flash.remove());
  document.body.append(flash);
}

/// The login screen, this time for one more mailbox.
function setAddingAccount(on) {
  state.addingAccount = on;
  $("login-cancel").hidden = !on;
  $("login-intro").textContent = on ? "Connect another mailbox. It gets its own board, signature and rules." : "Connect your mailbox. The password is stored in the system keychain.";
  for (const id of ["login-email", "login-server", "login-username", "login-password"]) $(id).value = "";
  setLoginProvider("other");
  showLoginError("");
}

$("login-cancel").addEventListener("click", () => {
  setAddingAccount(false);
  show("board-screen");
});

const shownAccounts = () => (state.accounts.length ? state.accounts : [currentAccount()]);

/// The accounts as a row in the top bar: a click moves to one, a right
/// click changes how it appears, and dragging puts them in another order.
function renderAccountRail() {
  const rail = $("account-rail");
  if (state.railDragging) return;
  const add = el("button", "rail-add");
  add.append(icon("plus"));
  add.title = "Add account";
  add.setAttribute("aria-label", "Add account");
  add.addEventListener("click", startAddingAccount);
  rail.replaceChildren(...shownAccounts().map(railAccount), add);
}

const isTwin = (account) => state.accounts.filter((a) => a.email === account.email).length > 1;

function railAccount(account) {
  const name = account.label || account.email;
  const b = el("button", "rail-account");
  b.classList.toggle("here", account.id === state.accountId);
  b.dataset.id = account.id;
  b.title = [account.label, account.email, isTwin(account) && account.server].filter(Boolean).join(" · ");
  b.setAttribute("aria-label", name);
  b.draggable = true;
  b.append(accountBadge(el("span", "avatar"), account));
  const count = state.accountUnread[account.id];
  if (count) b.append(el("span", "rail-count", count > 99 ? "99+" : String(count)));
  b.addEventListener("click", () => {
    if (account.id !== state.accountId) switchAccount(account.id);
  });
  b.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    openSettings(account.id);
  });
  b.addEventListener("dragstart", (ev) => {
    state.railDragging = account.id;
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", name);
  });
  b.addEventListener("dragover", (ev) => {
    if (!state.railDragging) return;
    ev.preventDefault();
    b.classList.add("drop-before");
  });
  b.addEventListener("dragleave", () => b.classList.remove("drop-before"));
  b.addEventListener("drop", (ev) => {
    ev.preventDefault();
    moveAccountBefore(state.railDragging, account.id);
  });
  b.addEventListener("dragend", () => {
    state.railDragging = null;
    renderAccountRail();
  });
  return b;
}

function moveAccountBefore(id, before) {
  const moved = state.accounts.find((a) => a.id === id);
  if (!moved || id === before) return;
  const others = state.accounts.filter((a) => a !== moved);
  others.splice(others.findIndex((a) => a.id === before), 0, moved);
  state.accounts = others;
  local.set("accountOrder", JSON.stringify(others.map((a) => a.id)));
  local.set("accounts", JSON.stringify(others));
}

function startAddingAccount() {
  closeConvMenu();
  if (!canLeaveAccount()) return;
  setAddingAccount(true);
  show("login");
}

const UNREAD_CHECK_MS = 60_000;
const OTHER_ACCOUNTS_CHECK_MS = 120_000;

function setAccountUnread(id, count) {
  state.accountUnread[id] = count;
  local.set("accountCounts", JSON.stringify({ unread: state.accountUnread, checked: state.unreadChecked }));
  renderAccountRail();
}

/// The unread Inbox emails of another account, which take a short connection.
async function askAccountUnread(id) {
  if (Date.now() - (state.unreadChecked[id] || 0) < UNREAD_CHECK_MS) return;
  state.unreadChecked[id] = Date.now();
  const count = await invoke("account_unread", { id }).catch(() => null);
  if (count === null) delete state.unreadChecked[id];
  else setAccountUnread(id, count);
}

/// Only while the window is in view: nobody reads the numbers otherwise.
function checkOtherAccounts() {
  if (document.hidden || state.offline) return;
  for (const a of state.accounts) if (a.id !== state.accountId) askAccountUnread(a.id);
}

setInterval(checkOtherAccounts, OTHER_ACCOUNTS_CHECK_MS);
document.addEventListener("visibilitychange", checkOtherAccounts);

const ACCOUNT_ICONS = ["🏠", "💼", "🏢", "🎓", "🛒", "🧾", "✈️", "❤️", "⭐", "🔒", "🌍", "📰", "⚽", "🎵", "🐾"];

/// The accounts in the settings, each opening on its label, icon and color.
function renderAccountLooks(openId) {
  $("account-looks").replaceChildren(
    ...shownAccounts().map((account) => {
      const row = el("details", "look-account");
      row.name = "account-look";
      row.open = account.id === openId;
      const badge = el("span", "avatar");
      const name = el("span", "look-name");
      const summary = el("summary");
      summary.append(badge, name);
      const paint = () => {
        accountBadge(badge, account);
        name.textContent = account.label || account.email;
        const detail = [account.label && account.email, isTwin(account) && account.server].filter(Boolean).join(" · ");
        if (detail) name.append(el("small", "", detail));
      };
      paint();
      row.append(summary, accountLookEditor(account, paint));
      return row;
    }),
  );
}

/// Chooses the label, icon and color of an account; every change is saved at once.
function accountLookEditor(account, painted) {
  const box = el("div", "look-editor");
  const typed = el("input");
  const label = el("input");
  const icons = el("div", "look-grid");
  const colors = el("div", "look-grid");
  const choice = (parent, key, value, content) => {
    const b = el("button");
    b.type = "button";
    b.dataset.value = value ?? "";
    content(b);
    b.addEventListener("click", () => change({ [key]: value }));
    parent.append(b);
  };
  const paint = () => {
    for (const [grid, value] of [[icons, account.icon], [colors, account.color]]) {
      for (const b of grid.children) b.classList.toggle("selected", b.dataset.value === (value ?? ""));
    }
    if (document.activeElement !== typed) typed.value = ACCOUNT_ICONS.includes(account.icon) ? "" : account.icon || "";
    painted();
  };
  const change = (part) => {
    Object.assign(account, part);
    paint();
    const look = { icon: account.icon || null, color: account.color || null, label: account.label || null };
    invoke("set_account_look", { id: account.id, look }).catch((e) => toast(String(e)));
    local.set("accounts", JSON.stringify(state.accounts));
    paintAccount();
  };

  choice(icons, "icon", null, (b) => {
    b.textContent = (account.email[0] || "?").toUpperCase();
    b.title = "The initial";
  });
  for (const emoji of ACCOUNT_ICONS) choice(icons, "icon", emoji, (b) => (b.textContent = emoji));
  choice(colors, "color", null, (b) => {
    b.append(icon("refresh"));
    b.title = "Automatic color";
  });
  for (const color of AVATAR_COLORS) choice(colors, "color", color, (b) => (b.style.background = color));

  typed.placeholder = "Or type an emoji or two letters";
  typed.setAttribute("aria-label", "Your own icon");
  typed.addEventListener("input", () => {
    const parts = [...new Intl.Segmenter().segment(typed.value.trim())].slice(0, 2);
    change({ icon: parts.map((p) => p.segment).join("") || null });
  });

  label.placeholder = "Label, such as Work";
  label.maxLength = 30;
  label.value = account.label || "";
  label.setAttribute("aria-label", "Label of the account");
  label.addEventListener("input", () => change({ label: label.value.trim() || null }));

  box.append(label, icons, colors, typed);
  paint();
  return box;
}

function showLoginError(msg) {
  $("login-error").textContent = msg;
  $("login-error").hidden = !msg;
}

$("login-email").addEventListener("change", () => {
  const server = $("login-server");
  const domain = $("login-email").value.split("@")[1];
  if (domain && !server.value) server.value = "mail." + domain;
});

// What each mail service asks for. `browser`: the words on its sign-in button.
const LOGIN_SERVICES = {
  other: { help: "", password: "Password" },
  icloud: {
    server: "imap.mail.me.com",
    help: "iCloud needs an app-specific password, not your Apple Account password.",
    link: ["Create an app-specific password", "https://account.apple.com/account/manage"],
    password: "App-specific password",
    username: true,
  },
  gmail: {
    server: "imap.gmail.com",
    help: "Gmail needs an app password, available once 2-Step Verification is on. Work accounts may not have it.",
    link: ["Create an app password", "https://myaccount.google.com/apppasswords"],
    password: "App password",
    browser: "Sign in with Google",
  },
  microsoft: {
    server: "outlook.office365.com",
    help: "Microsoft 365 and Outlook.com use your browser to sign in: the app never sees your password.",
    browser: "Sign in with Microsoft",
    browserOnly: true,
  },
};

state.loginProvider = "other";
state.browserSignIn = []; // services this build can sign in to
let signingIn = false;

function setLoginProvider(name) {
  const service = LOGIN_SERVICES[name] || LOGIN_SERVICES.other;
  state.loginProvider = LOGIN_SERVICES[name] ? name : "other";
  for (const b of $("login-providers").children) b.setAttribute("aria-pressed", String(b.dataset.provider === state.loginProvider));
  const can = state.browserSignIn.includes(state.loginProvider);
  const missing = service.browserOnly && !can;
  $("login-help").textContent = missing ? "This copy of Pigeonhole was built without a Microsoft application id, so it cannot sign in to Microsoft mailboxes." : service.help;
  $("login-help").hidden = !$("login-help").textContent;
  $("login-help-link").hidden = !service.link;
  $("login-help-link").textContent = service.link?.[0] || "";
  $("login-server-row").hidden = !!service.server;
  $("login-server").required = !service.server;
  if (service.server) $("login-server").value = service.server;
  else if (Object.values(LOGIN_SERVICES).some((s) => s.server === $("login-server").value)) $("login-server").value = "";
  $("login-username-row").hidden = !service.username;
  $("login-password-row").hidden = !!service.browserOnly;
  $("login-password").required = !service.browserOnly;
  $("login-password-label").textContent = service.password || "Password";
  $("login-email").required = !service.browserOnly;
  $("login-submit").hidden = !!service.browserOnly;
  $("login-oauth").disabled = !can;
  $("login-oauth").hidden = !service.browser || (!can && !service.browserOnly);
  $("login-oauth").className = service.browserOnly ? "primary" : "";
  $("login-oauth").textContent = service.browser || "";
  showLoginError("");
}

for (const b of $("login-providers").children) b.addEventListener("click", () => setLoginProvider(b.dataset.provider));
$("login-help-link").addEventListener("click", () => {
  const link = LOGIN_SERVICES[state.loginProvider].link;
  if (link) invoke("open_url", { url: link[1] }).catch((e) => showLoginError(String(e)));
});

/// Fills the login screen for the account in `status`.
function prepareLogin(status) {
  if (status.server) $("login-server").value = status.server;
  setLoginProvider(status.provider || "other");
  if (status.email) $("login-email").value = status.email;
}

/// The browser sign-in of the account in use stopped working (revoked, or expired).
let askedToSignIn = false;
async function askToSignInAgain(message) {
  if (askedToSignIn) return;
  askedToSignIn = true;
  prepareLogin(await tauriInvoke("get_status").catch(() => ({})));
  show("login");
  showLoginError(message);
}

async function browserSignIn() {
  const btn = $("login-oauth");
  if (signingIn) return invoke("cancel_sign_in");
  showLoginError("");
  signingIn = true;
  const label = btn.textContent;
  btn.textContent = "Waiting for the browser… Cancel";
  try {
    await invoke("oauth_sign_in", {
      provider: state.loginProvider,
      email: $("login-email").value,
      add: !!state.addingAccount,
    });
    if (state.addingAccount) return location.reload();
    askedToSignIn = false;
    setAccount(await invoke("get_status"));
    await openBoard();
  } catch (e) {
    if (String(e) !== "cancelled") showLoginError(String(e));
  } finally {
    signingIn = false;
    btn.textContent = label;
  }
}

$("login-oauth").addEventListener("click", browserSignIn);

$("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (LOGIN_SERVICES[state.loginProvider].browserOnly) return browserSignIn();
  showLoginError("");
  const btn = $("login-submit");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    await invoke("login", {
      server: $("login-server").value,
      email: $("login-email").value,
      username: $("login-username").value,
      password: $("login-password").value,
      add: !!state.addingAccount,
    });
    if (state.addingAccount) return location.reload();
    $("login-password").value = "";
    askedToSignIn = false;
    setAccount(await invoke("get_status"));
    await openBoard();
  } catch (e) {
    showLoginError(String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect";
  }
});

async function showCacheStats() {
  try {
    const s = await invoke("cache_stats");
    $("cache-stats").textContent = `${s.emails.toLocaleString()} emails known, ${s.bodies.toLocaleString()} downloaded (${formatSize(s.bytes)})${s.queued ? ` · ${s.queued} changes waiting` : ""}.`;
  } catch (_) {
    $("cache-stats").textContent = "";
  }
}

$("clear-cache").addEventListener("click", async () => {
  const choice = await ask("Clear the copy of your emails on this Mac? Nothing changes on the server; emails are downloaded again as you use the app. Changes still waiting for the connection are lost.", [
    { label: "Cancel", value: null },
    { label: "Clear", value: "yes", kind: "danger" },
  ]);
  if (choice !== "yes") return;
  try {
    await invoke("clear_cache");
    state.queued = 0;
    setSyncStatus();
    showCacheStats();
    toast("The copy on this Mac was cleared", "info");
  } catch (e) {
    toast("Could not clear it: " + e);
  }
});

$("logout").addEventListener("click", async () => {
  const choice = await ask("Disconnect this account? The password will be removed from the keychain.", [
    { label: "Cancel", value: null },
    { label: "Disconnect", value: "yes", kind: "danger" },
  ]);
  if (choice !== "yes") return;
  cacheClear();
  await invoke("forget_account").catch((e) => toast(String(e)));
  invoke("set_unread_badge", { count: 0 }).catch(() => {});
  if ((await invoke("list_accounts").catch(() => [])).length) return location.reload();
  $("settings").hidden = true;
  state.columns = [];
  state.cards = {};
  state.fresh.clear();
  show("login");
});
