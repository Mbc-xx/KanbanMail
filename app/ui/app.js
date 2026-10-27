// KanbanMail user interface. Talks to the Rust backend through `invoke`.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

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
function toast(message, kind = "error", action = null) {
  const el = $("toast");
  el.replaceChildren(el_text(message));
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.addEventListener("click", () => {
      el.hidden = true;
      action.run();
    });
    el.append(b);
  }
  el.className = "toast" + (kind === "info" ? " info" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? (state.undoSeconds || 8) * 1000 : kind === "info" ? 2500 : 7000);
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
    m.card.seen = seen;
    if (!byFolder.has(m.folder)) byFolder.set(m.folder, []);
    byFolder.get(m.folder).push(m.card.uid);
  }
  for (const c of visibleColumns()) renderCards(c.folder);
  try {
    for (const [folder, uids] of byFolder) await invoke("set_seen_many", { folder, uids, seen });
  } catch (e) {
    toast("Read state not changed: " + e);
  }
  await afterBulkChange();
}

function markAllRead(folder) {
  const members = (state.cards[folder] || []).filter((c) => !c.seen).map((card) => ({ folder: card.__folder || folder, card }));
  if (members.length) markMany(members, true);
}

for (const b of document.querySelectorAll("#selection-bar [data-sel]")) {
  b.addEventListener("click", () => {
    const members = [...state.selection.values()];
    const action = b.dataset.sel;
    clearSelection();
    if (action === "clear" || !members.length) return;
    if (action === "read" || action === "unread") return markMany(members, action === "read");
    fileMany(members, action);
  });
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && state.selection.size && $("reader").hidden && $("composer").hidden && $("settings").hidden) clearSelection();
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
  toast(message, "info", {
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
      await Promise.all(visibleColumns().map((c) => loadColumn(c.folder)));
      scheduleFolderCounts();
    },
  });
}

// ---------- appearance ----------

/// Theme ("system", "light", "dark") and interface size (percent).
function applyAppearance(theme, zoom) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  root.style.zoom = String((zoom || 100) / 100);
  local.set("appearance", JSON.stringify({ theme, zoom }));
}
try {
  const a = JSON.parse(localStorage.getItem("appearance") || "null");
  if (a) applyAppearance(a.theme, a.zoom);
} catch (_) {}

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

function setSyncStatus(text) {
  $("sync-status").textContent = text;
}

// ---------- startup and login ----------

async function start() {
  show("loading");
  try {
    const status = await invoke("get_status");
    if (status.configured) {
      state.email = status.email;
      $("account-email").textContent = status.email;
      const fromCache = showCachedBoard();
      await openBoard({ fromCache });
    } else {
      if (status.email) $("login-email").value = status.email;
      if (status.server) $("login-server").value = status.server;
      show("login");
    }
  } catch (e) {
    show("login");
    showLoginError(String(e));
  }
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

$("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showLoginError("");
  const btn = $("login-submit");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    await invoke("login", {
      server: $("login-server").value,
      email: $("login-email").value,
      password: $("login-password").value,
    });
    $("login-password").value = "";
    state.email = $("login-email").value.trim();
    $("account-email").textContent = state.email;
    await openBoard();
  } catch (e) {
    showLoginError(String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect";
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
  $("settings").hidden = true;
  state.columns = [];
  state.cards = {};
  show("login");
});

// ---------- board ----------

// ---------- local cache for an instant start ----------

const cacheKey = (k) => `cache:${state.email}:${k}`;

function cacheGet(k) {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(k)) || "null");
  } catch (_) {
    return null;
  }
}

function cacheSet(k, value) {
  try {
    localStorage.setItem(cacheKey(k), JSON.stringify(value));
  } catch (_) {}
}

function cacheClear() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(`cache:${state.email}:`)) localStorage.removeItem(k);
  } catch (_) {}
}

/// Shows the board from the last session right away; fresh data replaces it
/// a moment later. Returns true if there was something to show.
function showCachedBoard() {
  const columns = cacheGet("board");
  if (!columns?.length) return false;
  const settings = cacheGet("settings");
  if (settings) applySettingsState(settings);
  state.columns = columns;
  state.folders = cacheGet("folders") || [];
  $("sidebar").classList.toggle("collapsed", local.get("sidebar") === "hidden");
  state.onlyImportant = local.get("onlyImportant") === "1";
  $("only-important").checked = state.onlyImportant;
  state.view = null;
  renderColumns();
  renderFolders();
  for (const c of columns) {
    state.cards[c.folder] = cacheGet("cards:" + c.folder) || [];
    renderCards(c.folder);
  }
  setSyncStatus("Updating…");
  show("board-screen");
  return true;
}

function applySettingsState(settings) {
  state.markReadAfter = settings.mark_read_after_seconds;
  state.signature = settings.signature;
  state.signatureHtml = settings.signature_html;
  state.defaultBcc = settings.default_bcc;
  state.loadRemoteImages = settings.load_remote_images;
  state.allow = settings.important_allow;
  state.block = settings.important_block;
  state.sameDomain = settings.important_same_domain;
  state.groupThreads = settings.group_threads;
  state.folderPrefs = settings.folders || [];
  state.rules = settings.rules || [];
  state.notify = settings.notify || "important";
  state.undoSeconds = settings.undo_seconds ?? 8;
  applyAppearance(settings.theme, settings.zoom);
}

async function openBoard({ fromCache = false } = {}) {
  if (!fromCache) {
    show("loading");
    $("loading-text").textContent = "Preparing columns…";
  }
  try {
    const info = await invoke("open_board");
    state.columns = info.columns;
    state.defaultLimit = info.limit || 200;
    cacheSet("board", info.columns);
    $("config-path").textContent = info.config_path;
    $("settings-config-path").textContent = info.config_path;
    try {
      const settings = await invoke("get_settings");
      applySettingsState(settings);
      cacheSet("settings", settings);
      if (settings.use_system_contacts) loadContacts();
    } catch (_) {}
    setSyncStatus(info.can_idle ? "Live updates on (IDLE)" : "Refreshing every 60 seconds");
    $("sidebar").classList.toggle("collapsed", local.get("sidebar") === "hidden");
    state.onlyImportant = local.get("onlyImportant") === "1";
    $("only-important").checked = state.onlyImportant;
    state.view = null;
    renderColumns();
    show("board-screen");
    loadFolders();
    loadKnownSenders();
    await Promise.all(state.columns.map((c) => loadColumn(c.folder)));
  } catch (e) {
    if (fromCache) {
      // Keep showing the last known board, and say why it is not updating.
      setSyncStatus("Offline");
      toast("Could not connect to the server: " + e);
      return;
    }
    show("login");
    showLoginError("Could not open the board: " + e);
  }
}

function visibleColumns() {
  return state.view ? [{ name: state.view.label, folder: state.view.folder }] : state.columns;
}

function renderColumns() {
  detachReader();
  const board = $("board");
  board.replaceChildren();
  // Folder view: compact list, a resize handle and the reading pane.
  const split = state.view ? el("div", "folder-split") : null;
  if (split) {
    const saved = parseInt(local.get("listwidth"), 10);
    if (saved >= 280) split.style.setProperty("--list-width", saved + "px");
    board.append(split);
  }
  for (const col of visibleColumns()) {
    const column = el("section", state.view ? "column wide" : "column");
    column.dataset.folder = col.folder;

    const head = el("header", "column-head");
    head.append(el("h2", "", col.name), el("span", "count muted", ""), el("span", "unread", ""), el("span", "folder muted", state.view?.multi ? "" : col.folder));
    const color = folderColor(col.folder);
    if (color) column.style.setProperty("--folder-color", color);
    if (!state.view?.search) {
      const markRead = el("button", "head-btn icon-btn");
      markRead.title = "Mark all as read";
      markRead.append(icon("envelope-open"));
      markRead.hidden = true; // shown when the column has unread emails
      markRead.addEventListener("click", () => markAllRead(col.folder));
      head.append(markRead);
    }
    const emptyKind = folderKind(col.folder);
    if (state.view && (emptyKind === "trash" || emptyKind === "junk")) {
      const empty = el("button", "head-btn danger", emptyKind === "trash" ? "Empty Trash" : "Empty Junk");
      empty.addEventListener("click", () => emptyFolder(emptyKind));
      head.append(empty);
    }
    const cards = el("div", state.view ? "cards rows" : "cards");
    cards.append(el("div", "empty muted", "Loading…"));
    column.append(head);
    if (state.view?.search) column.append(searchOptions());
    column.append(cards);
    if (!state.view) setupResizer(column);
    setupDropTarget(column);
    (split || board).append(column);
  }
  if (split) {
    const handle = el("div", "split-handle");
    handle.title = "Drag to resize the list";
    const pane = el("div", "reader-pane");
    pane.id = "reader-pane";
    split.append(handle, pane);
    showPanePlaceholder();
    setupSplitHandle(split, handle);
  }
}

function showPanePlaceholder() {
  const pane = $("reader-pane");
  if (!pane) return;
  const ph = el("div", "placeholder muted");
  ph.append(icon("envelope"), el("div", "", "Select an email to read it"));
  pane.replaceChildren(ph);
}

