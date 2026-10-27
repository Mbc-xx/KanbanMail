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
function toast(message, kind = "error") {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast" + (kind === "info" ? " info" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === "info" ? 2500 : 7000);
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
      await openBoard();
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
  await invoke("forget_account").catch((e) => toast(String(e)));
  invoke("set_unread_badge", { count: 0 }).catch(() => {});
  $("settings").hidden = true;
  state.columns = [];
  state.cards = {};
  show("login");
});

// ---------- board ----------

async function openBoard() {
  show("loading");
  $("loading-text").textContent = "Preparing columns…";
  try {
    const info = await invoke("open_board");
    state.columns = info.columns;
    $("config-path").textContent = info.config_path;
    $("settings-config-path").textContent = info.config_path;
    try {
      const settings = await invoke("get_settings");
      state.markReadAfter = settings.mark_read_after_seconds;
      state.signature = settings.signature;
      state.signatureHtml = settings.signature_html;
      state.loadRemoteImages = settings.load_remote_images;
      state.allow = settings.important_allow;
      state.block = settings.important_block;
      state.sameDomain = settings.important_same_domain;
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
    head.append(el("h2", "", col.name), el("span", "count muted", ""), el("span", "unread", ""), el("span", "folder muted", col.folder));
    const cards = el("div", state.view ? "cards rows" : "cards");
    cards.append(el("div", "empty muted", "Loading…"));
    column.append(head, cards);
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
  try {
    state.cards[folder] = await invoke("load_column", { folder });
    renderCards(folder);
  } catch (e) {
    toast(`Could not load ${folder}: ${e}`);
  }
}

/// Reloads a folder after a server notification, batching notifications close together.
function scheduleReload(folder) {
  scheduleFolderCounts();
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
  const list = all.filter((c) => (!state.onlyUnread || !c.seen) && (!state.onlyImportant || importance(c).important));
  const container = column.querySelector(".cards");
  container.replaceChildren();
  if (!list.length) {
    const filtered = all.length && (state.onlyUnread || state.onlyImportant);
    container.append(el("div", "empty muted", filtered ? "No emails match the filters" : "No emails"));
    return;
  }
  for (const card of list) container.append(renderCard(folder, card));
}

function renderCard(folder, card) {
  const c = el("div", "card");
  if (card.flagged) c.classList.add("pinned");
  if (!card.seen) c.classList.add("unseen");
  c.draggable = true;
  c.dataset.uid = card.uid;

  const fromLine = el("div", "from-line");
  fromLine.append(el("span", "from", card.from || "(unknown sender)"));
  if (card.has_attachments) fromLine.append(icon("paperclip", "clip"));
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
  if (kind !== "archive") action("archive-btn", "archive", "Archive", () => fileCard(folder, card, "archive"));
  if (kind !== "trash") action("trash-btn", "trash", "Delete (move to trash)", () => fileCard(folder, card, "trash"));
  action("pin-btn", "pin", card.flagged ? "Unpin" : "Pin (keep at the top of the column)", () => togglePin(folder, card, c));
  if (state.view) {
    // Compact row for the folder view.
    const main = el("div", "row-main");
    main.append(el("span", "row-subject", card.subject || "(no subject)"), el("span", "row-preview", card.preview ? "  —  " + card.preview : ""));
    const date = el("span", "row-date");
    if (card.has_attachments) date.append(icon("paperclip", "clip"));
    date.append(document.createTextNode(formatDate(card.date)));
    c.append(el("span", "row-from", card.from || "(unknown sender)"), main, date, actions);
    if (readerCard && readerCard.folder === folder && readerCard.card.uid === card.uid) c.classList.add("selected");
  } else {
    c.append(actions, fromLine, el("div", "subject", card.subject || "(no subject)"), el("div", "preview", card.preview));
  }

  c.addEventListener("click", () => (kind === "drafts" ? openDraft(folder, card) : openReader(folder, card)));
  c.addEventListener("dragstart", (ev) => {
    state.dragging = { folder, uid: card.uid };
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
    moveCard(drag.folder, drag.uid, folder);
  });
}

async function moveCard(from, uid, to) {
  // Optimistic move: the card changes column immediately, then the server confirms.
  const list = state.cards[from] || [];
  const idx = list.findIndex((c) => c.uid === uid);
  if (idx < 0) return;
  const [card] = list.splice(idx, 1);
  const moved = { ...card };
  state.cards[to] = [moved, ...(state.cards[to] || [])];
  renderCards(from);
  renderCards(to);
  const movedEl = columnEl(to)?.querySelector(`.card[data-uid="${uid}"]`);
  movedEl?.classList.add("busy");

  try {
    await invoke("move_card", { from, uid, to });
  } catch (e) {
    toast("Move failed: " + e);
  }
  await Promise.all([from, to].filter((f) => columnEl(f)).map(loadColumn));
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

function renderFolders() {
  const nav = $("folder-list");
  nav.replaceChildren();
  for (const f of state.folders) {
    const item = el("button", "nav-item");
    item.style.paddingLeft = 8 + f.depth * 14 + "px";
    item.title = f.name;
    if (state.view?.folder === f.name) item.classList.add("active");
    item.append(icon(FOLDER_ICONS[f.kind] || "folder"), el("span", "label", f.label));
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
    if (drag && drag.folder !== folder) moveCard(drag.folder, drag.uid, folder);
  });
}

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
$("toggle-sidebar").addEventListener("click", toggleSidebar);
document.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "b" && !$("board-screen").hidden) {
    ev.preventDefault();
    toggleSidebar();
  }
});

