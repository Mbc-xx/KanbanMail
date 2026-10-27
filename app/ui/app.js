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
  onlyUnread: false,
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
  if (!confirm("Disconnect this account? The password will be removed from the keychain.")) return;
  await invoke("forget_account").catch((e) => toast(String(e)));
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
      if (settings.use_system_contacts) loadContacts();
    } catch (_) {}
    setSyncStatus(info.can_idle ? "Live updates on (IDLE)" : "Refreshing every 60 seconds");
    $("sidebar").classList.toggle("collapsed", local.get("sidebar") === "hidden");
    state.view = null;
    renderColumns();
    show("board-screen");
    loadFolders();
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
  const board = $("board");
  board.replaceChildren();
  for (const col of visibleColumns()) {
    const column = el("section", state.view ? "column wide" : "column");
    column.dataset.folder = col.folder;

    const head = el("header", "column-head");
    head.append(el("h2", "", col.name), el("span", "count muted", ""), el("span", "unread", ""), el("span", "folder muted", col.folder));
    const cards = el("div", "cards");
    cards.append(el("div", "empty muted", "Loading…"));
    column.append(head, cards);
    if (!state.view) setupResizer(column);
    setupDropTarget(column);
    board.append(column);
  }
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
  const list = state.onlyUnread ? all.filter((c) => !c.seen) : all;
  const container = column.querySelector(".cards");
  container.replaceChildren();
  if (!list.length) {
    container.append(el("div", "empty muted", state.onlyUnread && all.length ? "No unread emails" : "No emails"));
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
  fromLine.append(el("span", "from", card.from || "(unknown sender)"), el("span", "date", formatDate(card.date)));
  const actions = el("div", "card-actions");
  const action = (cls, icon, title, run) => {
    const b = el("button", "card-btn " + cls, icon);
    b.title = title;
    b.draggable = false;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      run();
    });
    actions.append(b);
  };
  const kind = folderKind(folder);
  if (kind !== "archive") action("archive-btn", "🗄", "Archive", () => fileCard(folder, card, "archive"));
  if (kind !== "trash") action("trash-btn", "🗑", "Delete (move to trash)", () => fileCard(folder, card, "trash"));
  action("pin-btn", "📌", card.flagged ? "Unpin" : "Pin (keep at the top of the column)", () => togglePin(folder, card, c));
  c.append(actions, fromLine, el("div", "subject", card.subject || "(no subject)"), el("div", "preview", card.preview));

  c.addEventListener("click", () => openReader(folder, card));
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

$("only-unread").addEventListener("change", (ev) => {
  state.onlyUnread = ev.target.checked;
  for (const c of state.columns) renderCards(c.folder);
});

$("refresh").addEventListener("click", () => {
  for (const c of visibleColumns()) loadColumn(c.folder);
  loadFolders();
});

// ---------- sidebar ----------

const FOLDER_ICONS = { inbox: "📥", drafts: "📝", sent: "📤", archive: "🗄", junk: "⚠️", trash: "🗑" };

async function loadFolders() {
  try {
    state.folders = await invoke("list_folders");
    renderFolders();
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
    item.append(el("span", "", FOLDER_ICONS[f.kind] || "📁"), el("span", "label", f.label));
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

// In the HTML view: no scripts, no network, only inline styles and embedded images.
const FRAME_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

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
  $("reader-seen").textContent = readerCard.card.seen ? "Mark as unread" : "Mark as read";
}

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

async function openReader(folder, card) {
  readerCard = { folder, card };
  readerMessage = null;
  updateSeenButton();
  $("reader-reply").disabled = $("reader-reply-all").disabled = true;
  $("reader-trash").hidden = folderKind(folder) === "trash";
  $("reader-subject").textContent = card.subject || "(no subject)";
  $("reader-from").textContent = card.from;
  $("reader-to").textContent = "";
  $("reader-cc").textContent = "";
  $("reader-cc").hidden = $("reader-cc-label").hidden = true;
  $("reader-date").textContent = formatDate(card.date, true);
  $("reader-toggle").hidden = true;
  $("reader-body").replaceChildren(el("pre", "muted", "Loading…"));
  $("reader").hidden = false;
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
    $("reader-toggle").hidden = !(msg.html && msg.text);
    renderReaderBody();
  } catch (e) {
    $("reader-body").replaceChildren(el("pre", "error", String(e)));
  }
}