function setupSplitHandle(split, handle) {
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add("active");
    document.body.classList.add("resizing");
    const list = split.querySelector(".column");
    const startX = ev.clientX;
    const startW = list.getBoundingClientRect().width;
    const move = (e) => {
      const max = split.getBoundingClientRect().width - 340;
      const w = Math.round(Math.min(max, Math.max(280, startW + e.clientX - startX)));
      split.style.setProperty("--list-width", w + "px");
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.classList.remove("active");
      document.body.classList.remove("resizing");
      local.set("listwidth", String(Math.round(list.getBoundingClientRect().width)));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
}

// ---------- column width ----------

const COL_MIN = 160;
const COL_MAX = 900;

function applyColumnWidth(column, width) {
  if (width) {
    column.style.flex = `0 0 ${width}px`;
    column.classList.add("sized");
  } else {
    column.style.flex = "";
    column.classList.remove("sized");
  }
}

/// Handle on the right edge: drag to resize, double-click to go back to automatic width.
function setupResizer(column) {
  const key = "colwidth:" + column.dataset.folder;
  const saved = parseInt(local.get(key), 10);
  if (saved >= COL_MIN) applyColumnWidth(column, saved);

  const handle = el("div", "col-resizer");
  handle.title = "Drag to resize · double-click for automatic width";
  column.append(handle);

  let lastDown = 0;
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    // Double-click detected by hand: preventDefault can suppress "dblclick".
    if (ev.timeStamp - lastDown < 350) {
      lastDown = 0;
      applyColumnWidth(column, 0);
      try { localStorage.removeItem(key); } catch (_) {}
      return;
    }
    lastDown = ev.timeStamp;
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add("active");
    document.body.classList.add("resizing");
    const startX = ev.clientX;
    const startW = column.getBoundingClientRect().width;
    let moved = false;
    const move = (e) => {
      moved = true;
      const w = Math.round(Math.min(COL_MAX, Math.max(COL_MIN, startW + e.clientX - startX)));
      applyColumnWidth(column, w);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.classList.remove("active");
      document.body.classList.remove("resizing");
      if (moved) local.set(key, String(Math.round(column.getBoundingClientRect().width)));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
}

function columnEl(folder) {
  return [...document.querySelectorAll(".column")].find((c) => c.dataset.folder === folder);
}

async function loadColumn(folder) {
  if (folder === SEARCH_KEY) return runSearch();
  if (folder === ALL_KEY) return loadAllMail();
  try {
    state.cards[folder] = await invoke("load_column", { folder, limit: state.limits[folder] || null });
    renderCards(folder);
    if (state.columns.some((c) => c.folder === folder)) cacheSet("cards:" + folder, state.cards[folder].slice(0, 200));
    if (folder.toUpperCase() === "INBOX") afterInboxLoaded(state.cards[folder]);
  } catch (e) {
    toast(`Could not load ${folder}: ${e}`);
  }
}

// ---------- new Inbox emails: rules and notifications ----------

state.limits = {}; // folder -> how many emails to load ("Load more")
state.defaultLimit = 200;
state.rules = [];
state.notify = "important";
let inboxKnown = null; // UIDs seen in the Inbox so far (null before the first load)
const ruleTried = new Set(); // emails a rule already tried to move

/// The first rule that matches an email, if any.
function ruleFor(card) {
  for (const r of state.rules) {
    const hay = r.field === "to" ? card.to : r.field === "subject" ? card.subject : `${card.from} ${card.from_address}`;
    if (r.contains && r.folder && r.folder.toUpperCase() !== "INBOX" && fold(hay).includes(fold(r.contains))) return r;
  }
  return null;
}

/// Applies the rules to `cards` of the Inbox; returns the emails it moved.
async function applyRules(cards, { announce = true } = {}) {
  const byFolder = new Map();
  for (const card of cards) {
    const key = card.uid + ":" + card.message_id;
    const rule = ruleTried.has(key) ? null : ruleFor(card);
    if (!rule) continue;
    ruleTried.add(key);
    if (!byFolder.has(rule.folder)) byFolder.set(rule.folder, []);
    byFolder.get(rule.folder).push({ folder: "INBOX", card });
  }
  let moves = [];
  for (const [folder, members] of byFolder) moves = moves.concat(await moveMany(members, folder, { quiet: true }));
  if (announce && moves.length) offerUndo(`Rules moved ${moves.length} email${moves.length === 1 ? "" : "s"}`, moves);
  return new Set(moves.map((m) => m.message_id));
}

async function afterInboxLoaded(cards) {
  const first = inboxKnown === null;
  const fresh = first ? [] : cards.filter((c) => !inboxKnown.has(c.uid));
  inboxKnown = new Set(cards.map((c) => c.uid));
  if (!fresh.length) return;
  const moved = await applyRules(fresh);
  const toNotify = fresh.filter(
    (c) => !c.seen && !moved.has(c.message_id) && (state.notify === "all" || (state.notify === "important" && importance(c).important)),
  );
  if (!toNotify.length) return;
  const [title, body] =
    toNotify.length === 1
      ? [toNotify[0].from || toNotify[0].from_address, toNotify[0].subject || "(no subject)"]
      : [`${toNotify.length} new emails`, toNotify.slice(0, 3).map((c) => `${shortName(c.from)}: ${c.subject}`).join("\n")];
  invoke("notify", { title, body }).catch((e) => console.error("notification failed", e));
}

/// Keeps rules and notifications working while the Inbox is not on screen.
async function checkInbox() {
  try {
    const cards = await invoke("load_column", { folder: "INBOX", limit: null });
    state.cards.INBOX = cards;
    afterInboxLoaded(cards);
  } catch (e) {
    console.error(e);
  }
}

/// Reloads a folder after a server notification, batching notifications close together.
function scheduleReload(folder) {
  scheduleFolderCounts();
  if (state.view?.folder === ALL_KEY) folder = ALL_KEY;
  if (!columnEl(folder)) return; // not visible right now
  if (state.dragging) {
    state.pendingReload.add(folder);
    return;
  }
  clearTimeout(state.reloadTimers[folder]);
  state.reloadTimers[folder] = setTimeout(() => loadColumn(folder), 400);
}

function renderCards(folder) {
  const column = columnEl(folder);
  if (!column) return;
  const all = state.cards[folder] || [];
  const unread = all.filter((c) => !c.seen).length;
  column.querySelector(".count").textContent = all.length;
  column.querySelector(".unread").textContent = unread ? `${unread} unread` : "";
  const markRead = column.querySelector(".head-btn.icon-btn");
  if (markRead) markRead.hidden = !unread;
  // Unread only / Important only are board filters: search results show everything found.
  const searching = !!state.view?.search;
  const list = all.filter(
    (c) => searching || ((!state.onlyUnread || !c.seen) && (!state.onlyImportant || importance(c).important) && matchesFilter(c)),
  );
  const container = column.querySelector(".cards");
  container.replaceChildren();
  if (!list.length) {
    if (searching) {
      container.append(el("div", "empty muted", state.view.searchDone ? "No emails found" : "Searching…"));
      return;
    }
    const filtered = all.length && (state.onlyUnread || state.onlyImportant || state.filterWords.length);
    container.append(el("div", "empty muted", filtered ? "No loaded email matches" : "No emails"));
    const text = $("search").value.trim();
    if (text) {
      const go = el("button", "search-all", `Search all folders for “${text}”`);
      go.addEventListener("click", () => startSearch(text));
      container.append(go);
    }
    return;
  }
  // "Load more" when the folder probably has older emails than the ones shown.
  const limit = state.limits[folder] || state.defaultLimit;
  const loadMore = () => {
    if (MULTI_KEYS.includes(folder) || all.length < limit) return null;
    const b = el("button", "load-more", `Load ${state.defaultLimit} more`);
    b.addEventListener("click", () => {
      b.disabled = true;
      b.textContent = "Loading…";
      state.limits[folder] = limit + state.defaultLimit;
      loadColumn(folder);
    });
    return b;
  };
  // Search results and All Mail come from several folders: each card carries its own.
  if (state.groupThreads) {
    for (const g of groupByThread(list, folder)) {
      container.append(renderCard(g.rep.folder, g.rep.card, g.members.length > 1 ? g : null));
    }
  } else {
    for (const card of list) container.append(renderCard(card.__folder || folder, card));
  }
  const more = loadMore();
  if (more) container.append(more);
}

/// Groups cards of a list into conversations (Message-ID, In-Reply-To and
/// References links). Each group: { rep: newest {folder, card}, members: [...] }.
function groupByThread(list, folder) {
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map(); // message id -> index of the first card that mentions it
  const bare = (id) => (id || "").replace(/^<|>$/g, "").trim().toLowerCase();
  list.forEach((card, i) => {
    for (const id of [card.message_id, ...(card.thread_refs || [])].map(bare).filter(Boolean)) {
      if (owner.has(id)) parent[find(i)] = find(owner.get(id));
      else owner.set(id, i);
    }
  });
  const groups = new Map();
  list.forEach((card, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push({ folder: card.__folder || folder, card });
  });
  const out = [...groups.values()].map((members) => {
    members.sort((a, b) => b.card.date - a.card.date);
    return { rep: members[0], members };
  });
  // Pinned conversations first, then the most recent activity.
  out.sort((a, b) => b.members.some((m) => m.card.flagged) - a.members.some((m) => m.card.flagged) || b.rep.card.date - a.rep.card.date);
  return out;
}

function shortName(name) {
  const n = (name || "").trim();
  return n.includes("@") ? n.split("@")[0] : n.split(/\s+/)[0] || n;
}

/// Accent- and case-insensitive text for matching.
function fold(text) {
  return (text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/// The search box filters the loaded cards as you type: every word must appear
/// in the sender, address, subject or preview.
function matchesFilter(card) {
  if (!state.filterWords.length || state.view?.search) return true;
  const hay = fold([card.from, card.from_address, card.subject, card.preview].join(" "));
  return state.filterWords.every((w) => hay.includes(w));
}

/// One email, or a whole conversation when `group` is given (shown through its newest email).
function renderCard(folder, card, group = null) {
  const members = group ? group.members : [{ folder, card }];
  const c = el("div", "card");
  if (members.some((m) => m.card.flagged)) c.classList.add("pinned");
  if (members.some((m) => !m.card.seen)) c.classList.add("unseen");
  c.draggable = true;
  c.dataset.uid = card.uid;
  c.dataset.folder = folder;

  // A conversation shows its participants and how many emails it has.
  const people = [...new Set(members.slice().reverse().map((m) => shortName(m.card.from)))];
  const fromText = group ? people.slice(-3).join(", ") + (people.length > 3 ? "…" : "") : card.from || "(unknown sender)";
  const countBadge = () => {
    const b = el("span", "thread-count", String(members.length));
    b.title = `${members.length} emails in this conversation`;
    return b;
  };
  const anyAttachment = members.some((m) => m.card.has_attachments);
  const fromLine = el("div", "from-line");
  fromLine.append(el("span", "from", fromText));
  if (group) fromLine.append(countBadge());
  if (anyAttachment) fromLine.append(icon("paperclip", "clip"));
  fromLine.append(el("span", "date", formatDate(card.date)));
  const actions = el("div", "card-actions");
  const action = (cls, iconName, title, run) => {
    const b = el("button", "card-btn " + cls);
    b.append(icon(iconName));
    b.title = title;
    b.draggable = false;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      run();
    });
    actions.append(b);
  };
  const kind = folderKind(folder);
  const what = group ? "conversation" : "email";
  if (kind !== "archive") action("archive-btn", "archive", `Archive ${what}`, () => (group ? fileMany(members, "archive") : fileCard(folder, card, "archive")));
  if (kind !== "trash") action("trash-btn", "trash", `Delete ${what} (move to trash)`, () => (group ? fileMany(members, "trash") : fileCard(folder, card, "trash")));
  const pinned = members.some((m) => m.card.flagged);
  action("pin-btn", "pin", pinned ? "Unpin" : "Pin (keep at the top of the column)", () =>
    group ? pinMany(members, !pinned, c) : togglePin(folder, card, c),
  );
  if (state.view) {
    // Compact row for the folder view.
    const main = el("div", "row-main");
    main.append(el("span", "row-subject", card.subject || "(no subject)"), el("span", "row-preview", card.preview ? "  —  " + card.preview : ""));
    const date = el("span", "row-date");
    if (anyAttachment) date.append(icon("paperclip", "clip"));
    date.append(document.createTextNode(formatDate(card.date)));
    if (state.view?.multi) date.prepend(folderTag(folder));
    const from = el("span", "row-from", fromText);
    if (group) from.append(countBadge());
    c.append(from, main, date, actions);
    if (readerCard && readerCard.folder === folder && readerCard.card.uid === card.uid) c.classList.add("selected");
  } else {
    c.append(actions, fromLine, el("div", "subject", card.subject || "(no subject)"), el("div", "preview", card.preview));
  }

  if (members.every((m) => state.selection.has(selKey(m.folder, m.card)))) c.classList.add("multi-selected");
  c.addEventListener("click", (ev) => {
    // ⌘/Ctrl-click toggles the selection, Shift-click selects a range.
    if (ev.metaKey || ev.ctrlKey) return toggleSelection(members, c);
    if (ev.shiftKey) return selectRange(c);
    if (state.selection.size) clearSelection();
    kind === "drafts" ? openDraft(folder, card) : openReader(folder, card);
  });
  c.addEventListener("dragstart", (ev) => {
    // Dragging a selected card drags the whole selection.
    const dragged = state.selection.has(selKey(folder, card)) ? [...state.selection.values()] : members;
    state.dragging = { folder, uid: card.uid, members: dragged };
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", String(card.uid));
    requestAnimationFrame(() => c.classList.add("dragging"));
  });
  c.addEventListener("dragend", () => {
    c.classList.remove("dragging");
    state.dragging = null;
    for (const f of state.pendingReload) scheduleReload(f);
    state.pendingReload.clear();
  });
  return c;
}

function setupDropTarget(column) {
  const folder = column.dataset.folder;
  column.addEventListener("dragover", (ev) => {
    if (!state.dragging || state.dragging.folder === folder) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    column.classList.add("drop-target");
  });
  column.addEventListener("dragleave", (ev) => {
    if (!column.contains(ev.relatedTarget)) column.classList.remove("drop-target");
  });
  column.addEventListener("drop", (ev) => {
    ev.preventDefault();
    column.classList.remove("drop-target");
    const drag = state.dragging;
    if (!drag || drag.folder === folder) return;
    dropDragged(drag, folder);
  });
}

function dropDragged(drag, to) {
  const members = (drag.members || []).filter((m) => m.folder !== to);
  if (members.length > 1) moveMany(members, to);
  else moveCard(drag.folder, drag.uid, to);
}

/// Removes emails from every loaded list right away (optimistic update).
function dropFromLists(members) {
  const gone = new Set(members.map((m) => m.folder + "/" + m.card.uid));
  for (const key of Object.keys(state.cards)) {
    state.cards[key] = state.cards[key].filter((c) => !gone.has((c.__folder || key) + "/" + c.uid));
  }
  for (const c of visibleColumns()) renderCards(c.folder);
}

async function afterBulkChange() {
  await Promise.all(visibleColumns().map((c) => loadColumn(c.folder)));
  scheduleFolderCounts();
}

/// Moves a whole conversation to another folder.
async function moveMany(members, to, { quiet = false } = {}) {
  dropFromLists(members);
  let failed = 0;
  const moves = [];
  for (const m of members) {
    try {
      await invoke("move_card", { from: m.folder, uid: m.card.uid, to });
      moves.push({ message_id: m.card.message_id, now: to, back: m.folder });
    } catch (e) {
      failed++;
      console.error(e);
    }
  }
  if (failed) toast(`${failed} of ${members.length} emails could not be moved`);
  else if (!quiet) offerUndo(`${members.length} emails moved to ${folderLabel(to)}`, moves);
  await afterBulkChange();
  return moves;
}

/// Archives or deletes a whole conversation.
async function fileMany(members, kind) {
  dropFromLists(members);
  let target = "";
  let failed = 0;
  const moves = [];
  for (const m of members) {
    if (folderKind(m.folder) === kind) continue; // already there
    try {
      target = await invoke("file_card", { folder: m.folder, uid: m.card.uid, kind });
      moves.push({ message_id: m.card.message_id, now: target, back: m.folder });
    } catch (e) {
      failed++;
      console.error(e);
    }
  }
  if (failed) toast(`${failed} of ${members.length} emails could not be moved`);
  else offerUndo(`${members.length} email${members.length === 1 ? "" : "s"} moved to ${folderLabel(target || kind)}`, moves);
  await afterBulkChange();
}

async function pinMany(members, pinned, cardEl) {
  cardEl.classList.add("busy");
  for (const m of members) {
    try {
      await invoke("set_pin", { folder: m.folder, uid: m.card.uid, pinned });
    } catch (e) {
      console.error(e);
    }
  }
  await afterBulkChange();
}

async function moveCard(from, uid, to) {
  // Optimistic move: the card changes column immediately, then the server confirms.
  let list = state.cards[from] || [];
  let idx = list.findIndex((c) => c.uid === uid);
  if (idx < 0) {
    // Dragged from the search results or All Mail.
    for (const key of MULTI_KEYS) {
      list = state.cards[key] || [];
      idx = list.findIndex((c) => c.uid === uid && c.__folder === from);
      if (idx >= 0) break;
    }
  }
  if (idx < 0) return;
  const [card] = list.splice(idx, 1);
  const { __folder, ...moved } = card;
  state.cards[to] = [moved, ...(state.cards[to] || [])];
  renderCards(from);
  for (const key of MULTI_KEYS) renderCards(key);
  renderCards(to);
  const movedEl = columnEl(to)?.querySelector(`.card[data-uid="${uid}"]`);
  movedEl?.classList.add("busy");

  try {
    await invoke("move_card", { from, uid, to });
    offerUndo(`Moved to ${folderLabel(to)}`, [{ message_id: card.message_id, now: to, back: from }]);
  } catch (e) {
    toast("Move failed: " + e);
  }
  await Promise.all([from, to].filter((f) => columnEl(f)).map(loadColumn));
  if (state.view?.search) runSearch();
  scheduleFolderCounts();
}

async function togglePin(folder, card, cardEl) {
  const pinned = !card.flagged;
  cardEl.classList.add("busy");
  try {
    await invoke("set_pin", { folder, uid: card.uid, pinned });
  } catch (e) {
    toast("Pin not changed: " + e);
  }
  await loadColumn(folder);
  if (state.view?.search) runSearch();
}

$("only-important").addEventListener("change", (ev) => {
  state.onlyImportant = ev.target.checked;
  local.set("onlyImportant", ev.target.checked ? "1" : "");
  for (const c of visibleColumns()) renderCards(c.folder);
});

// ---------- important senders ----------

const KNOWN_REFRESH_MS = 30 * 60 * 1000;

async function loadKnownSenders() {
  try {
    state.known = new Set(await invoke("known_senders"));
    for (const c of visibleColumns()) renderCards(c.folder);
    if (readerCard) updateSenderPanel();
  } catch (e) {
    console.error("could not read sent emails", e);
  }
}
setInterval(() => state.columns.length && loadKnownSenders(), KNOWN_REFRESH_MS);

function domainOf(address) {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at).toLowerCase() : "";
}

/// The user's own rule for an address: "allow", "block" or null. An address rule wins over a domain rule.
function senderRule(address) {
  const a = address.toLowerCase();
  const d = domainOf(a);
  if (state.block.includes(a)) return { rule: "block", pattern: a };
  if (state.allow.includes(a)) return { rule: "allow", pattern: a };
  if (d && state.block.includes(d)) return { rule: "block", pattern: d };
  if (d && state.allow.includes(d)) return { rule: "allow", pattern: d };
  return null;
}

/// Whether a card passes "Important only", and why (shown in the reader).
function importance(card) {
  const a = (card.from_address || "").toLowerCase();
  const rule = senderRule(a);
  if (rule) return { important: rule.rule === "allow", why: rule.rule === "allow" ? `Your rule: ${rule.pattern} is always important` : `Your rule: ${rule.pattern} is never important` };
  if (card.automated) return { important: false, why: "Automated email (notification, newsletter or mailing list)" };
  if (a && a === state.email.toLowerCase()) return { important: true, why: "Sent by you" };
  if (state.known.has(a)) return { important: true, why: "You have written to this person" };
  if (state.contacts.some((c) => c.email.toLowerCase() === a)) return { important: true, why: "In your contacts" };
  if (state.sameDomain && a && domainOf(a) === domainOf(state.email)) return { important: true, why: "Colleague (same domain as you)" };
  return { important: false, why: "You have never written to this sender" };
}

function updateSenderPanel() {
  const card = readerCard?.card;
  if (!card) return;
  const info = importance(card);
  $("sender-why").textContent = (info.important ? "★ Important — " : "Not important — ") + info.why;
  const rule = senderRule(card.from_address || "");
  $("rule-allow").classList.toggle("active", rule?.rule === "allow");
  $("rule-block").classList.toggle("active", rule?.rule === "block");
  if (rule) $("rule-scope").value = rule.pattern.startsWith("@") ? "domain" : "address";
  const disabled = !card.from_address;
  $("rule-allow").disabled = $("rule-block").disabled = $("rule-scope").disabled = disabled;
}

async function setSenderRule(kind) {
  const card = readerCard?.card;
  if (!card?.from_address) return;
  const current = senderRule(card.from_address);
  const pattern = $("rule-scope").value === "domain" ? domainOf(card.from_address) : card.from_address.toLowerCase();
  // Clicking the active rule again removes it.
  const rule = current && current.rule === kind && current.pattern === pattern ? "none" : kind;
  try {
    [state.allow, state.block] = await invoke("set_sender_rule", { pattern, rule });
    updateSenderPanel();
    for (const c of visibleColumns()) renderCards(c.folder);
    toast(rule === "none" ? `Rule removed for ${pattern}` : `${pattern} is now ${kind === "allow" ? "always" : "never"} important`, "info");
  } catch (e) {
    toast("Rule not saved: " + e);
  }
}

$("rule-allow").addEventListener("click", () => setSenderRule("allow"));
$("rule-block").addEventListener("click", () => setSenderRule("block"));

$("only-unread").addEventListener("change", (ev) => {
  state.onlyUnread = ev.target.checked;
  for (const c of visibleColumns()) renderCards(c.folder);
});

$("refresh").addEventListener("click", () => {
  for (const c of visibleColumns()) loadColumn(c.folder);
  loadFolders();
});

// ---------- sidebar ----------

const FOLDER_ICONS = { inbox: "inbox", drafts: "drafts", sent: "sent", archive: "archive", junk: "junk", trash: "trash" };

async function loadFolders() {
  try {
    state.folders = await invoke("list_folders");
    cacheSet("folders", state.folders);
    renderFolders();
    const inboxUnread = state.folders.find((f) => f.kind === "inbox")?.unseen || 0;
    invoke("set_unread_badge", { count: inboxUnread }).catch(() => {});
  } catch (e) {
    toast("Could not read folders: " + e);
  }
}

let countsTimer;
function scheduleFolderCounts() {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(loadFolders, 3000);
}

// ---------- All Mail ----------

async function loadAllMail() {
  try {
    const entries = await invoke("load_all_mail");
    state.cards[ALL_KEY] = entries.map((e) => ({ ...e.card, __folder: e.folder }));
    renderCards(ALL_KEY);
  } catch (e) {
    toast("Could not load All Mail: " + e);
  }
}

function openAllMail() {
  state.view = { folder: ALL_KEY, label: "All Mail", multi: true };
  renderColumns();
  renderFolders();
  loadAllMail();
}

// ---------- folder order, visibility and colors ----------

state.folderPrefs = []; // [{ name, hidden, color }] in the chosen order
const FOLDER_COLORS = ["", "#4f8fd6", "#43a07a", "#d08a2c", "#d0574f", "#8a6fd1", "#3e9bb0", "#c45f9b", "#8a8f98"];

function folderPref(name) {
  return state.folderPrefs.find((p) => p.name === name);
}

function folderColor(name) {
  return folderPref(name)?.color || "";
}

/// Folders in the user's order: the ones in the settings first, then the others.
function orderedFolders(includeHidden = false) {
  const rank = new Map(state.folderPrefs.map((p, i) => [p.name, i]));
  const list = state.folders
    .map((f, i) => ({ f, key: rank.has(f.name) ? rank.get(f.name) : state.folderPrefs.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.f);
  return includeHidden ? list : list.filter((f) => !folderPref(f.name)?.hidden);
}

function folderTag(folder) {
  const tag = el("span", "row-folder", folderLabel(folder));
  const color = folderColor(folder);
  if (color) {
    tag.style.borderColor = color;
    tag.style.color = color;
  }
  return tag;
}

function renderFolders() {
  const nav = $("folder-list");
  nav.replaceChildren();
  $("nav-all").classList.toggle("active", state.view?.folder === ALL_KEY);
  for (const f of orderedFolders()) {
    const item = el("button", "nav-item");
    item.style.paddingLeft = 8 + f.depth * 14 + "px";
    item.title = f.name;
    if (state.view?.folder === f.name) item.classList.add("active");
    const ic = icon(FOLDER_ICONS[f.kind] || "folder");
    const color = folderColor(f.name);
    if (color) ic.style.color = color;
    item.append(ic, el("span", "label", f.label));
    if (f.unseen) item.append(el("span", "badge", String(f.unseen)));
    if (!f.selectable) {
      item.classList.add("disabled");
    } else {
      item.addEventListener("click", () => openFolder(f));
      setupFolderDrop(item, f.name);
    }
    nav.append(item);
  }
  $("nav-board").classList.toggle("active", !state.view);
}

function setupFolderDrop(item, folder) {
  item.addEventListener("dragover", (ev) => {
    if (!state.dragging || state.dragging.folder === folder) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    item.classList.add("drop-target");
  });
  item.addEventListener("dragleave", () => item.classList.remove("drop-target"));
  item.addEventListener("drop", (ev) => {
    ev.preventDefault();
    item.classList.remove("drop-target");
    const drag = state.dragging;
    if (drag && drag.folder !== folder) dropDragged(drag, folder);
  });
}

// ---------- search ----------

const SEARCH_KEY = "__search__";
const ALL_KEY = "__all__";
const MULTI_KEYS = [SEARCH_KEY, ALL_KEY]; // lists with emails from several folders
state.filterWords = [];
let searchSeq = 0; // ignores results of searches that were replaced by a newer one

function folderLabel(folder) {
  return state.folders.find((f) => f.name === folder)?.label || folder.replace(/^INBOX[./]/, "");
}

function searchOptions() {
  const box = el("div", "search-opts");
  const label = el("label", "toggle");
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = !!state.view.inBody;
  cb.addEventListener("change", () => {
    state.view.inBody = cb.checked;
    runSearch();
  });
  label.append(cb, document.createTextNode(" Also search in the text (slower)"));
  const status = el("span", "muted");
  status.id = "search-status";
  box.append(label, status);
  return box;
}

/// Server search in two steps: first Inbox, Sent, Archive, the board columns and
/// the open folder (fast), then every other folder; results are merged as they come.
async function runSearch() {
  const view = state.view;
  if (!view?.search) return;
  const seq = ++searchSeq;
  const alive = () => seq === searchSeq && state.view === view;
  const setStatus = (text) => {
    const s = $("search-status");
    if (s) s.textContent = text;
  };
  const summary = (entries) => {
    const where = [...new Set(entries.map((e) => folderLabel(e.folder)))];
    return entries.length ? `${entries.length} found in ${where.slice(0, 6).join(", ")}${where.length > 6 ? "…" : ""}` : "Nothing found yet";
  };
  view.searchDone = false;
  const folders = state.columns.map((c) => c.folder);
  if (view.from && !folders.includes(view.from)) folders.push(view.from);
  const args = { text: view.search, inBody: !!view.inBody, folders };
  let entries = [];
  const show = () => {
    entries.sort((a, b) => b.card.date - a.card.date);
    state.cards[SEARCH_KEY] = entries.map((e) => ({ ...e.card, __folder: e.folder }));
    renderCards(SEARCH_KEY);
  };
  try {
    setStatus(view.inBody ? "Searching the main folders, in the text too (slow)…" : "Searching the main folders…");
    entries = await invoke("search_emails", { ...args, scope: "main" });
    if (!alive()) return;
    show();
    setStatus(summary(entries) + " · searching the other folders…");
    const rest = await invoke("search_emails", { ...args, scope: "rest" });
    if (!alive()) return;
    const seen = new Set(entries.map((e) => e.card.message_id || e.folder + "/" + e.card.uid));
    entries = entries.concat(rest.filter((e) => !seen.has(e.card.message_id || e.folder + "/" + e.card.uid)));
    view.searchDone = true;
    show();
    setStatus(summary(entries) + " · all folders searched");
  } catch (e) {
    if (!alive()) return;
    view.searchDone = true;
    show();
    setStatus("Search failed");
    toast("Search failed: " + e);
  }
}

function startSearch(text) {
  const from = state.view && !state.view.search ? state.view.folder : state.view?.from;
  state.view = { folder: SEARCH_KEY, label: `Search: ${text}`, search: text, inBody: state.view?.inBody || false, from, multi: true };
  state.cards[SEARCH_KEY] = [];
  renderColumns();
  renderFolders();
  runSearch();
}

$("search").addEventListener("input", () => {
  state.filterWords = fold($("search").value).split(/\s+/).filter(Boolean);
  if (!state.view?.search) for (const c of visibleColumns()) renderCards(c.folder);
});

$("search").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    const text = $("search").value.trim();
    if (text) startSearch(text);
  } else if (ev.key === "Escape") {
    ev.stopPropagation();
    $("search").value = "";
    state.filterWords = [];
    if (state.view?.search) showBoard();
    else for (const c of visibleColumns()) renderCards(c.folder);
    $("search").blur();
  }
});