listen("folder-changed", (ev) => scheduleReload(ev.payload));

// ---------- reading ----------

// In the HTML view: no scripts and no network, only inline styles and embedded
// images. Remote images are allowed only when the user asks for them.
const FRAME_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
const FRAME_CSP_REMOTE_IMAGES = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:";

let readerRemoteAllowed = false;
let readerQuoteShown = false; // show the quoted earlier messages
let readerThread = null; // entries of the current conversation, oldest first

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
  renderCards(folder);
  try {
    const target = await invoke("file_card", { folder, uid: card.uid, kind });
    toast(`Moved to ${target}`, "info");
  } catch (e) {
    toast((kind === "trash" ? "Delete" : "Archive") + " failed: " + e);
  }
  await Promise.all(
    state.columns.concat(visibleColumns()).map((c) => c.folder).filter((f, i, a) => a.indexOf(f) === i && columnEl(f)).map(loadColumn),
  );
  scheduleFolderCounts();
}

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
  const col = columnEl(readerCard.folder);
  col?.querySelector(`.card[data-uid="${readerCard.card.uid}"]`)?.classList.add("selected");
}

async function openReader(folder, card, opts = {}) {
  readerCard = { folder, card };
  readerMessage = null;
  readerQuoteShown = false;
  if (!opts.thread) readerThread = null;
  renderThread();
  placeReader();
  markSelectedRow();
  updateSeenButton();
  $("reader-reply").disabled = $("reader-reply-all").disabled = true;
  $("reader-trash").hidden = folderKind(folder) === "trash";
  $("rule-scope").value = "address";
  updateSenderPanel();
  $("reader-subject").textContent = card.subject || "(no subject)";
  $("reader-from").textContent = card.from;
  $("reader-to").textContent = "";
  $("reader-cc").textContent = "";
  $("reader-cc").hidden = $("reader-cc-label").hidden = true;
  $("reader-date").textContent = formatDate(card.date, true);
  $("reader-toggle").hidden = true;
  $("reader-attachments").hidden = true;
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
    renderReaderBody();
    if (opts.then === "reply") replyTo(false);
    if (opts.thread) {
      readerThread = opts.thread;
      renderThread();
    } else {
      loadThread(folder, card, msg);
    }
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
    renderThread();
  } catch (e) {
    console.error("conversation lookup failed", e);
  }
}

const AVATAR_COLORS = ["#4f8fd6", "#43a07a", "#c4684f", "#8a6fd1", "#c98a2e", "#3e9bb0", "#b85c8f"];

function avatar(name) {
  const a = el("span", "avatar", (name.trim()[0] || "?").toUpperCase());
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  a.style.background = AVATAR_COLORS[h % AVATAR_COLORS.length];
  return a;
}

/// Earlier and later emails of the conversation as compact rows around the open one.
function renderThread() {
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
    frame.setAttribute("sandbox", ""); // no scripts, no navigation
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.srcdoc =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${readerRemoteAllowed ? FRAME_CSP_REMOTE_IMAGES : FRAME_CSP}">` +
      `<style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:16px;color:#1c1f24;overflow-wrap:anywhere}img{max-width:100%}</style>` +
      `</head><body>${html}</body></html>`;
    body.replaceChildren(frame);
    $("reader-toggle").textContent = "Show plain text";
  } else {
    body.replaceChildren(el("pre", "", text || "(no text)"));
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
};