function renderReaderBody() {
  const msg = readerMessage;
  const body = $("reader-body");
  if (readerMode === "html" && msg.html) {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", ""); // no scripts, no navigation
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.srcdoc =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
      `<style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:16px;color:#1c1f24;overflow-wrap:anywhere}img{max-width:100%}</style>` +
      `</head><body>${msg.html}</body></html>`;
    body.replaceChildren(frame);
    $("reader-toggle").textContent = "Show plain text";
  } else {
    body.replaceChildren(el("pre", "", msg.text || "(no text)"));
    $("reader-toggle").textContent = "Show HTML version";
  }
}

$("reader-toggle").addEventListener("click", () => {
  readerMode = readerMode === "html" ? "text" : "html";
  renderReaderBody();
});

function closeReader() {
  stopSeenTimer();
  $("reader").hidden = true;
  $("reader-body").replaceChildren();
  readerMessage = null;
  readerCard = null;
}
$("reader-close").addEventListener("click", closeReader);
$("reader").addEventListener("click", (ev) => {
  if (ev.target === $("reader")) closeReader();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (!$("composer").hidden) closeComposer();
  else if (!$("settings").hidden) $("settings").hidden = true;
  else if (!$("reader").hidden) closeReader();
});

// ---------- writing and replying ----------

let composeReply = null; // { folder, uid } of the email being replied to
let composeContext = null; // { in_reply_to, references }
let composeInitial = "";

function composeSnapshot() {
  return ["compose-to", "compose-cc", "compose-subject", "compose-body"].map((id) => $(id).value).join("\u0000");
}

function openComposer({ to = "", cc = "", subject = "", body = "", reply = null, context = null, title = "New email" } = {}) {
  $("compose-title").textContent = title;
  $("compose-to").value = to;
  $("compose-cc").value = cc;
  $("compose-subject").value = subject;
  $("compose-body").value = body;
  $("compose-from").textContent = "From: " + state.email;
  composeReply = reply;
  composeContext = context;
  composeInitial = composeSnapshot();
  $("composer").hidden = false;
  const body_ = $("compose-body");
  if (to) {
    body_.focus();
    body_.setSelectionRange(0, 0);
    body_.scrollTop = 0;
  } else {
    $("compose-to").focus();
  }
}

function closeComposer(force = false) {
  if (!force && composeSnapshot() !== composeInitial && !confirm("Close without sending? What you wrote will be lost.")) return;
  $("composer").hidden = true;
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

$("compose-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!$("compose-subject").value.trim() && !confirm("This email has no subject. Send it anyway?")) return;
  const btn = $("compose-send");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const result = await invoke("send_mail", {
      draft: {
        to: $("compose-to").value,
        cc: $("compose-cc").value,
        subject: $("compose-subject").value,
        body: $("compose-body").value,
        in_reply_to: composeContext?.in_reply_to ?? null,
        references: composeContext?.references ?? [],
      },
      reply: composeReply,
    });
    closeComposer(true);
    if (result.warning) toast(result.warning);
    else toast(`Email sent (copy saved to ${result.saved_to})`, "info");
  } catch (e) {
    toast("Sending failed: " + e);
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
    $("set-signature").value = s.signature;
    $("set-contacts").checked = s.use_system_contacts;
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
  try {
    await invoke("save_settings", {
      settings: {
        email: state.email,
        display_name: $("set-name").value,
        smtp_server: $("set-smtp").value,
        smtp_port: parseInt($("set-port").value, 10),
        mark_read_after_seconds: seconds,
        signature: $("set-signature").value,
        use_system_contacts: $("set-contacts").checked,
      },
    });
    if ($("set-contacts").checked) loadContacts();
    else state.contacts = [];
    state.markReadAfter = seconds;
    state.signature = $("set-signature").value.trimEnd();
    $("settings").hidden = true;
    toast("Settings saved", "info");
  } catch (e) {
    toast("Settings not saved: " + e);
  }
});

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