// The usual shortcut to jump to the search box.
document.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "f" && !$("board-screen").hidden) {
    ev.preventDefault();
    $("search").focus();
    $("search").select();
  }
});

function openFolder(f) {
  state.view = { folder: f.name, label: f.label, kind: f.kind };
  renderColumns();
  renderFolders();
  loadColumn(f.name);
}

function showBoard() {
  state.view = null;
  renderColumns();
  renderFolders();
  for (const c of state.columns) loadColumn(c.folder);
}

function toggleSidebar() {
  const collapsed = $("sidebar").classList.toggle("collapsed");
  local.set("sidebar", collapsed ? "hidden" : "shown");
}

$("nav-board").addEventListener("click", showBoard);
$("nav-all").addEventListener("click", openAllMail);
$("toggle-sidebar").addEventListener("click", toggleSidebar);
document.addEventListener("keydown", (ev) => {
  const typing = ev.target.closest?.("input, textarea, [contenteditable='true']");
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "b" && !$("board-screen").hidden && !typing) {
    ev.preventDefault();
    toggleSidebar();
  }
});

listen("folder-changed", (ev) => {
  if (String(ev.payload).toUpperCase() === "INBOX" && !columnEl(ev.payload)) checkInbox();
  scheduleReload(ev.payload);
});