function composeSnapshot() {
  return ["compose-to", "compose-cc", "compose-subject", "compose-body"].map((id) => $(id).value).join("\u0000");
}

function composeDraft() {
  return {
    to: $("compose-to").value,
    cc: $("compose-cc").value,
    subject: $("compose-subject").value,
    body: $("compose-body").value,
    in_reply_to: compose.context?.in_reply_to ?? null,
    references: compose.context?.references ?? [],
    message_id: compose.messageId,
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

async function openComposer({ to = "", cc = "", subject = "", body = "", reply = null, context = null, title = "New email", messageId = null, fromDraft = false } = {}) {
  $("compose-title").textContent = title;
  $("compose-to").value = to;
  $("compose-cc").value = cc;
  $("compose-subject").value = subject;
  $("compose-body").value = body;
  $("compose-from").textContent = "From: " + state.email;
  setComposeStatus("");
  compose.reply = reply;
  compose.context = context;
  compose.initial = compose.saved = composeSnapshot();
  compose.hasDraft = fromDraft;
  compose.messageId = messageId;
  $("composer").hidden = false;
  const bodyEl = $("compose-body");
  if (to) {
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
    openComposer({
      to: msg.to,
      cc: msg.cc,
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
  const btn = $("compose-send");
  btn.disabled = true;
  btn.textContent = "Sending…";
  clearInterval(compose.timer);
  if (compose.saving) await compose.saving;
  try {
    const result = await invoke("send_mail", { draft: composeDraft(), reply: compose.reply });
    hideComposer();
    // People you just wrote to become known senders right away.
    for (const part of (composeDraft().to + "," + composeDraft().cc).split(/[,;]/)) {
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

$("open-settings").addEventListener("click", async () => {
  try {
    const s = await invoke("get_settings");
    $("settings-email").textContent = "Account: " + s.email;
    $("set-name").value = s.display_name;
    $("set-smtp").value = s.smtp_server;
    $("set-port").value = String(s.smtp_port);
    loadSignatureEditor(s.signature, s.signature_html);
    $("set-contacts").checked = s.use_system_contacts;
    $("set-remote").checked = s.load_remote_images;
    $("set-same-domain").checked = s.important_same_domain;
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
        use_system_contacts: $("set-contacts").checked,
        load_remote_images: $("set-remote").checked,
        important_allow: $("set-allow").value.split(/[\n,;]+/),
        important_block: $("set-block").value.split(/[\n,;]+/),
        important_same_domain: $("set-same-domain").checked,
      },
    });
    const saved = await invoke("get_settings");
    state.allow = saved.important_allow;
    state.block = saved.important_block;
    state.sameDomain = saved.important_same_domain;
    for (const c of visibleColumns()) renderCards(c.folder);
    if ($("set-contacts").checked) loadContacts();
    else state.contacts = [];
    state.markReadAfter = seconds;
    state.signature = sig.text;
    state.signatureHtml = sig.html;
    state.loadRemoteImages = $("set-remote").checked;
    $("settings").hidden = true;
    toast("Settings saved", "info");
  } catch (e) {
    toast("Settings not saved: " + e);
  }
});

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
}

/// Plain-text and HTML versions of the signature. The HTML version is kept
/// only when there is real formatting (bold, links, images...).
function readSignatureEditor() {
  showSignatureSource(false); // innerText needs the editor visible
  const text = sigEditor.innerText.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const rich = sigEditor.querySelector("img, a, b, strong, i, em, u, font, table, [style], h1, h2, h3, ul, ol");
  return { text, html: rich ? sigEditor.innerHTML.trim() : "" };
}

function showSignatureSource(show) {
  const source = $("sig-source");
  if (show === !source.hidden) return;
  if (show) source.value = sigEditor.innerHTML;
  else sigEditor.innerHTML = source.value;
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

async function loadContacts() {
  try {
    state.contacts = await invoke("system_contacts");
  } catch (e) {
    state.contacts = [];
    toast(String(e));
  }
}

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

for (const id of ["compose-to", "compose-cc"]) {
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