// ---------- reading ----------

// In the HTML view: no scripts and no network, only inline styles and embedded
// images. Remote images are allowed only when the user asks for them.
const FRAME_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
const FRAME_CSP_REMOTE_IMAGES = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:";

let readerRemoteAllowed = false;
let readerQuoteShown = false; // show the quoted earlier messages
let readerThread = null; // entries of the current conversation, oldest first
let readerPinTop = false; // keep the open email at the top while it loads

for (const ev of ["wheel", "touchmove", "keydown", "mousedown"]) {
  $("reader-scroll").addEventListener(ev, () => (readerPinTop = false), { passive: true });
}

let readerMode = "html";
let readerMessage = null;
let readerCard = null; // { folder, card }
let seenTimer = null;
let seenCountdown = null;

function stopSeenTimer() {
  clearTimeout(seenTimer);
  clearInterval(seenCountdown);
  seenTimer = seenCountdown = null;
  $("reader-seen-hint").textContent = "";
}

function updateSeenButton() {
  const seen = readerCard.card.seen;
  $("reader-seen").replaceChildren(icon(seen ? "envelope" : "envelope-open"), el("span", "", seen ? "Mark as unread" : "Mark as read"));
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function renderAttachments(folder, uid, list) {
  const box = $("reader-attachments");
  box.hidden = !list.length;
  box.replaceChildren(
    ...list.map((a) => {
      const chip = el("button", "attachment");
      chip.title = `Save ${a.name} to Downloads`;
      chip.append(icon("paperclip"), el("span", "att-name", a.name), el("span", "att-size muted", formatSize(a.size)), icon("download", "att-dl"));
      chip.addEventListener("click", async () => {
        chip.disabled = true;
        try {
          const path = await invoke("save_attachment", { folder, uid, index: a.index });
          toast("Saved to " + path, "info");
        } catch (e) {
          toast("Could not save the attachment: " + e);
        } finally {
          chip.disabled = false;
        }
      });
      return chip;
    }),
  );
}

function updateRemoteNote() {
  const msg = readerMessage;
  const html = msg && readerMode === "html" && msg.html;
  const blocked = html && msg.has_remote_content && !readerRemoteAllowed;
  $("reader-remote-note").textContent = !html
    ? "Plain text"
    : !msg.has_remote_content
      ? "No remote content"
      : readerRemoteAllowed
        ? "Remote images loaded"
        : "Remote images blocked";
  $("reader-load-images").hidden = !blocked;
}

$("reader-load-images").addEventListener("click", () => {
  readerRemoteAllowed = true;
  renderReaderBody();
});

/// Changes read/unread on the server and updates the card right away.
async function setSeen(folder, card, seen) {
  stopSeenTimer();
  card.seen = seen;
  // The column may have been reloaded meanwhile: update the current copy too.
  const live = (state.cards[folder] || []).find((c) => c.uid === card.uid);
  if (live) live.seen = seen;
  for (const key of MULTI_KEYS) {
    const copy = (state.cards[key] || []).find((c) => c.uid === card.uid && c.__folder === folder);
    if (copy) {
      copy.seen = seen;
      renderCards(key);
    }
  }
  scheduleFolderCounts();
  if (readerCard?.card === card) updateSeenButton();
  renderCards(folder);
  try {
    await invoke("set_seen", { folder, uid: card.uid, seen });
  } catch (e) {
    toast("Read state not changed: " + e);
    await loadColumn(folder);
  }
}

function startSeenTimer(folder, card) {
  stopSeenTimer();
  const secs = state.markReadAfter;
  if (card.seen || secs < 0) return;
  if (secs === 0) return void setSeen(folder, card, true);
  let left = secs;
  const hint = () => ($("reader-seen-hint").textContent = `Will be marked as read in ${left} s`);
  hint();
  seenCountdown = setInterval(() => {
    left -= 1;
    if (left > 0) hint();
  }, 1000);
  seenTimer = setTimeout(() => setSeen(folder, card, true), secs * 1000);
}

function folderKind(folder) {
  return state.folders.find((f) => f.name === folder)?.kind || "";
}

/// Moves the email to the trash (kind "trash") or the archive ("archive").
async function fileCard(folder, card, kind) {
  state.cards[folder] = (state.cards[folder] || []).filter((c) => c.uid !== card.uid);
  for (const key of MULTI_KEYS) {
    state.cards[key] = (state.cards[key] || []).filter((c) => !(c.uid === card.uid && c.__folder === folder));
    renderCards(key);
  }
  renderCards(folder);
  try {
    const target = await invoke("file_card", { folder, uid: card.uid, kind });
    offerUndo(`Moved to ${folderLabel(target)}`, [{ message_id: card.message_id, now: target, back: folder }]);
  } catch (e) {
    toast(({ trash: "Delete", junk: "Spam", archive: "Archive" }[kind] || "Move") + " failed: " + e);
  }
  await Promise.all(
    state.columns.concat(visibleColumns()).map((c) => c.folder).filter((f, i, a) => a.indexOf(f) === i && columnEl(f)).map(loadColumn),
  );
  scheduleFolderCounts();
}

$("reader-spam").addEventListener("click", () => {
  const { folder, card } = readerCard;
  closeReader();
  if (folderKind(folder) === "junk") moveMany([{ folder, card }], "INBOX");
  else fileCard(folder, card, "junk");
});

$("reader-trash").addEventListener("click", () => {
  const { folder, card } = readerCard;
  closeReader();
  fileCard(folder, card, "trash");
});

$("reader-seen").addEventListener("click", () => {
  const { folder, card } = readerCard;
  setSeen(folder, card, !card.seen);
});

/// The reader is a single element: inside the popup on the board, inside the
/// right-hand pane in the folder view.
function placeReader() {
  const article = $("reader-article");
  const pane = $("reader-pane");
  if (pane && state.view) {
    pane.replaceChildren(article);
    article.classList.add("in-pane");
    $("reader").hidden = true;
  } else {
    $("reader").append(article);
    article.classList.remove("in-pane");
    $("reader").hidden = false;
  }
}

function readerInPane() {
  return $("reader-article").classList.contains("in-pane");
}

/// Moves the reader back to the (hidden) popup before the board is redrawn.
function detachReader() {
  if (readerInPane()) {
    $("reader").append($("reader-article"));
    $("reader-article").classList.remove("in-pane");
    closeReader();
  }
}

function markSelectedRow() {
  for (const row of document.querySelectorAll(".cards.rows .card.selected")) row.classList.remove("selected");
  if (!readerCard) return;
  for (const row of document.querySelectorAll(`.cards.rows .card[data-uid="${readerCard.card.uid}"]`)) {
    if (row.dataset.folder === readerCard.folder) row.classList.add("selected");
  }
}

async function openReader(folder, card, opts = {}) {
  readerCard = { folder, card };
  readerMessage = null;
  readerQuoteShown = false;
  if (!opts.thread) readerThread = opts.cachedThread || null;
  else readerThread = opts.thread;
  $("reader-spacer").style.height = "0px";
  renderThread({ anchor: false });
  placeReader();
  // Start with the open email at the top: earlier emails are reachable by scrolling up.
  // Keep it there while its content loads, until the user scrolls.
  readerPinTop = true;
  scrollToMessage();
  markSelectedRow();
  updateSeenButton();
  $("reader-reply").disabled = $("reader-reply-all").disabled = true;
  $("reader-trash").hidden = folderKind(folder) === "trash";
  const inJunk = folderKind(folder) === "junk";
  $("reader-spam").querySelector("span").textContent = inJunk ? "Not spam" : "Spam";
  $("reader-spam").title = inJunk ? "Move back to the Inbox" : "Move to Junk";
  $("rule-scope").value = "address";
  updateSenderPanel();
  $("reader-subject").textContent = card.subject || "(no subject)";
  $("reader-from").textContent = card.from || "(unknown sender)";
  $("reader-from-address").textContent = card.from_address && card.from_address !== card.from ? card.from_address : "";
  setAvatar($("reader-avatar"), card.from || card.from_address || "?");
  $("reader-to").textContent = "";
  $("reader-cc").textContent = "";
  $("reader-cc").hidden = $("reader-cc-label").hidden = true;
  $("reader-date").textContent = formatDate(card.date, true);
  $("reader-toggle").hidden = true;
  $("reader-attachments").hidden = true;
  $("reader-invite").hidden = true;
  $("reader-load-images").hidden = true;
  $("reader-remote-note").textContent = "";
  $("reader-quote").hidden = true;
  $("reader-body").replaceChildren(el("pre", "muted", "Loading…"));
  try {
    const msg = await invoke("read_message", { folder, uid: card.uid });
    readerMessage = msg;
    $("reader-subject").textContent = msg.subject || "(no subject)";
    $("reader-from").textContent = msg.from;
    $("reader-to").textContent = msg.to;
    $("reader-cc").textContent = msg.cc;
    $("reader-cc").hidden = $("reader-cc-label").hidden = !msg.cc;
    $("reader-reply").disabled = $("reader-reply-all").disabled = false;
    if (readerCard?.card === card) startSeenTimer(folder, card);
    if (msg.date) $("reader-date").textContent = formatDate(msg.date, true);
    readerMode = msg.html ? "html" : "text";
    readerRemoteAllowed = state.loadRemoteImages;
    $("reader-toggle").hidden = !(msg.html && msg.text);
    renderAttachments(folder, card.uid, msg.attachments || []);
    renderInvite(msg.invite);
    renderReaderBody();
    if (opts.then === "reply") replyTo(false);
    if (!opts.thread) loadThread(folder, card, msg);
  } catch (e) {
    $("reader-body").replaceChildren(el("pre", "error", String(e)));
  }
}

async function loadThread(folder, card, msg) {
  if (!msg.message_id && !msg.references.length) return;
  try {
    const entries = await invoke("load_thread", {
      folder,
      messageId: msg.message_id,
      references: msg.references,
      columns: state.columns.map((c) => c.folder),
    });
    if (readerCard?.card !== card) return; // another email was opened meanwhile
    readerThread = entries;
    renderThread({ anchor: true });
  } catch (e) {
    console.error("conversation lookup failed", e);
  }
}

const AVATAR_COLORS = ["#4f8fd6", "#43a07a", "#c4684f", "#8a6fd1", "#c98a2e", "#3e9bb0", "#b85c8f"];

function setAvatar(a, name) {
  a.textContent = (name.trim()[0] || "?").toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  a.style.background = AVATAR_COLORS[h % AVATAR_COLORS.length];
  return a;
}

function avatar(name) {
  return setAvatar(el("span", "avatar"), name);
}

/// When there are earlier emails above, keeps at least one screen of content
/// from the open email down, so it can sit at the top without the view jumping
/// (a short email gets some empty space below it).
function ensureRoomBelow() {
  const scroller = $("reader-scroll");
  const spacer = $("reader-spacer");
  const card = $("message-card");
  if ($("thread-before").hidden) {
    spacer.style.height = "0px";
    return;
  }
  const below = scroller.scrollHeight - spacer.offsetHeight - (card.offsetTop - scroller.firstElementChild.offsetTop);
  spacer.style.height = Math.max(0, scroller.clientHeight - below) + "px";
}

/// Scrolls the conversation so the open email starts at the top.
function scrollToMessage(smooth = false) {
  const scroller = $("reader-scroll");
  const card = $("message-card");
  scroller.scrollTo({ top: Math.max(0, card.offsetTop - scroller.offsetTop - 4), behavior: smooth ? "smooth" : "auto" });
}

$("reader-earlier").addEventListener("click", () => $("reader-scroll").scrollTo({ top: 0, behavior: "smooth" }));

/// Earlier and later emails of the conversation as compact rows around the open one.
/// With `anchor`, the open email keeps its place on screen while rows are added above it.
function renderThread({ anchor = false } = {}) {
  const scroller = $("reader-scroll");
  const card = $("message-card");
  const offsetBefore = card.offsetTop;
  const scrollBefore = scroller.scrollTop;
  fillThread();
  ensureRoomBelow();
  if (readerPinTop) scrollToMessage();
  else if (anchor) scroller.scrollTop = scrollBefore + (card.offsetTop - offsetBefore);
  const older = $("thread-before").querySelectorAll(".thread-row").length;
  $("reader-earlier").hidden = !older;
  $("reader-earlier").textContent = `↑ ${older} earlier`;
  $("reader-earlier").title = `Show the ${older} earlier email${older === 1 ? "" : "s"} of this conversation`;
}

function fillThread() {
  const before = $("thread-before");
  const after = $("thread-after");
  before.replaceChildren();
  after.replaceChildren();
  const entries = readerThread || [];
  const current = readerCard;
  const isCurrent = (e) =>
    current && ((e.folder === current.folder && e.card.uid === current.card.uid) || (e.card.message_id && e.card.message_id === current.card.message_id));
  const idx = entries.findIndex(isCurrent);
  const others = entries.filter((e) => !isCurrent(e));
  if (!current || !others.length) {
    before.hidden = after.hidden = true;
    return;
  }
  const pos = idx >= 0 ? idx : entries.filter((e) => e.card.date <= current.card.date).length;
  const older = entries.slice(0, pos).filter((e) => !isCurrent(e));
  const newer = entries.slice(pos).filter((e) => !isCurrent(e));
  const row = (e) => {
    const r = el("div", "thread-row" + (e.card.seen ? "" : " unseen"));
    r.title = `${e.card.subject} — ${e.folder}`;
    const reply = el("button", "t-reply");
    reply.title = "Reply to this email";
    reply.append(icon("reply"));
    reply.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openReader(e.folder, e.card, { thread: entries, then: "reply" });
    });
    r.append(avatar(e.card.from || "?"), el("span", "t-from", e.card.from), el("span", "t-preview", e.card.preview), el("span", "t-date", formatDate(e.card.date)), reply);
    r.addEventListener("click", () => openReader(e.folder, e.card, { thread: entries }));
    return r;
  };
  if (older.length) before.append(el("div", "thread-label", `Earlier in this conversation (${older.length})`), ...older.map(row));
  if (newer.length) after.append(el("div", "thread-label", `Later replies (${newer.length})`), ...newer.map(row));
  before.hidden = !older.length;
  after.hidden = !newer.length;
}

$("reader-quote").addEventListener("click", () => {
  readerQuoteShown = !readerQuoteShown;
  renderReaderBody();
});

/// A plain-text email as readable text: links and email addresses are
/// clickable, and quoted lines ("> ...") are dimmed.
function plainTextView(text) {
  const box = el("div", "plain-text");
  const link = /(https?:\/\/[^\s<>"')\]]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;
  for (const line of text.split("\n")) {
    const target = /^\s*>/.test(line) ? box.appendChild(el("span", "quoted")) : box;
    let last = 0;
    for (const m of line.matchAll(link)) {
      target.append(document.createTextNode(line.slice(last, m.index)));
      const href = m[0].includes("://") ? m[0] : "mailto:" + m[0];
      const a = el("a", "", m[0]);
      a.href = href;
      a.title = href;
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        openLink(href);
      });
      target.append(a);
      last = m.index + m[0].length;
    }
    target.append(document.createTextNode(line.slice(last) + "\n"));
  }
  return box;
}

/// Makes the email frame as tall as its content (and keeps it so while images load).
function fitFrame(frame) {
  const doc = frame.contentDocument;
  if (!doc) return;
  const fit = () => {
    // The <html> box is as tall as the content (scrollHeight would never shrink below the frame).
    frame.style.height = Math.max(80, Math.ceil(doc.documentElement.getBoundingClientRect().height)) + "px";
    ensureRoomBelow();
    if (readerPinTop) scrollToMessage();
  };
  fit();
  new ResizeObserver(fit).observe(doc.body);
  for (const img of doc.images) img.addEventListener("load", fit);
  // Links open in the default browser (web links) or in a new email (mailto).
  for (const a of doc.querySelectorAll("a[href]")) a.title = a.getAttribute("href");
  doc.addEventListener("click", (ev) => {
    const a = ev.target.closest?.("a[href]");
    if (!a) return;
    ev.preventDefault();
    openLink(a.getAttribute("href"));
  });
}

function openLink(href) {
  const url = (href || "").trim();
  if (/^mailto:/i.test(url)) {
    const [addr, query] = url.slice(7).split("?");
    const params = new URLSearchParams(query || "");
    openComposer({ to: decodeURIComponent(addr), subject: params.get("subject") || "", body: (params.get("body") || "") + signatureBlock() });
  } else if (/^https?:\/\//i.test(url)) {
    invoke("open_url", { url }).catch((e) => toast("Could not open the link: " + e));
  }
}

function renderReaderBody() {
  const msg = readerMessage;
  const body = $("reader-body");
  const hasQuote = readerMode === "html" && msg.html ? !!msg.html_main : !!msg.text_main;
  $("reader-quote").hidden = !hasQuote;
  $("reader-quote").textContent = readerQuoteShown ? "Hide quoted text" : "Show quoted text  •••";
  const html = hasQuote && !readerQuoteShown && msg.html_main ? msg.html_main : msg.html;
  const text = hasQuote && !readerQuoteShown && msg.text_main ? msg.text_main : msg.text;
  if (readerMode === "html" && msg.html) {
    const frame = document.createElement("iframe");
    // No scripts and no navigation. Same origin (without scripts) only lets the
    // app measure the content, so the frame grows to the full email height.
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.addEventListener("load", () => fitFrame(frame));
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.srcdoc =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${readerRemoteAllowed ? FRAME_CSP_REMOTE_IMAGES : FRAME_CSP}">` +
      `<style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:16px;color:#1c1f24;overflow-wrap:anywhere}img{max-width:100%}</style>` +
      `</head><body>${html}</body></html>`;
    body.replaceChildren(frame);
    $("reader-toggle").textContent = "Show plain text";
  } else {
    body.replaceChildren(plainTextView(text || "(no text)"));
    $("reader-toggle").textContent = "Show HTML version";
  }
  updateRemoteNote();
}

$("reader-toggle").addEventListener("click", () => {
  readerMode = readerMode === "html" ? "text" : "html";
  renderReaderBody();
});

function closeReader() {
  stopSeenTimer();
  if (readerInPane()) {
    $("reader").append($("reader-article"));
    $("reader-article").classList.remove("in-pane");
    showPanePlaceholder();
  }
  $("reader").hidden = true;
  $("reader-body").replaceChildren();
  readerMessage = null;
  readerCard = null;
  readerThread = null;
  markSelectedRow();
}
$("reader-close").addEventListener("click", closeReader);
$("reader").addEventListener("click", (ev) => {
  if (ev.target === $("reader")) closeReader();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (!$("dialog").hidden) closeDialog(null);
  else if (!$("composer").hidden) closeComposer();
  else if (!$("settings").hidden) $("settings").hidden = true;
  else if (!$("reader").hidden) closeReader();
});

// ---------- confirmation dialog ----------

// window.confirm() does nothing inside Tauri (it always answers "no"), so the app
// shows its own dialog. Resolves to the chosen button's value, or null on Esc.
let dialogResolve = null;

function ask(message, buttons) {
  if (dialogResolve) dialogResolve(null);
  $("dialog-message").textContent = message;
  const box = $("dialog-buttons");
  box.replaceChildren(
    ...buttons.map((b) => {
      const btn = el("button", b.kind || "", b.label);
      btn.type = "button";
      btn.addEventListener("click", () => closeDialog(b.value));
      return btn;
    }),
  );
  $("dialog").hidden = false;
  box.querySelector(".primary, .danger")?.focus();
  return new Promise((resolve) => (dialogResolve = resolve));
}

function closeDialog(value) {
  $("dialog").hidden = true;
  const resolve = dialogResolve;
  dialogResolve = null;
  resolve?.(value);
}

// ---------- writing and replying ----------

const DRAFT_AUTOSAVE_MS = 15000;

const compose = {
  reply: null, // { folder, uid } of the email being replied to
  context: null, // { in_reply_to, references }
  messageId: null, // same Message-ID for every draft version and the final send
  initial: "", // content when the composer opened
  saved: "", // content of the last saved draft
  hasDraft: false, // a version of this email exists in Drafts
  timer: null,
  saving: null, // promise of the save in progress
  attachments: [], // [{ name, mime, size, data (base64) }]
  markdown: false,
  previewing: false,
};

const MAX_ATTACH_BYTES = 25 * 1024 * 1024; // most mail servers refuse larger emails

function composeSnapshot() {
  return ["compose-to", "compose-cc", "compose-bcc", "compose-subject", "compose-body"]
    .map((id) => $(id).value)
    .concat(compose.rich ? $("compose-rich").innerHTML : compose.markdown ? "md" : "plain", compose.attachments.map((a) => a.name + ":" + a.size).join("|"))
    .join("\u0000");
}

function composeDraft() {
  return {
    to: $("compose-to").value,
    cc: $("compose-cc").value,
    bcc: $("compose-bcc").value,
    subject: $("compose-subject").value,
    body: compose.rich ? richText() : $("compose-body").value,
    html: compose.rich ? $("compose-rich").innerHTML : null,
    in_reply_to: compose.context?.in_reply_to ?? null,
    references: compose.context?.references ?? [],
    message_id: compose.messageId,
    markdown: !compose.rich && compose.markdown,
    attachments: compose.attachments.map(({ name, mime, data }) => ({ name, mime, data })),
  };
}

function setComposeStatus(text) {
  $("compose-status").textContent = text;
}

/// Saves the current text to Drafts if it changed since the last save.
async function saveDraft() {
  if (compose.saving) await compose.saving;
  const snapshot = composeSnapshot();
  if (snapshot === compose.saved || !compose.messageId) return true;
  setComposeStatus("Saving draft…");
  compose.saving = invoke("save_draft", { draft: composeDraft() })
    .then((folder) => {
      compose.saved = snapshot;
      compose.hasDraft = true;
      setComposeStatus("Draft saved " + new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
      if (columnEl(folder)) scheduleReload(folder);
      return true;
    })
    .catch((e) => {
      setComposeStatus("Draft not saved");
      console.error(e);
      return String(e);
    })
    .finally(() => (compose.saving = null));
  return compose.saving;
}

async function openComposer({ to = "", cc = "", bcc = state.defaultBcc, subject = "", body = "", reply = null, context = null, title = "New email", messageId = null, fromDraft = false, attachments = [] } = {}) {
  compose.attachments = attachments;
  const fmt = local.get("composeFormat");
  compose.markdown = fmt === "markdown";
  compose.rich = fmt === "rich";
  setPreview(false);
  renderComposeAttachments();
  renderFormat();
  $("compose-title").textContent = title;
  $("compose-to").value = to;
  $("compose-cc").value = cc;
  $("compose-bcc").value = bcc;
  $("compose-subject").value = subject;
  $("compose-body").value = body;
  if (compose.rich) $("compose-rich").innerHTML = textToRichHtml(body);
  $("compose-from").textContent = "From: " + state.email;
  setComposeStatus("");
  compose.reply = reply;
  compose.context = context;
  compose.initial = compose.saved = composeSnapshot();
  compose.hasDraft = fromDraft;
  $("compose-drop").hidden = true;
  compose.messageId = messageId;
  $("composer").hidden = false;
  const bodyEl = compose.rich ? $("compose-rich") : $("compose-body");
  if (to && compose.rich) {
    bodyEl.focus();
  } else if (to) {
    bodyEl.focus();
    bodyEl.setSelectionRange(0, 0);
    bodyEl.scrollTop = 0;
  } else {
    $("compose-to").focus();
  }
  if (!compose.messageId) {
    try {
      compose.messageId = await invoke("new_message_id");
    } catch (e) {
      setComposeStatus("Drafts unavailable: " + e);
    }
  }
  clearInterval(compose.timer);
  compose.timer = setInterval(saveDraft, DRAFT_AUTOSAVE_MS);
}

function hideComposer() {
  clearInterval(compose.timer);
  compose.timer = null;
  hideSuggestions();
  $("composer").hidden = true;
}

/// Close: unchanged emails just close; otherwise the text is kept in Drafts.
async function closeComposer() {
  if (composeSnapshot() === compose.initial && !compose.hasDraft) return hideComposer();
  const result = await saveDraft();
  if (result === true) {
    hideComposer();
    if (compose.hasDraft) toast("Saved to Drafts", "info");
    return;
  }
  const choice = await ask(`The draft could not be saved:\n${result}`, [
    { label: "Keep editing", value: "keep" },
    { label: "Close without saving", value: "close", kind: "danger" },
  ]);
  if (choice === "close") hideComposer();
}

async function discardComposer() {
  const changed = composeSnapshot() !== compose.initial;
  if (changed || compose.hasDraft) {
    const choice = await ask("Discard this email? The draft will be deleted.", [
      { label: "Cancel", value: null },
      { label: "Discard", value: "discard", kind: "danger" },
    ]);
    if (choice !== "discard") return;
  }
  hideComposer();
  if (compose.saving) await compose.saving;
  if (compose.hasDraft && compose.messageId) {
    try {
      await invoke("discard_draft", { messageId: compose.messageId });
    } catch (e) {
      toast("Could not delete the draft: " + e);
    }
    const drafts = state.folders.find((f) => f.kind === "drafts")?.name;
    if (drafts && columnEl(drafts)) loadColumn(drafts);
  }
}

/// Opens a saved draft in the composer to keep writing it.
async function openDraft(folder, card) {
  try {
    const msg = await invoke("read_message", { folder, uid: card.uid });
    const attachments = await loadAttachments(folder, card.uid, msg.attachments || []);
    openComposer({
      attachments,
      to: msg.to,
      cc: msg.cc,
      bcc: msg.bcc,
      subject: msg.subject,
      body: msg.text || "",
      context: msg.in_reply_to ? { in_reply_to: msg.in_reply_to, references: msg.references.filter((r) => r !== msg.in_reply_to) } : null,
      messageId: msg.message_id,
      fromDraft: true,
      title: "Draft",
    });
  } catch (e) {
    toast("Could not open the draft: " + e);
  }
}

// ---------- attachments, format and forward ----------

function formatSizeTotal() {
  const total = compose.attachments.reduce((n, a) => n + a.size, 0);
  $("compose-size").textContent = total ? `${compose.attachments.length} file${compose.attachments.length === 1 ? "" : "s"} · ${formatSize(total)}` : "";
  $("compose-size").classList.toggle("error", total > MAX_ATTACH_BYTES);
  return total;
}

function renderComposeAttachments() {
  const box = $("compose-attachments");
  box.hidden = !compose.attachments.length;
  box.replaceChildren(
    ...compose.attachments.map((a, i) => {
      const chip = el("span", "attachment compose-file");
      const remove = el("button", "att-remove icon-btn");
      remove.type = "button";
      remove.title = "Remove";
      remove.append(icon("close"));
      remove.addEventListener("click", () => {
        compose.attachments.splice(i, 1);
        renderComposeAttachments();
      });
      chip.append(icon("paperclip"), el("span", "att-name", a.name), el("span", "att-size muted", formatSize(a.size)), remove);
      return chip;
    }),
  );
  formatSizeTotal();
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function addFiles(files) {
  for (const file of files) {
    if (!file.size && !file.type) continue; // a folder
    const total = formatSizeTotal();
    if (total + file.size > MAX_ATTACH_BYTES) {
      toast(`${file.name} is too big: emails can carry about ${formatSize(MAX_ATTACH_BYTES)} in total.`);
      continue;
    }
    try {
      compose.attachments.push({ name: file.name, mime: file.type || "application/octet-stream", size: file.size, data: await readFile(file) });
    } catch (e) {
      toast(`Could not read ${file.name}: ${e}`);
    }
  }
  renderComposeAttachments();
}

/// Downloads attachments of an existing email so they can be sent again.
async function loadAttachments(folder, uid, list) {
  const out = [];
  for (const a of list) {
    try {
      const d = await invoke("attachment_data", { folder, uid, index: a.index });
      out.push({ name: d.name, mime: d.mime, size: a.size, data: d.data });
    } catch (e) {
      toast(`Could not add ${a.name}: ${e}`);
    }
  }
  return out;
}

$("compose-attach").addEventListener("click", () => {
  $("compose-file").value = "";
  $("compose-file").click();
});
$("compose-file").addEventListener("change", () => addFiles([...$("compose-file").files]));

// Drop files anywhere on the composer.
let dragDepth = 0;
const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes("Files");
$("compose-form").addEventListener("dragenter", (ev) => {
  if (!hasFiles(ev)) return;
  dragDepth++;
  $("compose-drop").hidden = false;
});
$("compose-form").addEventListener("dragover", (ev) => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "copy";
});
$("compose-form").addEventListener("dragleave", (ev) => {
  if (!hasFiles(ev)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("compose-drop").hidden = true;
  }
});
$("compose-form").addEventListener("drop", (ev) => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  dragDepth = 0;
  $("compose-drop").hidden = true;
  addFiles([...ev.dataTransfer.files]);
});

// Files dropped outside the composer must not make the window open them.
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (ev) => {
    if (hasFiles(ev) && !$("compose-form").contains(ev.target)) ev.preventDefault();
  });
}

function renderFormat() {
  const fmt = compose.rich ? "rich" : compose.markdown ? "markdown" : "plain";
  for (const [id, f] of [["fmt-plain", "plain"], ["fmt-md", "markdown"], ["fmt-rich", "rich"]]) {
    $(id).classList.toggle("active", fmt === f);
    $(id).setAttribute("aria-checked", String(fmt === f));
  }
  $("compose-preview").hidden = fmt !== "markdown";
  $("compose-body").hidden = fmt === "rich" || compose.previewing;
  $("compose-rich").hidden = fmt !== "rich";
  $("rich-toolbar").hidden = fmt !== "rich";
  $("compose-body").placeholder = compose.markdown ? "**bold**, *italic*, - lists, [link](https://example.com), # headings, tables or inline HTML" : "";
}

/// Switches between "plain", "markdown" and "rich", converting what was written.
async function setFormat(fmt) {
  const was = compose.rich ? "rich" : compose.markdown ? "markdown" : "plain";
  if (fmt === was) return;
  if (fmt === "rich") {
    const text = $("compose-body").value;
    $("compose-rich").innerHTML =
      was === "markdown" ? await invoke("render_markdown", { text }).catch(() => textToRichHtml(text)) : textToRichHtml(text);
  } else if (was === "rich") {
    $("compose-body").value = richText();
  }
  compose.markdown = fmt === "markdown";
  compose.rich = fmt === "rich";
  local.set("composeFormat", fmt);
  if (fmt !== "markdown") await setPreview(false);
  renderFormat();
  (compose.rich ? $("compose-rich") : $("compose-body")).focus();
}

/// Plain text to editor HTML. The signature block becomes the rich signature
/// when there is one.
function textToRichHtml(text) {
  const conv = (t) => escapeHtml(t).replace(/\n/g, "<br>");
  const marker = state.signature ? "-- \n" + state.signature : null;
  const pos = marker ? text.indexOf(marker) : -1;
  if (pos < 0 || !state.signatureHtml) return conv(text);
  return conv(text.slice(0, pos)) + `<div>-- <br>${state.signatureHtml}</div>` + conv(text.slice(pos + marker.length));
}

/// The plain-text version of the visual editor.
function richText() {
  const ed = $("compose-rich");
  const hidden = ed.hidden;
  ed.hidden = false; // innerText needs the element to be rendered
  const text = ed.innerText.replace(/\u00a0/g, " ");
  ed.hidden = hidden;
  return text;
}

// Visual editor toolbar.
let richRange = null;
const rememberRich = () => {
  const sel = window.getSelection();
  if (sel.rangeCount && $("compose-rich").contains(sel.anchorNode)) richRange = sel.getRangeAt(0).cloneRange();
};
const restoreRich = () => {
  $("compose-rich").focus();
  if (!richRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(richRange);
};
for (const ev of ["keyup", "mouseup", "input"]) $("compose-rich").addEventListener(ev, rememberRich);
for (const b of document.querySelectorAll("#rich-toolbar [data-rich]")) {
  b.addEventListener("mousedown", (ev) => ev.preventDefault());
  b.addEventListener("click", () => {
    restoreRich();
    const cmd = b.dataset.rich;
    if (cmd === "blockquote") document.execCommand("formatBlock", false, "blockquote");
    else document.execCommand(cmd);
    rememberRich();
  });
}
$("rich-link").addEventListener("mousedown", (ev) => ev.preventDefault());
$("rich-link").addEventListener("click", () => {
  rememberRich();
  $("rich-link-row").hidden = false;
  $("rich-link-url").focus();
});
$("rich-link-add").addEventListener("click", () => {
  let url = $("rich-link-url").value.trim();
  if (url && !/^(https?:|mailto:)/i.test(url)) url = (url.includes("@") ? "mailto:" : "https://") + url;
  $("rich-link-row").hidden = true;
  $("rich-link-url").value = "";
  if (!url) return;
  restoreRich();
  if (window.getSelection().isCollapsed) document.execCommand("insertHTML", false, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
  else document.execCommand("createLink", false, url);
});
$("rich-link-url").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    $("rich-link-add").click();
  }
});
// Pasted images go into the email as embedded images.
$("compose-rich").addEventListener("paste", async (ev) => {
  const files = [...(ev.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  ev.preventDefault();
  for (const f of files) {
    const data = await readFile(f);
    document.execCommand("insertHTML", false, `<img src="data:${f.type};base64,${data}" alt="" style="max-width:100%">`);
  }
});

async function setPreview(on) {
  compose.previewing = on;
  $("compose-preview").classList.toggle("active", on);
  $("compose-body").hidden = on || compose.rich;
  $("compose-preview-pane").hidden = !on;
  if (!on) return $("compose-preview-pane").replaceChildren();
  const html = await invoke("render_markdown", { text: $("compose-body").value }).catch((e) => `<p>${escapeHtml(String(e))}</p>`);
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "");
  frame.srcdoc =
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
    `<style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:12px 14px;color:#1c1f24}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:10px;color:#555}</style>` +
    `</head><body>${html}</body></html>`;
  $("compose-preview-pane").replaceChildren(frame);
}

$("fmt-plain").addEventListener("click", () => setFormat("plain"));
$("fmt-md").addEventListener("click", () => setFormat("markdown"));
$("fmt-rich").addEventListener("click", () => setFormat("rich"));
$("compose-preview").addEventListener("click", () => setPreview(!compose.previewing));

/// "Forward": the original text below a header, with its attachments.
async function forward() {
  const msg = readerMessage;
  if (!msg || !readerCard) return;
  const { folder, card } = readerCard;
  const header = [
    "---------- Forwarded message ----------",
    `From: ${msg.from}${msg.reply_address && msg.reply_address !== msg.from ? ` <${msg.reply_address}>` : ""}`,
    `Date: ${formatDate(msg.date, true)}`,
    `Subject: ${msg.subject}`,
    `To: ${msg.to}`,
    msg.cc ? `Cc: ${msg.cc}` : null,
  ].filter(Boolean);
  const subject = /^(fwd?|i|inoltra):/i.test(msg.subject.trim()) ? msg.subject : "Fwd: " + msg.subject;
  await openComposer({
    subject,
    body: signatureBlock() + "\n\n" + header.join("\n") + "\n\n" + (msg.text || ""),
    title: "Forward",
  });
  $("compose-to").focus();
  if (msg.attachments?.length) {
    setComposeStatus("Adding the attachments…");
    compose.attachments = await loadAttachments(folder, card.uid, msg.attachments);
    renderComposeAttachments();
    setComposeStatus("");
  }
}
$("reader-forward").addEventListener("click", forward);

/// Signature in the standard format: "-- " on a line of its own, then the text.
function signatureBlock() {
  return state.signature ? `\n\n-- \n${state.signature}` : "";
}

function quote(msg) {
  const text = msg.text || "";
  const when = msg.date ? formatDate(msg.date, true) : "";
  const quoted = text.replace(/\s+$/, "").split("\n").map((l) => "> " + l).join("\n");
  return `\n\n${when ? "On " + when + ", " : ""}${msg.from} wrote:\n${quoted}\n`;
}

function replyTo(all) {
  const msg = readerMessage;
  if (!msg) return;
  const me = state.email.toLowerCase();
  const to = msg.reply_address;
  let cc = "";
  if (all) {
    const seen = new Set([me, to.toLowerCase()]);
    cc = msg.all_recipients
      .filter((a) => {
        const k = a.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .join(", ");
  }
  const subject = /^re:/i.test(msg.subject.trim()) ? msg.subject : "Re: " + msg.subject;
  openComposer({
    to,
    cc,
    subject,
    body: signatureBlock() + quote(msg),
    reply: { folder: readerCard.folder, uid: readerCard.card.uid },
    context: { in_reply_to: msg.message_id, references: msg.references },
    title: all ? "Reply all" : "Reply",
  });
}

$("reader-reply").addEventListener("click", () => replyTo(false));
$("reader-reply-all").addEventListener("click", () => replyTo(true));
$("compose").addEventListener("click", () => openComposer({ body: signatureBlock() }));
$("compose-close").addEventListener("click", () => closeComposer());
$("compose-cancel").addEventListener("click", () => closeComposer());
$("compose-discard").addEventListener("click", () => discardComposer());

$("compose-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!$("compose-subject").value.trim()) {
    const choice = await ask("This email has no subject. Send it anyway?", [
      { label: "Cancel", value: null },
      { label: "Send", value: "send", kind: "primary" },
    ]);
    if (choice !== "send") return;
  }
  if (formatSizeTotal() > MAX_ATTACH_BYTES) return toast("The attachments are too big to send: remove some of them.");
  const btn = $("compose-send");
  btn.disabled = true;
  btn.textContent = "Sending…";
  clearInterval(compose.timer);
  if (compose.saving) await compose.saving;
  try {
    const result = await invoke("send_mail", { draft: composeDraft(), reply: compose.reply });
    hideComposer();
    // People you just wrote to become known senders right away.
    const sent = composeDraft();
    for (const part of [sent.to, sent.cc, sent.bcc].join(",").split(/[,;]/)) {
      const m = part.match(/<([^>]+)>/) || part.match(/(\S+@\S+)/);
      if (m) state.known.add(m[1].trim().toLowerCase());
    }
    if (result.warning) toast(result.warning);
    else toast(`Email sent (copy saved to ${result.saved_to})`, "info");
    const drafts = state.folders.find((f) => f.kind === "drafts")?.name;
    if (drafts && columnEl(drafts)) loadColumn(drafts);
  } catch (e) {
    toast("Sending failed: " + e);
    compose.timer = setInterval(saveDraft, DRAFT_AUTOSAVE_MS);
  } finally {
    btn.disabled = false;
    btn.textContent = "Send";
  }
});

// ---------- settings ----------

function showSettingsTab(name) {
  for (const t of document.querySelectorAll(".tabs .tab")) {
    t.classList.toggle("active", t.dataset.tab === name);
    t.setAttribute("aria-selected", t.dataset.tab === name ? "true" : "false");
  }
  for (const p of document.querySelectorAll(".tab-panel")) p.hidden = p.dataset.panel !== name;
}
for (const t of document.querySelectorAll(".tabs .tab")) t.addEventListener("click", () => showSettingsTab(t.dataset.tab));

$("open-settings").addEventListener("click", async () => {
  try {
    const s = await invoke("get_settings");
    showSettingsTab("account");
    $("set-bcc").value = s.default_bcc;
    $("settings-email").textContent = "Account: " + s.email;
    $("set-name").value = s.display_name;
    $("set-smtp").value = s.smtp_server;
    $("set-port").value = String(s.smtp_port);
    loadSignatureEditor(s.signature, s.signature_html);
    $("set-contacts").checked = s.use_system_contacts;
    wasUsingContacts = s.use_system_contacts;
    showContactsStatus();
    $("set-remote").checked = s.load_remote_images;
    $("set-same-domain").checked = s.important_same_domain;
    $("set-group").checked = s.group_threads;
    $("set-theme").value = s.theme || "system";
    $("set-zoom").value = String(s.zoom || 100);
    $("set-notify").value = s.notify || "important";
    $("set-undo").value = String(s.undo_seconds ?? 8);
    rulesDraft = (s.rules || []).map((r) => ({ ...r }));
    columnsDraft = state.columns.map((c) => ({ name: c.name, folder: c.folder }));
    columnsChanged = false;
    renderFolderNames();
    renderRulePrefs();
    renderColumnPrefs();
    prefsDraft = mergeFolderPrefs(s.folders || []);
    renderFolderPrefs();
    $("set-allow").value = s.important_allow.join("\n");
    $("set-block").value = s.important_block.join("\n");
    $("set-never").checked = s.mark_read_after_seconds < 0;
    $("set-seconds").value = Math.max(0, s.mark_read_after_seconds < 0 ? 3 : s.mark_read_after_seconds);
    $("set-seconds").disabled = s.mark_read_after_seconds < 0;
    $("settings").hidden = false;
  } catch (e) {
    toast(String(e));
  }
});

$("set-never").addEventListener("change", (ev) => ($("set-seconds").disabled = ev.target.checked));
$("settings-cancel").addEventListener("click", () => ($("settings").hidden = true));

$("settings-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const seconds = $("set-never").checked ? -1 : Math.max(0, parseInt($("set-seconds").value, 10) || 0);
  const sig = readSignatureEditor();
  try {
    await invoke("save_settings", {
      settings: {
        email: state.email,
        display_name: $("set-name").value,
        smtp_server: $("set-smtp").value,
        smtp_port: parseInt($("set-port").value, 10),
        mark_read_after_seconds: seconds,
        signature: sig.text,
        signature_html: sig.html,
        default_bcc: $("set-bcc").value,
        use_system_contacts: $("set-contacts").checked,
        load_remote_images: $("set-remote").checked,
        important_allow: $("set-allow").value.split(/[\n,;]+/),
        important_block: $("set-block").value.split(/[\n,;]+/),
        important_same_domain: $("set-same-domain").checked,
        group_threads: $("set-group").checked,
        folders: prefsDraft,
        rules: rulesDraft.filter((r) => r.contains.trim() && r.folder.trim()),
        notify: $("set-notify").value,
        undo_seconds: parseInt($("set-undo").value, 10),
        theme: $("set-theme").value,
        zoom: parseInt($("set-zoom").value, 10),
      },
    });
    const saved = await invoke("get_settings");
    state.allow = saved.important_allow;
    state.block = saved.important_block;
    state.sameDomain = saved.important_same_domain;
    applySettingsState(saved);
    cacheSet("settings", saved);
    if (columnsChanged) {
      await invoke("save_board", { columns: columnsDraft.filter((c) => c.folder.trim()) });
      $("settings").hidden = true;
      return openBoard({ fromCache: true });
    }
    renderFolders();
    renderColumns();
    for (const c of visibleColumns()) loadColumn(c.folder);
    for (const c of visibleColumns()) renderCards(c.folder);
    if ($("set-contacts").checked) loadContacts(!wasUsingContacts);
    else state.contacts = [];
    state.markReadAfter = seconds;
    state.signature = sig.text;
    state.signatureHtml = sig.html;
    state.defaultBcc = $("set-bcc").value.trim();
    state.loadRemoteImages = $("set-remote").checked;
    $("settings").hidden = true;
    toast("Settings saved", "info");
  } catch (e) {
    toast("Settings not saved: " + e);
  }
});

// ---------- export / import ----------

$("export-settings").addEventListener("click", async () => {
  try {
    const path = await invoke("export_settings");
    toast("Settings saved to " + path, "info");
  } catch (e) {
    toast("Export failed: " + e);
  }
});

$("import-settings").addEventListener("click", () => {
  $("import-file").value = "";
  $("import-file").click();
});

$("import-file").addEventListener("change", async () => {
  const file = $("import-file").files[0];
  if (!file) return;
  const choice = await ask(`Import the settings from “${file.name}”? Your current columns, signature, rules and folder settings will be replaced.`, [
    { label: "Cancel", value: null },
    { label: "Import", value: "import", kind: "primary" },
  ]);
  if (choice !== "import") return;
  try {
    const summary = await invoke("import_settings", { json: await file.text() });
    toast(summary + " Reloading…", "info");
    setTimeout(() => location.reload(), 1800);
  } catch (e) {
    toast("Import failed: " + e);
  }
});

// ---------- columns and rules tabs ----------

let columnsDraft = [];
let columnsChanged = false;
let rulesDraft = [];

function renderFolderNames() {
  $("folder-names").replaceChildren(...state.folders.filter((f) => f.selectable).map((f) => Object.assign(document.createElement("option"), { value: f.name })));
}

function folderSelect(value, onChange) {
  const sel = document.createElement("select");
  for (const f of orderedFolders(true).filter((f) => f.selectable)) {
    sel.append(new Option(f.depth ? "  ".repeat(f.depth) + f.label : f.name.replace(/^INBOX[./]/, "") || f.name, f.name));
  }
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

/// A row that can be dragged to reorder `list` (re-rendered by `rerender`).
function makeSortable(row, list, i, rerender, box) {
  row.draggable = true;
  row.addEventListener("dragstart", (ev) => {
    if (ev.target.closest("input, select")) return ev.preventDefault();
    sortFrom = { list, i };
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", String(i));
    requestAnimationFrame(() => row.classList.add("dragging"));
  });
  row.addEventListener("dragend", () => {
    sortFrom = null;
    for (const r of box.children) r.classList.remove("dragging", "drop-before", "drop-after");
  });
  row.addEventListener("dragover", (ev) => {
    if (sortFrom?.list !== list) return;
    ev.preventDefault();
    const r = row.getBoundingClientRect();
    for (const x of box.children) x.classList.remove("drop-before", "drop-after");
    row.classList.add(ev.clientY > r.top + r.height / 2 ? "drop-after" : "drop-before");
  });
  row.addEventListener("drop", (ev) => {
    if (sortFrom?.list !== list) return;
    ev.preventDefault();
    const r = row.getBoundingClientRect();
    let to = ev.clientY > r.top + r.height / 2 ? i + 1 : i;
    const [moved] = list.splice(sortFrom.i, 1);
    if (sortFrom.i < to) to--;
    list.splice(to, 0, moved);
    sortFrom = null;
    rerender();
  });
}
let sortFrom = null;

function removeButton(onClick) {
  const b = el("button", "pref-remove");
  b.type = "button";
  b.title = "Remove";
  b.append(icon("close"));
  b.addEventListener("click", onClick);
  return b;
}

function renderColumnPrefs() {
  const box = $("column-prefs");
  box.replaceChildren();
  columnsDraft.forEach((c, i) => {
    const row = el("div", "folder-pref column-pref");
    const grip = el("span", "fp-grip");
    grip.append(icon("grip"));
    const name = el("input");
    name.value = c.name;
    name.placeholder = "Column title";
    name.addEventListener("input", () => {
      c.name = name.value;
      columnsChanged = true;
    });
    const folder = el("input");
    folder.value = c.folder;
    folder.placeholder = "IMAP folder";
    folder.setAttribute("list", "folder-names");
    folder.addEventListener("input", () => {
      c.folder = folder.value;
      columnsChanged = true;
    });
    const remove = removeButton(() => {
      if (columnsDraft.length === 1) return toast("The board needs at least one column");
      columnsDraft.splice(i, 1);
      columnsChanged = true;
      renderColumnPrefs();
    });
    row.append(grip, name, folder, remove);
    makeSortable(row, columnsDraft, i, () => {
      columnsChanged = true;
      renderColumnPrefs();
    }, box);
    box.append(row);
  });
}

$("add-column").addEventListener("click", () => {
  columnsDraft.push({ name: "", folder: "" });
  columnsChanged = true;
  renderColumnPrefs();
  $("column-prefs").lastElementChild?.querySelector("input")?.focus();
});

function renderRulePrefs() {
  const box = $("rule-prefs");
  box.replaceChildren();
  if (!rulesDraft.length) box.append(el("p", "muted small", "No rules yet. Example: when From contains “@github.com”, move to Notifications."));
  rulesDraft.forEach((r, i) => {
    const row = el("div", "rule-pref");
    const field = document.createElement("select");
    for (const [v, label] of [["from", "When From"], ["to", "When To/Cc"], ["subject", "When Subject"]]) field.append(new Option(label, v));
    field.value = r.field;
    field.addEventListener("change", () => (r.field = field.value));
    const text = el("input");
    text.value = r.contains;
    text.placeholder = "contains…";
    text.addEventListener("input", () => (r.contains = text.value));
    const folder = folderSelect(r.folder, (v) => (r.folder = v));
    row.append(field, text, el("span", "", "move to"), folder, removeButton(() => {
      rulesDraft.splice(i, 1);
      renderRulePrefs();
    }));
    box.append(row);
  });
}

$("add-rule").addEventListener("click", () => {
  const firstFolder = orderedFolders(true).find((f) => f.selectable && f.kind !== "inbox")?.name || "";
  rulesDraft.push({ field: "from", contains: "", folder: firstFolder });
  renderRulePrefs();
  $("rule-prefs").lastElementChild?.querySelector("input")?.focus();
});

$("run-rules").addEventListener("click", async () => {
  state.rules = rulesDraft.filter((r) => r.contains.trim() && r.folder.trim());
  const inbox = state.cards.INBOX || (await invoke("load_column", { folder: "INBOX", limit: null }).catch(() => []));
  ruleTried.clear();
  const moved = await applyRules(inbox);
  if (!moved.size) toast("No email in the Inbox matches the rules", "info");
});

// ---------- folders tab ----------

let prefsDraft = []; // folder preferences being edited in the settings
let prefsDragFrom = null; // index of the folder being dragged in the settings

/// Every server folder in the current order, with its preferences.
function mergeFolderPrefs(prefs) {
  state.folderPrefs = prefs;
  return orderedFolders(true).map((f) => ({ name: f.name, hidden: !!folderPref(f.name)?.hidden, color: folderPref(f.name)?.color || "" }));
}

function renderFolderPrefs() {
  const box = $("folder-prefs");
  box.replaceChildren();
  prefsDraft.forEach((p, i) => {
    const f = state.folders.find((x) => x.name === p.name);
    const row = el("div", "folder-pref" + (p.hidden ? " hidden-folder" : ""));
    // Drag the row to reorder; a line shows where it will land.
    const grip = el("span", "fp-grip");
    grip.title = "Drag to reorder";
    grip.append(icon("grip"));
    row.draggable = true;
    row.dataset.index = i;
    row.addEventListener("dragstart", (ev) => {
      prefsDragFrom = i;
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", p.name);
      requestAnimationFrame(() => row.classList.add("dragging"));
    });
    row.addEventListener("dragend", () => {
      prefsDragFrom = null;
      for (const r of box.children) r.classList.remove("dragging", "drop-before", "drop-after");
    });
    row.addEventListener("dragover", (ev) => {
      if (prefsDragFrom === null) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      const r = row.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      for (const x of box.children) x.classList.remove("drop-before", "drop-after");
      row.classList.add(after ? "drop-after" : "drop-before");
    });
    row.addEventListener("drop", (ev) => {
      if (prefsDragFrom === null) return;
      ev.preventDefault();
      const r = row.getBoundingClientRect();
      let to = ev.clientY > r.top + r.height / 2 ? i + 1 : i;
      const [moved] = prefsDraft.splice(prefsDragFrom, 1);
      if (prefsDragFrom < to) to--;
      prefsDraft.splice(to, 0, moved);
      prefsDragFrom = null;
      renderFolderPrefs();
    });
    const show = el("input");
    show.type = "checkbox";
    show.checked = !p.hidden;
    show.title = "Show in the sidebar";
    show.addEventListener("change", () => {
      p.hidden = !show.checked;
      row.classList.toggle("hidden-folder", p.hidden);
    });
    const color = el("button", "fp-color" + (p.color ? "" : " none"));
    color.type = "button";
    color.title = "Click to change the color";
    if (p.color) color.style.background = color.style.borderColor = p.color;
    color.addEventListener("click", () => {
      p.color = FOLDER_COLORS[(FOLDER_COLORS.indexOf(p.color) + 1) % FOLDER_COLORS.length];
      renderFolderPrefs();
    });
    const label = el("div", "fp-label");
    label.append(el("span", "", (f?.depth ? "↳ " : "") + (f?.label || p.name)));
    const path = el("span", "fp-path muted", f && f.label !== p.name ? p.name : "");
    row.append(grip, show, color, label, path);
    box.append(row);
  });
}

// ---------- signature editor ----------

const sigEditor = $("sig-editor");
let sigRange = null; // selection to restore after using the toolbar

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function loadSignatureEditor(text, html) {
  showSignatureSource(false);
  $("sig-link-row").hidden = true;
  sigEditor.innerHTML = html || escapeHtml(text || "").replace(/\n/g, "<br>");
  checkSignatureImages();
}

/// Warns about images linked from the internet: recipients' apps often block them.
function checkSignatureImages() {
  const remote = [...sigEditor.querySelectorAll("img")].some((img) => /^https?:/i.test(img.getAttribute("src") || ""));
  $("sig-remote-warning").hidden = !remote;
}
sigEditor.addEventListener("input", checkSignatureImages);

/// Plain-text and HTML versions of the signature. The HTML version is kept
/// only when there is real formatting (bold, links, images...).
function readSignatureEditor() {
  showSignatureSource(false); // innerText needs the editor visible...
  const panel = sigEditor.closest(".tab-panel");
  const wasHidden = panel.hidden;
  panel.hidden = false; // ...including its settings tab
  const text = sigEditor.innerText.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const rich = sigEditor.querySelector("img, a, b, strong, i, em, u, font, table, [style], h1, h2, h3, ul, ol");
  panel.hidden = wasHidden;
  return { text, html: rich ? sigEditor.innerHTML.trim() : "" };
}

function showSignatureSource(show) {
  const source = $("sig-source");
  if (show === !source.hidden) return;
  if (show) source.value = sigEditor.innerHTML;
  else {
    sigEditor.innerHTML = source.value;
    checkSignatureImages();
  }
  source.hidden = !show;
  sigEditor.hidden = show;
  $("sig-html").classList.toggle("active", show);
  for (const b of document.querySelectorAll(".sig-toolbar button:not(#sig-html)")) b.disabled = show;
}

function rememberSelection() {
  const sel = window.getSelection();
  if (sel.rangeCount && sigEditor.contains(sel.anchorNode)) sigRange = sel.getRangeAt(0).cloneRange();
}

function restoreSelection() {
  sigEditor.focus();
  if (!sigRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(sigRange);
}

sigEditor.addEventListener("keyup", rememberSelection);
sigEditor.addEventListener("mouseup", rememberSelection);
sigEditor.addEventListener("input", rememberSelection);

for (const b of document.querySelectorAll(".sig-toolbar [data-cmd]")) {
  b.addEventListener("mousedown", (ev) => ev.preventDefault()); // keep the selection in the editor
  b.addEventListener("click", () => {
    restoreSelection();
    document.execCommand(b.dataset.cmd);
    rememberSelection();
  });
}

$("sig-clear").addEventListener("mousedown", (ev) => ev.preventDefault());
$("sig-clear").addEventListener("click", () => {
  restoreSelection();
  document.execCommand("removeFormat");
  document.execCommand("unlink");
});

$("sig-link").addEventListener("mousedown", (ev) => ev.preventDefault());
$("sig-link").addEventListener("click", () => {
  rememberSelection();
  $("sig-link-row").hidden = false;
  $("sig-link-url").focus();
});

$("sig-link-add").addEventListener("click", () => {
  let url = $("sig-link-url").value.trim();
  if (url && !/^(https?:|mailto:)/i.test(url)) url = (url.includes("@") ? "mailto:" : "https://") + url;
  $("sig-link-row").hidden = true;
  $("sig-link-url").value = "";
  if (!url) return;
  restoreSelection();
  const sel = window.getSelection();
  if (sel.isCollapsed) document.execCommand("insertHTML", false, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
  else document.execCommand("createLink", false, url);
});
$("sig-link-url").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    $("sig-link-add").click();
  }
});

$("sig-image").addEventListener("mousedown", (ev) => ev.preventDefault());
$("sig-image").addEventListener("click", () => {
  rememberSelection();
  $("sig-file").value = "";
  $("sig-file").click();
});

$("sig-file").addEventListener("change", () => {
  const file = $("sig-file").files[0];
  if (!file) return;
  if (file.size > 300 * 1024) toast(`The image is ${formatSize(file.size)}: it will be sent with every email. Consider a smaller one.`, "info");
  const reader = new FileReader();
  reader.onload = () => {
    restoreSelection();
    document.execCommand("insertHTML", false, `<img src="${reader.result}" alt="" style="max-width:240px">`);
    rememberSelection();
  };
  reader.readAsDataURL(file);
});

$("sig-html").addEventListener("click", () => showSignatureSource($("sig-source").hidden));

// ---------- address suggestions ----------

let wasUsingContacts = false; // the option was already on when the settings opened
// Last result of reading the address book, shown in the settings.
state.contactsStatus = { text: "", denied: false };

/// Reads the system address book. Problems are shown in the settings, and as a
/// message only when `announce` is set (the user has just turned the option on).
async function loadContacts(announce = false) {
  try {
    state.contacts = await invoke("system_contacts");
    const n = new Set(state.contacts.map((c) => c.email.toLowerCase())).size;
    state.contactsStatus = { text: `${n} address${n === 1 ? "" : "es"} from Contacts`, denied: false };
    if (announce) toast(state.contactsStatus.text, "info");
  } catch (e) {
    state.contacts = [];
    const text = String(e);
    state.contactsStatus = { text, denied: text.startsWith("macOS has not allowed") };
    if (announce) toast(text + (state.contactsStatus.denied ? " You can allow it from the settings." : ""));
  }
  showContactsStatus();
}

function showContactsStatus() {
  const on = $("set-contacts").checked;
  $("contacts-status").textContent = on ? state.contactsStatus.text : "";
  $("contacts-privacy").hidden = !(on && state.contactsStatus.denied);
}

$("set-contacts").addEventListener("change", showContactsStatus);
$("contacts-privacy").addEventListener("click", () => invoke("open_contacts_privacy").catch(() => {}));

/// All known addresses: address book + senders of the loaded emails.
function addressPool() {
  const seen = new Map();
  for (const c of state.contacts) {
    const k = c.email.toLowerCase();
    if (!seen.has(k)) seen.set(k, { name: c.name, email: c.email });
  }
  for (const list of Object.values(state.cards)) {
    for (const c of list) {
      const k = (c.from_address || "").toLowerCase();
      if (k && !seen.has(k)) seen.set(k, { name: c.from === c.from_address ? "" : c.from, email: c.from_address });
    }
  }
  return [...seen.values()];
}

const suggest = { input: null, items: [], active: 0 };

function currentToken(input) {
  const v = input.value.slice(0, input.selectionStart);
  const start = Math.max(v.lastIndexOf(","), v.lastIndexOf(";")) + 1;
  return { start, text: v.slice(start).trim() };
}

function hideSuggestions() {
  $("suggestions").hidden = true;
  suggest.input = null;
}

function showSuggestions(input) {
  const { text } = currentToken(input);
  if (text.length < 2) return hideSuggestions();
  const q = text.toLowerCase();
  const items = addressPool()
    .filter((c) => c.email.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const sa = a.name.toLowerCase().startsWith(q) || a.email.toLowerCase().startsWith(q) ? 0 : 1;
      const sb = b.name.toLowerCase().startsWith(q) || b.email.toLowerCase().startsWith(q) ? 0 : 1;
      return sa - sb || (a.name || a.email).localeCompare(b.name || b.email);
    })
    .slice(0, 8);
  if (!items.length) return hideSuggestions();
  suggest.input = input;
  suggest.items = items;
  suggest.active = 0;
  const list = $("suggestions");
  list.replaceChildren(
    ...items.map((c, i) => {
      const li = el("li", i === 0 ? "active" : "");
      li.append(el("span", "", c.name || c.email), el("span", "s-email", c.name ? c.email : ""));
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault(); // keep focus in the field
        pickSuggestion(i);
      });
      return li;
    }),
  );
  const r = input.getBoundingClientRect();
  list.style.left = r.left + "px";
  list.style.top = r.bottom + 4 + "px";
  list.style.width = r.width + "px";
  list.hidden = false;
}

function pickSuggestion(i) {
  const input = suggest.input;
  const c = suggest.items[i];
  if (!input || !c) return;
  const { start } = currentToken(input);
  // Use "Name <address>" only when the name has no characters that would break the list.
  const entry = c.name && !/[,;"<>]/.test(c.name) ? `${c.name} <${c.email}>` : c.email;
  const before = input.value.slice(0, start);
  const after = input.value.slice(input.selectionStart).replace(/^[^,;]*[,;]?\s*/, "");
  const prefix = before ? before.replace(/\s*$/, "") + " " : "";
  input.value = prefix + entry + ", " + after;
  const pos = (prefix + entry + ", ").length;
  input.setSelectionRange(pos, pos);
  hideSuggestions();
}

for (const id of ["compose-to", "compose-cc", "compose-bcc", "set-bcc"]) {
  const input = $(id);
  input.addEventListener("input", () => showSuggestions(input));
  input.addEventListener("blur", hideSuggestions);
  input.addEventListener("keydown", (ev) => {
    if ($("suggestions").hidden || suggest.input !== input) return;
    const lis = $("suggestions").children;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      lis[suggest.active]?.classList.remove("active");
      const n = suggest.items.length;
      suggest.active = (suggest.active + (ev.key === "ArrowDown" ? 1 : n - 1)) % n;
      lis[suggest.active]?.classList.add("active");
      lis[suggest.active]?.scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      pickSuggestion(suggest.active);
    } else if (ev.key === "Escape") {
      ev.stopPropagation();
      hideSuggestions();
    }
  });
}

start();
