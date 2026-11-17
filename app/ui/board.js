// Pigeonhole: the board, its columns and cards, the sidebar and the important senders.
// Loaded after app.js; all the files share one global scope, in this order.

// ---------- board ----------

// ---------- local cache for an instant start ----------

const cacheKey = (k) => `cache:${state.accountId}:${k}`;

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
    for (const k of Object.keys(localStorage)) if (k.startsWith(`cache:${state.accountId}:`)) localStorage.removeItem(k);
  } catch (_) {}
}

/// The board (not a folder) with the sidebar and filter as the user left them.
function restoreBoardView() {
  $("sidebar").classList.toggle("collapsed", local.get("sidebar") === "hidden");
  state.onlyImportant = local.get("onlyImportant") === "1";
  $("only-important").setAttribute("aria-pressed", state.onlyImportant);
  state.view = null;
  renderColumns();
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
  restoreBoardView();
  renderFolders();
  // The cards come from the copy on this Mac (older versions kept them here too).
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(cacheKey("cards:"))) localStorage.removeItem(k);
  } catch (_) {}
  setSyncStatus("Updating…");
  show("board-screen");
  fillFromLocalCopy(columns.map((c) => c.folder));
  return true;
}

/// The cards kept in the copy on this Mac, shown while the server is reached.
function fillFromLocalCopy(folders) {
  for (const folder of folders) {
    invoke("cached_column", { folder, limit: state.limits[folder] || state.defaultLimit })
      .then((cached) => {
        // Only until the server answers: its list is the fresher one.
        if (!cached.length || state.fresh.has(folder)) return;
        state.cards[folder] = cached;
        renderCards(folder);
      })
      .catch(() => {});
  }
}

function applySettingsState(settings) {
  state.markReadAfter = settings.mark_read_after_seconds;
  state.signature = settings.signature;
  state.signatureHtml = settings.signature_html;
  state.senders = settings.senders || [];
  state.displayName = settings.display_name || "";
  state.defaultBcc = settings.default_bcc;
  state.loadRemoteImages = settings.load_remote_images;
  state.allow = settings.important_allow;
  state.block = settings.important_block;
  state.sameDomain = settings.important_same_domain;
  state.groupThreads = settings.group_threads;
  state.folderPrefs = settings.folders || [];
  state.rules = settings.rules || [];
  state.templates = settings.templates || [];
  state.notify = settings.notify || "important";
  state.onlyToMe = !!settings.only_to_me;
  state.countImportant = settings.count_unread === "important";
  state.myAddresses = settings.my_addresses || [];
  state.undoSeconds = settings.undo_seconds ?? 8;
  state.undoSendSeconds = settings.undo_send_seconds ?? 10;
  state.appearance = { theme: settings.theme, zoom: settings.zoom, preview_board: settings.preview_board, preview_list: settings.preview_list, compact_actions: settings.compact_actions, mail_surface: settings.mail_surface, theme_per_account: !!settings.theme_per_account };
  state.askConversation = settings.ask_conversation ?? true;
  state.afterAction = settings.after_action || "list";
  applyAppearance(state.appearance);
  state.waitingSetting = settings.waiting_folder || "";
  state.waitingDays = settings.waiting_days ?? 3;
  state.todoSetting = settings.todo_folder || "";
  state.todoDays = settings.todo_days ?? 5;
  state.doneSetting = settings.done_folder || "";
  state.doneDays = settings.done_days ?? 0;
  state.doneTarget = settings.done_target || "";
  updateBadge();
}

async function openBoard({ fromCache = false, retry = false } = {}) {
  if (!fromCache) {
    show("loading");
    $("loading-text").textContent = "Preparing columns…";
  }
  try {
    const info = await invoke("open_board");
    state.columns = info.columns;
    state.defaultLimit = info.limit || 200;
    cacheSet("board", info.columns);
    $("settings-config-path").textContent = info.config_path;
    try {
      const settings = await invoke("get_settings");
      applySettingsState(settings);
      cacheSet("settings", settings);
      if (settings.use_system_contacts) loadContacts();
      if (settings.notify !== "off") prepareNotifications();
    } catch (_) {}
    setSyncStatus(info.can_idle ? "Live updates on (IDLE)" : "Refreshing every 60 seconds");
    clearTimeout(offlineTimer);
    if (state.offline) {
      state.offline = false;
      toast("Connected again", "info");
    }
    // Changes made offline go to the server first, then the lists are refreshed.
    invoke("flush_queue").then((n) => {
      state.queued = n;
      setSyncStatus();
    }).catch(() => {});
    restoreBoardView();
    show("board-screen");
    loadFolders();
    loadKnownSenders();
    invoke("list_tasks").then(setTasks, () => setTasks([]));
    await Promise.all(state.columns.map((c) => loadColumn(c.folder)));
    refreshDrafts(0);
    wakeSnoozed();
    checkOtherAccounts();
    // Rules and notifications also work when the Inbox is not a board column.
    if (!state.columns.some((c) => c.folder.toUpperCase() === "INBOX")) checkInbox();
  } catch (e) {
    if (fromCache) {
      // Keep showing the last known board (and the copy on this Mac) and retry.
      if (!retry) {
        renderColumns();
        for (const c of state.columns) renderCards(c.folder);
        show("board-screen");
        for (const c of state.columns) loadColumn(c.folder);
      }
      if (isOfflineError(e)) goOffline();
      else {
        setSyncStatus("Not connected");
        toast("Could not connect to the server: " + e);
      }
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
    if (state.view?.task) {
      const open = el("button", "head-btn", "Open task");
      open.title = state.view.task.url;
      open.addEventListener("click", () => openLink(state.view.task.url));
      head.append(open);
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

/// Follows a drag started on `handle`: `onMove(dx)` while moving, `onEnd()` when released.
function trackDrag(handle, ev, onMove, onEnd) {
  handle.setPointerCapture(ev.pointerId);
  handle.classList.add("active");
  document.body.classList.add("resizing");
  const startX = ev.clientX;
  const move = (e) => onMove(e.clientX - startX);
  const up = () => {
    for (const [type, fn] of [["pointermove", move], ["pointerup", up], ["pointercancel", up]]) handle.removeEventListener(type, fn);
    handle.classList.remove("active");
    document.body.classList.remove("resizing");
    onEnd();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

function setupSplitHandle(split, handle) {
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const list = split.querySelector(".column");
    const startW = list.getBoundingClientRect().width;
    trackDrag(
      handle,
      ev,
      (dx) => {
        const max = split.getBoundingClientRect().width - 340;
        split.style.setProperty("--list-width", Math.round(Math.min(max, Math.max(280, startW + dx))) + "px");
      },
      () => local.set("listwidth", String(Math.round(list.getBoundingClientRect().width))),
    );
  });
}

// ---------- column width ----------

// Board columns share the window by weight: dragging an edge changes the proportions,
// resizing the window keeps them. Refresh goes back to equal widths.
const COL_MIN = 160;
const WEIGHTS_KEY = "colweights";

function savedWeights() {
  try { return JSON.parse(local.get(WEIGHTS_KEY) || "{}"); } catch (_) { return {}; }
}

function applyWeight(column, weight) {
  column.style.flex = weight > 0 ? `${weight} 1 0px` : "";
}

function boardColumns() {
  return [...$("board").querySelectorAll(":scope > .column")];
}

/// The proportions on screen, saved with an average of 1 (a new column gets 1).
function saveWeights() {
  const cols = boardColumns();
  const widths = cols.map((c) => c.getBoundingClientRect().width);
  const mean = widths.reduce((a, b) => a + b, 0) / widths.length;
  const weights = {};
  cols.forEach((c, i) => (weights[c.dataset.folder] = +(widths[i] / mean).toFixed(3)));
  local.set(WEIGHTS_KEY, JSON.stringify(weights));
}

function resetColumnWidths() {
  local.set(WEIGHTS_KEY, "");
  if (!state.view) boardColumns().forEach((c) => applyWeight(c, 0));
}

/// Handle on the right edge: drag to resize, double-click to go back to the average width.
function setupResizer(column) {
  const folder = column.dataset.folder;
  applyWeight(column, savedWeights()[folder]);
  try { localStorage.removeItem("colwidth:" + folder); } catch (_) {} // fixed widths of older versions

  const handle = el("div", "col-resizer");
  handle.title = "Drag to resize · double-click for the average width";
  column.append(handle);

  let lastDown = 0;
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    // Double-click detected by hand: preventDefault can suppress "dblclick".
    if (ev.timeStamp - lastDown < 350) {
      lastDown = 0;
      const weights = savedWeights();
      delete weights[folder];
      local.set(WEIGHTS_KEY, JSON.stringify(weights));
      applyWeight(column, 0);
      return;
    }
    lastDown = ev.timeStamp;
    // This column follows the pointer; the others share the rest in their proportions.
    const cols = boardColumns();
    const i = cols.indexOf(column);
    const widths = cols.map((c) => c.getBoundingClientRect().width);
    const total = widths.reduce((a, b) => a + b, 0);
    const others = total - widths[i];
    if (!others) return;
    let moved = false;
    trackDrag(
      handle,
      ev,
      (dx) => {
        moved = true;
        const w = Math.max(COL_MIN, Math.min(total - (cols.length - 1) * COL_MIN, widths[i] + dx));
        cols.forEach((c, j) => applyWeight(c, j === i ? w : (widths[j] * (total - w)) / others));
      },
      () => moved && saveWeights(),
    );
  });
}

function columnEl(folder) {
  return [...document.querySelectorAll(".column")].find((c) => c.dataset.folder === folder);
}

async function loadColumn(folder) {
  if (folder === SEARCH_KEY) return runSearch();
  if (folder === ALL_KEY) return loadAllMail();
  if (folder === TASK_KEY) return loadTask();
  // What is already known (in memory or on this Mac) is shown at once, then
  // refreshed from the server.
  if (state.cards[folder]?.length) {
    if (!columnEl(folder)?.querySelector(".card")) renderCards(folder); // just switched view
  } else {
    try {
      const cached = await invoke("cached_column", { folder, limit: state.limits[folder] || state.defaultLimit });
      if (cached.length && !state.cards[folder]?.length) {
        state.cards[folder] = cached;
        renderCards(folder);
      }
    } catch (_) {}
  }
  try {
    const cards = await invoke("load_column", { folder, limit: state.limits[folder] || null });
    state.fresh.add(folder);
    // Nothing changed (the usual case on a refresh): keep the list on screen,
    // and the card objects its buttons act on.
    const same = columnEl(folder)?.querySelector(".card") && JSON.stringify(cards) === JSON.stringify(state.cards[folder]);
    if (!same) {
      state.cards[folder] = cards;
      renderCards(folder);
    }
    if (folder.toUpperCase() === "INBOX") {
      afterInboxLoaded(state.cards[folder]);
      paintFolderCounts();
    }
    if (folder === draftsFolder()) indexDrafts();
  } catch (e) {
    // Keep showing what is known (from this Mac, or loaded before).
    renderCards(folder);
    if (isOfflineError(e)) goOffline();
    else toast(`Could not load ${folder}: ${e}`);
  }
}

listen("queue-changed", (ev) => {
  state.queued = ev.payload || 0;
  setSyncStatus();
});
listen("queue-error", (ev) => toast(String(ev.payload)));
listen("queue-flushed", () => {
  for (const c of visibleColumns()) loadColumn(c.folder);
  scheduleFolderCounts();
});

// ---------- new Inbox emails: rules and notifications ----------

state.limits = {}; // folder -> how many emails to load ("Load more")
state.fresh = new Set(); // folders already loaded from the server
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
  // The highest Inbox UID already checked by the rules, remembered across
  // restarts: emails that arrived while the app was closed are newer.
  const lastChecked = cacheGet("rulesLastUid");
  const maxUid = cards.reduce((m, c) => Math.max(m, c.uid), 0);
  const fresh = first
    ? lastChecked === null
      ? [] // very first run: nothing to catch up on
      : cards.filter((c) => c.uid > lastChecked)
    : cards.filter((c) => !inboxKnown.has(c.uid));
  inboxKnown = new Set(cards.map((c) => c.uid));
  if (maxUid > (lastChecked || 0)) cacheSet("rulesLastUid", maxUid);
  if (!fresh.length) return;
  const moved = await applyRules(fresh);
  // No notifications for the emails that arrived while the app was closed.
  if (first) return;
  const toNotify = fresh.filter(
    (c) => !c.seen && !moved.has(c.message_id) && (state.notify === "all" || (state.notify === "important" && importance(c).important)),
  );
  if (!toNotify.length) return;
  const target = toNotify.length === 1 ? { folder: "INBOX", uid: toNotify[0].uid } : { folder: "INBOX" };
  const [title, body] =
    toNotify.length === 1
      ? [toNotify[0].from || toNotify[0].from_address, toNotify[0].subject || "(no subject)"]
      : [`${toNotify.length} new emails`, toNotify.slice(0, 3).map((c) => `${shortName(c.from)}: ${c.subject}`).join("\n")];
  showNotification(title, body, target).catch(() => {});
}

/// Keeps rules and notifications working while the Inbox is not on screen.
async function checkInbox() {
  try {
    const cards = await invoke("load_column", { folder: "INBOX", limit: null });
    state.cards.INBOX = cards;
    afterInboxLoaded(cards);
    paintFolderCounts();
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

/// Redraws the lists on screen once, at the next frame, however many changes
/// asked for it in the meantime (at start several arrive within moments).
let renderFrame = 0;
function renderSoon() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    for (const c of visibleColumns()) renderCards(c.folder);
  });
}

function renderCards(folder) {
  const waiting = waitingFolder();
  if (folder !== waiting) scheduleWaitingRender();
  const column = columnEl(folder);
  if (!column) return;
  updateFilterCounts();
  const all = state.cards[folder] || [];
  state.waitingCtx = folder === waiting ? waitingContext(all) : null;
  // The board only: a column's age means nothing in a folder list.
  const todo = !state.view && state.todoDays > 0 && folder === todoFolder();
  state.todoCtx = todo ? columnSince(folder, all, true) : null;
  if (!state.view && folder === doneFolder()) {
    columnSince(folder, all, false);
    if (state.fresh.has(folder)) setTimeout(sweepDone);
  }
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
  // Conversations, worked out once for the late count and the cards.
  let groups = null;
  const groupsOf = (cards) => (cards === list || cards.length === list.length ? (groups ??= groupByThread(list, folder)) : groupByThread(cards, folder));
  // Late emails, or conversations when they are grouped: as the tags count them.
  const mine = myAddresses();
  const units = !todo ? [] : state.groupThreads ? groupsOf(all).map((g) => g.members) : all.map((card) => [{ folder, card }]);
  const late = units.filter((members) => daysInColumn(state.todoCtx, members, mine) >= state.todoDays).length;
  let lateBadge = column.querySelector(".late-count");
  if (late && !lateBadge) {
    lateBadge = el("span", "late-count");
    column.querySelector(".unread").after(lateBadge);
  }
  if (!state.view && folder === todoFolder()) {
    state.today.late = late;
    renderToday();
  }
  if (!state.view && state.waitingCtx) {
    const waitUnits = state.groupThreads ? groupsOf(all).map((g) => g.members) : all.map((card) => [{ folder, card }]);
    const answers = waitUnits.map((m) => waitingAnswer(m).answer).filter(Boolean);
    state.today.replied = answers.length;
    renderToday();
    if (state.fresh.has(folder)) noticeReplies(answers);
  }
  if (lateBadge) {
    lateBadge.hidden = !late;
    lateBadge.textContent = `${late} late`;
    lateBadge.title = `${late} ${state.groupThreads ? "conversation" : "email"}${late === 1 ? "" : "s"} in this column for ${state.todoDays} days or more`;
  }
  const container = column.querySelector(".cards");
  // Emptying the list sends it back to the top in WebKit: redrawing keeps the place,
  // except when a filter changed and this is a different list.
  const shown = JSON.stringify([state.onlyUnread, state.onlyImportant, $("search").value]);
  const scrollTop = container.dataset.shown === shown ? container.scrollTop : 0;
  container.dataset.shown = shown;
  container.replaceChildren();
  container.classList.toggle("threads", !!state.groupThreads);
  if (!list.length) {
    if (searching) {
      container.append(el("div", "empty muted", state.view.searchDone ? "No emails found" : "Searching…"));
      appendServerSearch(container);
      return;
    }
    const filtered = all.length && (state.onlyUnread || state.onlyImportant || state.filter);
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
    for (const g of groupsOf(list)) {
      const thread = g.members.length > 1 ? g : null;
      const rep = renderCard(g.rep.folder, g.rep.card, thread);
      container.append(rep);
      // An expanded conversation in a folder list shows each of its emails below,
      // including those in other folders (Sent, Archive…), as one block.
      if (state.view && state.expanded.has(threadKey(g))) {
        const kids = threadChildren(g, folder).map((m) => (m.loading ? el("div", "thread-loading muted", "Looking for the rest of the conversation…") : renderCard(m.folder, m.card, null, { child: true })));
        if (kids.length) {
          rep.classList.add("thread-open");
          kids[0].classList.add("thread-start");
          kids.at(-1).classList.add("thread-end");
          container.append(...kids);
        }
      }
    }
  } else {
    for (const card of list) container.append(renderCard(card.__folder || folder, card));
  }
  const more = loadMore();
  if (more) container.append(more);
  if (searching) appendServerSearch(container);
  container.scrollTop = scrollTop;
}

// ---------- waiting for an answer ----------

/// The board column of emails waiting for an answer (null when there is none).
/// The board column chosen in the settings for a role ("" = found by its name).
function roleColumn(choice, names) {
  if (choice === "none") return null;
  if (choice && state.columns?.some((c) => c.folder === choice)) return choice;
  return state.columns?.find((c) => names.test(c.name.trim()))?.folder || null;
}

const WAITING_NAMES = /^(waiting|attesa|in attesa)$/i;
const TODO_NAMES = /^(to ?do|da fare|todo)$/i;
const DONE_NAMES = /^(done|fatto|fatti|finished|completed|completat[oie])$/i;

const waitingFolder = () => roleColumn(state.waitingSetting || "", WAITING_NAMES);
const todoFolder = () => roleColumn(state.todoSetting || "", TODO_NAMES);
const doneFolder = () => roleColumn(state.doneSetting || "", DONE_NAMES);

function renderColumnChoice(id, current, name) {
  const select = $(id);
  select.replaceChildren(new Option(`Automatic (the column named “${name}”)`, ""), new Option("None", "none"));
  for (const c of state.columns || []) select.append(new Option(c.name, c.folder));
  select.value = [...select.options].some((o) => o.value === current) ? current : "";
}

const renderWaitingChoices = (current) => renderColumnChoice("set-waiting", current, "Waiting");

// ---------- how long emails have been in a column ----------

/// When each email of a column arrived there, as first seen by the app
/// (Message-ID -> seconds), kept per account and column. Emails already there
/// the first time count from their own date when `fromDate`, else from now.
function columnSince(folder, cards, fromDate, oldKey = null) {
  const key = `since:${state.accountId}:${folder}`;
  // Versions before 2.7 kept the Waiting column's times under another name.
  const saved = local.get(key) ?? (oldKey && local.get(oldKey));
  let since = null;
  try {
    since = JSON.parse(saved || "null");
  } catch (_) {}
  const firstTime = !since;
  since = since || {};
  const now = Math.floor(Date.now() / 1000);
  const present = {};
  for (const card of cards) {
    const id = mailId(card.message_id);
    if (id) present[id] = since[id] ?? (firstTime && fromDate ? card.date : now);
  }
  const text = JSON.stringify(present);
  if ((cards.length || !firstTime) && text !== saved) local.set(key, text);
  return { since: present, now };
}

/// The addresses I write from: the account and its extra senders.
function myAddresses() {
  return new Set([state.email, ...(state.senders || []).map((x) => x.email)].map((a) => (a || "").trim().toLowerCase()).filter(Boolean));
}

/// Whole days an email (or conversation) has waited in its column. A
/// conversation counts from its newest email written by someone else (my own
/// replies do not make the work done), or from my newest when it has only
/// mine. An email counts from when it showed up in the column, or from its
/// date when it arrived while the app was closed.
function daysInColumn(ctx, members, mine = myAddresses()) {
  const at = (m) => ctx.since[mailId(m.card.message_id)] ?? ctx.now;
  const start = Math.min(...members.map(at));
  const theirs = members.filter((m) => !mine.has((m.card.from_address || "").toLowerCase()));
  const entered = Math.max(...(theirs.length ? theirs : members).map((m) => Math.min(at(m), Math.max(m.card.date, start))));
  return Math.floor((ctx.now - entered) / 86400);
}

/// "Todo · 6 days" on an email that has waited too long in the to-do column.
function todoTag(members) {
  const ctx = state.todoCtx;
  if (!ctx) return null;
  const days = daysInColumn(ctx, members);
  if (days < state.todoDays) return null;
  const tag = el("span", "wait-tag " + (days >= 2 * state.todoDays ? "overdue" : "late"), `To do · ${days} days`);
  tag.title = `In this column for ${days} days`;
  return tag;
}

/// Finished emails older than the chosen time leave the done column, at most
/// once an hour, with Undo. Pinned and unread emails stay.
let doneSweptAt = 0;
async function sweepDone() {
  const done = doneFolder();
  if (!done || !(state.doneDays > 0) || !state.fresh.has(done) || Date.now() - doneSweptAt < 3600_000) return;
  doneSweptAt = Date.now();
  const cards = state.cards[done] || [];
  const ctx = columnSince(done, cards, false);
  const old = cards.filter((card) => !card.flagged && card.seen && card.message_id && ctx.now - (ctx.since[mailId(card.message_id)] ?? ctx.now) >= state.doneDays * 86400);
  if (!old.length) return;
  let target;
  try {
    target = await invoke("ensure_folder", { name: state.doneTarget });
  } catch (e) {
    return toast("Could not move the finished emails: " + e);
  }
  if (target === done) return;
  const moves = await moveEmails(old.map((card) => ({ folder: done, card })), { to: target, quiet: true });
  const n = moves.filter((m) => m.now).length;
  if (n) offerUndo(`${n === 1 ? "1 email" : n + " emails"} done for over ${state.doneDays} days moved to ${folderLabel(target)}`, moves);
}

let waitingRenderTimer;
/// Other folders changed: the answers shown in the waiting column may have too.
function scheduleWaitingRender() {
  clearTimeout(waitingRenderTimer);
  waitingRenderTimer = setTimeout(() => {
    const f = waitingFolder();
    if (f && columnEl(f)) renderCards(f);
  }, 80);
}

/// What the waiting column needs to tag its cards: the answers that arrived
/// (newest card referring to each Message-ID) and since when each email waits.
function waitingContext(cards) {
  refreshSentForWaiting();
  const bare = mailId;
  const me = (state.email || "").toLowerCase();
  const waiting = waitingFolder();
  const answers = new Map();
  // My own latest email in each conversation (a reminder restarts the wait).
  const mine = new Map();
  const noteMine = (card) => {
    for (const id of [card.message_id, ...(card.thread_refs || [])].map(bare)) {
      if (id && !(mine.get(id) >= card.date)) mine.set(id, card.date);
    }
  };
  for (const card of state.sentCards) noteMine(card);
  for (const [folder, list] of Object.entries(state.cards)) {
    const kind = folderKind(folder);
    if (["drafts", "trash", "junk"].includes(kind)) continue;
    for (const card of list) {
      if (kind === "sent" || (card.from_address || "").toLowerCase() === me) {
        noteMine(card);
        continue;
      }
      if (folder === waiting) continue;
      for (const id of (card.thread_refs || []).map(bare)) {
        const known = answers.get(id);
        if (id && (!known || known.card.date < card.date)) answers.set(id, { folder: card.__folder || folder, card });
      }
    }
  }
  // When each email entered the column (first seen there); emails already
  // there the first time count from their own date.
  const { since, now } = columnSince(waiting, cards, true, "waiting:" + state.accountId);
  return { bare, answers, mine, since, now };
}

// The Sent folder is read (newest 200, at most once a minute) so that a
// reminder you send restarts the wait of the email in the waiting column.
state.sentCards = [];
let sentLoadedAt = 0;
let sentLoading = false;
const SENT_RECHECK_MS = 3000;
function refreshSentForWaiting(force = false) {
  const sent = state.folders?.find((f) => f.kind === "sent")?.name;
  if (!sent || !waitingFolder() || sentLoading || (!force && Date.now() - sentLoadedAt < 60_000)) return;
  sentLoading = true;
  invoke("load_column", { folder: sent, limit: 200 })
    .then((cards) => {
      state.sentCards = cards;
      sentLoadedAt = Date.now();
      scheduleWaitingRender();
    })
    .catch((e) => console.error(e))
    .finally(() => (sentLoading = false));
}

/// The "Replied" / "Waiting N days" tags of an email (or conversation) in the waiting column.
/// The answer that arrived to an email (or conversation) of the waiting
/// column after my last message in it (null when none), and that last message's date.
function waitingAnswer(members, ctx = state.waitingCtx) {
  // The wait starts when the email entered the column or when I last wrote in
  // the conversation, whichever is later; only answers after that count.
  let lastMine = Math.max(...members.map((m) => m.card.date));
  for (const { card } of members) {
    for (const id of [card.message_id, ...(card.thread_refs || [])].map(ctx.bare)) {
      if (id && ctx.mine.get(id) > lastMine) lastMine = ctx.mine.get(id);
    }
  }
  let answer = null;
  for (const { card } of members) {
    for (const id of [card.message_id, ...(card.thread_refs || [])].map(ctx.bare)) {
      const a = id && ctx.answers.get(id);
      if (a && a.card.date > lastMine && (!answer || answer.card.date < a.card.date)) answer = a;
    }
  }
  return { answer, lastMine };
}

function waitingTags(members) {
  const ctx = state.waitingCtx;
  if (!ctx) return null;
  const { answer, lastMine } = waitingAnswer(members, ctx);
  const box = el("div", "wait-tags");
  if (answer) {
    const tag = el("button", "wait-tag replied", "↩ Replied · " + shortName(answer.card.from));
    tag.type = "button";
    tag.draggable = false;
    tag.title = `${answer.card.from} answered on ${formatDate(answer.card.date, true)}: open the answer`;
    tag.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openReader(answer.folder, answer.card);
    });
    box.append(tag);
  } else if (state.waitingDays > 0) {
    const entered = Math.min(...members.map((m) => ctx.since[ctx.bare(m.card.message_id)] ?? m.card.date));
    const started = Math.max(entered, lastMine);
    const days = Math.floor((ctx.now - started) / 86400);
    if (days >= state.waitingDays) {
      const tag = el("span", "wait-tag late", `Waiting ${days} days`);
      tag.title = "No answer yet in this conversation";
      box.append(tag);
    }
  }
  return box.childElementCount ? box : null;
}

state.expanded = new Set(); // conversations opened with › in folder lists

state.threadCache = new Map(); // conversation key -> its emails in every folder

/// The emails of an expanded conversation: the ones in this list plus those
/// found in other folders (looked up once, then shown).
function threadChildren(group, listFolder) {
  const key = threadKey(group);
  const found = state.threadCache.get(key);
  if (found === undefined) {
    state.threadCache.set(key, null);
    const refs = [...new Set(group.members.flatMap((m) => m.card.thread_refs || []))];
    const messageId = group.rep.card.message_id;
    (async () => {
      // What this Mac knows first, then the server.
      let local = [];
      try {
        local = await invoke("local_thread", { messageId, references: refs });
        if (local.length && state.expanded.has(key)) {
          state.threadLocal = state.threadLocal || new Map();
          state.threadLocal.set(key, local);
          renderCards(listFolder);
        }
      } catch (_) {}
      try {
        const entries = await invoke("load_thread", { folder: group.rep.folder, messageId, references: refs, columns: state.columns.map((c) => c.folder) });
        state.threadCache.set(key, mergeThread(local, entries));
      } catch (e) {
        console.error("conversation lookup failed", e);
        state.threadCache.set(key, local);
      }
      state.threadLocal?.delete(key);
      renderCards(listFolder);
    })();
  }
  const all = new Map();
  const id = (m) => (m.card.message_id || "").toLowerCase() || `${m.folder}/${m.card.uid}`;
  for (const m of [...group.members, ...(found || state.threadLocal?.get(key) || [])]) if (!all.has(id(m))) all.set(id(m), m);
  const out = [...all.values()].sort((a, b) => b.card.date - a.card.date);
  if (!found) out.push({ loading: true });
  return out;
}

/// Replies can belong to a longer conversation, even when the rest is in another folder.
function hasConversation(card) {
  return (card.thread_refs || []).length > 0;
}

/// A conversation keeps its key while new emails arrive: its oldest email.
function threadKey(group) {
  const first = group.members[group.members.length - 1];
  return first.card.message_id || `${first.folder}/${first.card.uid}`;
}

/// Groups cards of a list into conversations (Message-ID, In-Reply-To and
/// References links). Each group: { rep: newest {folder, card}, members: [...] }.
function groupByThread(list, folder) {
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map(); // message id -> index of the first card that mentions it
  const bare = mailId;
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

/// What the search box asks for: plain words plus from:, to:, subject:, after:,
/// before: and date: (a day 2026-10-05 or 5/10/2026, a month 2026-10, a year 2026;
/// both ends included). Quotes keep words together: from:"Rachel Green".
/// Days are sent as "YYYY-MM-DD", `before` being the first day left out.
function parseQuery(text) {
  const q = { words: [], from: [], to: [], subject: [], since: null, before: null };
  for (const m of text.matchAll(/(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g)) {
    const key = m[1]?.toLowerCase();
    const value = (m[2] ?? m[3] ?? "").trim();
    const days = ["after", "before", "date"].includes(key) && dayRange(value);
    const word = (m[4] ?? m[5] ?? m[0]).trim();
    if (["from", "to", "subject"].includes(key) && value) q[key].push(value);
    else if (days) {
      if (key !== "before") q.since = days[0];
      if (key !== "after") q.before = days[1];
    } else if (word) q.words.push(word);
  }
  return q;
}

/// A day, month or year as [first day, first day after], both "YYYY-MM-DD".
function dayRange(text) {
  let m;
  let [y, mo, d] = [0, 0, 0];
  if ((m = text.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/))) [y, mo, d] = [+m[1], +(m[2] || 0), +(m[3] || 0)];
  else if ((m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/))) [d, mo, y] = [+m[1], +m[2], +m[3] < 100 ? 2000 + +m[3] : +m[3]];
  else if ((m = text.match(/^(\d{1,2})[/.](\d{4})$/))) [mo, y] = [+m[1], +m[2]];
  else return null;
  if (mo > 12 || d > 31) return null;
  const start = new Date(y, (mo || 1) - 1, d || 1);
  const end = d ? new Date(y, mo - 1, d + 1) : mo ? new Date(y, mo, 1) : new Date(y + 1, 0, 1);
  const pad = (n) => String(n).padStart(2, "0");
  return [start, end].map((t) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`);
}

/// The search box filters the loaded cards as you type (accents and case ignored).
function boardFilter(text) {
  const q = parseQuery(text);
  if (!q.since && !q.before && ![q.words, q.from, q.to, q.subject].some((l) => l.length)) return null;
  const f = (list) => list.map(fold);
  const time = (day) => day && new Date(day + "T00:00").getTime() / 1000;
  return { words: f(q.words), from: f(q.from), to: f(q.to), subject: f(q.subject), since: time(q.since), before: time(q.before) };
}

function matchesFilter(card) {
  const q = state.filter;
  if (!q || state.view?.search) return true;
  const has = (text, words) => {
    const t = fold(text);
    return words.every((w) => t.includes(w));
  };
  const sender = card.from + " " + card.from_address;
  return (
    has([sender, card.subject, card.preview].join(" "), q.words) &&
    has(sender, q.from) &&
    has(card.to, q.to) &&
    has(card.subject, q.subject) &&
    (!q.since || card.date >= q.since) &&
    (!q.before || card.date < q.before)
  );
}

// Pointing at an email for a moment starts downloading it, so that the click
// opens it at once. Once per email; the backend skips it when busy.
const warmed = new Set();
let warmTimer;
function warmSoon(folder, card) {
  clearTimeout(warmTimer);
  const key = selKey(folder, card);
  if (warmed.has(key) || MULTI_KEYS.includes(folder) || folderKind(folder) === "drafts") return;
  warmTimer = setTimeout(() => {
    warmed.add(key);
    invoke("warm_message", { folder, uid: card.uid }).catch(() => warmed.delete(key));
  }, 150);
}

/// One email, or a whole conversation when `group` is given (shown through its newest email).
function renderCard(folder, card, group = null, { child = false } = {}) {
  const members = group ? group.members : [{ folder, card }];
  const c = el("div", child ? "card child" : "card");
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
  fromLine.append(el("span", "unread-dot"), avatar(card.from || card.from_address || "?"), el("span", "from", fromText));
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
  if (kind !== "archive") action("archive-btn", "archive", `Archive ${what}`, () => fileMany(members, "archive"));
  if (kind !== "trash") action("trash-btn", "trash", `Delete ${what} (move to trash)`, () => fileMany(members, "trash"));
  const pinned = members.some((m) => m.card.flagged);
  action("pin-btn", "pin", pinned ? "Unpin" : "Pin (keep at the top of the column)", () => pinMany(members, !pinned, c));
  if (state.view) {
    // Compact row for the folder view.
    const main = el("div", "row-main");
    // Inside an expanded conversation each email shows the start of its text.
    if (child) main.append(el("span", "row-subject", card.preview || card.subject || "(no subject)"));
    else main.append(el("span", "row-subject", card.subject || "(no subject)"));
    const date = el("span", "row-date");
    if (anyAttachment) date.append(icon("paperclip", "clip"));
    date.append(document.createTextNode(formatDate(card.date)));
    if (state.view?.multi) date.prepend(...folderTags(members));
    else if (child && folder !== state.view.folder) date.prepend(folderTag(folder));
    const from = el("span", "row-from");
    const thread = group || (!child && state.groupThreads && hasConversation(card) ? { members, rep: { folder, card } } : null);
    if (thread) {
      const open = state.expanded.has(threadKey(thread));
      const chev = el("button", "chevron" + (open ? " open" : ""));
      chev.type = "button";
      chev.draggable = false;
      chev.title = open ? "Hide the emails of this conversation" : "Show the emails of this conversation";
      chev.append(icon("chevron"));
      chev.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const key = threadKey(thread);
        if (state.expanded.delete(key)) state.threadCache.delete(key); // looked up again next time
        else state.expanded.add(key);
        renderCards(c.closest(".column").dataset.folder);
      });
      from.append(chev);
    } else if (!child && state.groupThreads) {
      from.append(el("span", "chevron-space"));
    }
    from.append(el("span", "unread-dot"), avatar(card.from || card.from_address || "?"), el("span", "row-name", child ? card.from || "(unknown sender)" : fromText));
    // In lists the number counts the unread emails of the conversation.
    const unreadInThread = members.filter((m) => !m.card.seen).length;
    if (group && unreadInThread) {
      const b = el("span", "thread-count unread-count", String(unreadInThread));
      b.title = `${unreadInThread} unread of ${members.length} emails in this conversation`;
      from.append(b);
    }
    const tags = waitingTags(members);
    if (tags) date.prepend(tags);
    date.prepend(...taskTags(members));
    const todoLate = todoTag(members);
    if (todoLate) date.prepend(todoLate);
    const unsent = draftTag(members, folder);
    if (unsent) date.prepend(unsent);
    const back = snoozeTag(members);
    if (back) date.prepend(back);
    c.append(from, main, date, actions);
    // Preview below, from under the sender to under the subject.
    if (card.preview && !child) c.append(el("div", "row-preview", card.preview));
    if (readerCard && readerCard.folder === folder && readerCard.card.uid === card.uid) c.classList.add("selected");
  } else {
    c.append(actions, fromLine, el("div", "subject", card.subject || "(no subject)"), el("div", "preview", card.preview));
    const extra = [draftTag(members, folder), snoozeTag(members), todoTag(members), ...taskTags(members)].filter(Boolean);
    const tags = waitingTags(members) || (extra.length ? el("div", "wait-tags") : null);
    if (tags) {
      tags.append(...extra);
      c.append(tags);
    }
  }

  if (members.every((m) => state.selection.has(selKey(m.folder, m.card)))) c.classList.add("multi-selected");
  if (focusKey === selKey(folder, card)) c.classList.add("kbd-focus");
  c.menuInfo = { folder, card, members }; // for the right-click menu
  c.addEventListener("click", (ev) => {
    // ⌘/Ctrl-click toggles the selection, Shift-click selects a range.
    if (ev.metaKey || ev.ctrlKey) return toggleSelection(members, c);
    if (ev.shiftKey) return selectRange(c);
    if (state.selection.size) clearSelection();
    kind === "drafts" ? openDraft(folder, card) : openReader(folder, card);
  });
  c.addEventListener("mouseenter", () => warmSoon(folder, card));
  c.addEventListener("mouseleave", () => clearTimeout(warmTimer));
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

// ---------- right-click menu on cards ----------

// One listener for every card: the menu is built only when it opens.
document.addEventListener("contextmenu", (ev) => {
  const c = ev.target.closest?.(".card");
  if (!c?.menuInfo) return;
  ev.preventDefault();
  openCardMenu(c, ev.clientX, ev.clientY);
});

/// The actions of a card (an email or a conversation), or of every selected
/// card when it is part of a multiple selection.
function openCardMenu(c, x, y) {
  const { folder, card, members } = c.menuInfo;
  const inSelection = members.every((m) => state.selection.has(selKey(m.folder, m.card)));
  if (state.selection.size && !inSelection) clearSelection();
  const batch = inSelection && state.selection.size > members.length ? [...state.selection.values()] : null;
  let scope = "all"; // on a conversation card: "one" = only the email shown
  const targets = () => batch || (scope === "one" ? [{ folder, card }] : members);
  const run = (fn) => () => {
    const list = targets();
    closeConvMenu();
    if (batch) clearSelection();
    fn(list);
  };

  const fill = (menu) => {
    menu.replaceChildren();
    const list = targets();
    const n = list.length;
    const count = n > 1 ? ` (${n})` : "";
    if (batch) menu.append(el("div", "menu-head", `${n} selected emails`));
    else if (members.length > 1) {
      const toggle = el("div", "scope-toggle");
      for (const [value, text] of [["one", "This email"], ["all", `Conversation (${members.length})`]]) {
        const b = el("button", value === scope ? "active" : "", text);
        b.type = "button";
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          scope = value;
          fill(menu);
        });
        toggle.append(b);
      }
      menu.append(toggle);
    }
    const sep = () => menu.append(el("div", "menu-sep"));
    const kinds = new Set(list.map((m) => folderKind(m.folder)));
    if (!batch) {
      if (folderKind(folder) === "drafts") menu.append(menuButton("compose", "Edit draft", run(() => openDraft(folder, card))));
      else
        menu.append(
          menuButton("reply", "Reply", run(() => openReader(folder, card, { then: "reply" }))),
          menuButton("reply-all", "Reply all", run(() => openReader(folder, card, { then: "reply-all" }))),
          menuButton("forward", "Forward", run(() => openReader(folder, card, { then: "forward" }))),
        );
      sep();
    }
    const unread = list.some((m) => !m.card.seen);
    const pinned = list.some((m) => m.card.flagged);
    menu.append(
      menuButton(unread ? "envelope-open" : "envelope", (unread ? "Mark as read" : "Mark as unread") + count, run((l) => markMany(l, unread))),
      menuButton("pin", (pinned ? "Unpin" : "Pin") + count, run((l) => pinMany(l, !pinned, c))),
    );
    sep();
    if (!(kinds.size === 1 && kinds.has("archive"))) menu.append(menuButton("archive", "Archive" + count, run((l) => fileMany(l, "archive", { conversation: !batch }))));
    if (!(kinds.size === 1 && kinds.has("trash"))) menu.append(menuButton("trash", "Delete" + count, run((l) => fileMany(l, "trash", { conversation: !batch }))));
    menu.append(
      kinds.size === 1 && kinds.has("junk")
        ? menuButton("inbox", "Not spam" + count, run((l) => moveMany(l, "INBOX")))
        : menuButton("junk", "Spam" + count, run((l) => fileMany(l, "junk", { conversation: !batch }))),
      menuButton("folder", "Move to…" + count, () => fillFolders(menu)),
      menuButton("link", "Link to a task…" + count, () => fillTasks(menu)),
      menuButton("calendar", "Snooze…" + count, () => fillSnoozeMenu(menu, targets(), [menuButton("back", "Back", () => fill(menu)), el("div", "menu-sep")])),
    );
    sep();
    if (batch) menu.append(menuButton("close", "Clear the selection", run(() => clearSelection())));
    else {
      const selected = members.every((m) => state.selection.has(selKey(m.folder, m.card)));
      menu.append(menuButton("check", selected ? "Deselect" : "Select (⌘-click)", run(() => toggleSelection(members, c))));
      if (card.from_address) {
        const who = shortName(card.from) || card.from_address;
        sep();
        menu.append(
          menuButton("important", `Always important: ${who}`, run(() => setSenderRule("allow", card, "address"))),
          menuButton("important-off", `Never important: ${who}`, run(() => setSenderRule("block", card, "address"))),
          menuButton("search", `Emails from ${who}`, run(() => startSearch(card.from_address))),
          menuButton("rule", `New rule for ${card.from_address}…`, run(async () => (await openSettings()) && (showSettingsTab("folders"), addRule(card.from_address)))),
        );
      }
    }
  };

  // "Move to…": the folders in place of the actions, with a way back.
  const fillFolders = (menu) => {
    const here = new Set(targets().map((m) => m.folder));
    const head = [menuButton("back", "Back", () => fill(menu)), el("div", "menu-sep")];
    fillMoveList(menu, head, here.size === 1 ? [...here][0] : null, (to) => run((l) => moveMany(l, to, { conversation: !batch }))());
  };

  // "Link to a task…": paste its link or pick one already in use.
  const fillTasks = (menu) => {
    const head = [menuButton("back", "Back", () => fill(menu)), el("div", "menu-sep")];
    fillTaskPicker(menu, head, targets(), run(() => {}));
  };

  popMenuAt(x, y, fill).classList.add("card-menu");
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
  renderSoon();
}

/// Reads again what a change touched: the given folders, or every list on
/// screen when they are not known. Lists made of several folders always are.
async function afterBulkChange(folders = null) {
  const touched = folders && new Set(folders);
  const columns = visibleColumns().filter((c) => !touched || touched.has(c.folder) || MULTI_KEYS.includes(c.folder));
  await Promise.all(columns.map((c) => loadColumn(c.folder)));
  scheduleFolderCounts();
}

/// "1 email", "3 emails", or "All 3 emails of the conversation".
function countEmails(n, conversation = false) {
  if (conversation && n > 1) return `All ${n} emails of the conversation`;
  return `${n} email${n === 1 ? "" : "s"}`;
}

/// Moves emails to a folder (`to`) or to the archive, trash or junk (`kind`),
/// then offers Undo. Returns [{ message_id, now, back }].
async function moveEmails(members, { to = "", kind = "", quiet = false, conversation = false } = {}) {
  dropFromLists(members);
  const target = to || state.folders.find((f) => f.kind === kind)?.name;
  for (const m of members) if (!m.card.seen) moveUnseen(m.folder, target);
  paintFolderCounts();
  const moves = [];
  let failed = 0;
  let error = "";
  // One request per folder, however many emails: each one costs a round trip.
  const groups = new Map();
  for (const m of members) {
    if (kind && folderKind(m.folder) === kind) continue; // already there
    if (!groups.has(m.folder)) groups.set(m.folder, []);
    groups.get(m.folder).push(m);
  }
  for (const [folder, list] of groups) {
    const uids = list.map((m) => m.card.uid);
    try {
      const now = kind ? await invoke("file_cards", { folder, uids, kind }) : (await invoke("move_cards", { from: folder, uids, to })) ? to : "";
      for (const m of list) moves.push({ message_id: m.card.message_id, now, back: m.folder });
    } catch (e) {
      failed += list.length;
      error = String(e);
      console.error(e);
    }
  }
  const what = countEmails(members.length, conversation);
  const where = folderLabel(moves.find((m) => m.now)?.now || to || kind);
  if (failed) toast(`${failed} of ${members.length} emails could not be moved: ${error}`);
  else if (moves.some((m) => !m.now)) toast(`No connection: ${what.toLowerCase()} will be moved to ${where} when the server can be reached`, "info");
  else if (!quiet) offerUndo(`${what} moved to ${where}`, moves);
  await afterBulkChange([...groups.keys(), target, ...moves.map((m) => m.now)]);
  return moves;
}

function moveMany(members, to, opts = {}) {
  return moveEmails(members, { ...opts, to });
}

function fileMany(members, kind, opts = {}) {
  return moveEmails(members, { ...opts, kind });
}

async function pinMany(members, pinned, cardEl) {
  cardEl.classList.add("busy");
  for (const m of members) {
    try {
      await invoke("set_pin", { folder: m.folder, uid: m.card.uid, pinned });
    } catch (e) {
      toast("Pin not changed: " + e);
    }
  }
  await afterBulkChange(members.map((m) => m.folder));
  cardEl.classList.remove("busy");
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
  if (!card.seen) {
    moveUnseen(from, to);
    paintFolderCounts();
  }
  renderCards(from);
  for (const key of MULTI_KEYS) renderCards(key);
  renderCards(to);
  const movedEl = columnEl(to)?.querySelector(`.card[data-uid="${uid}"]`);
  movedEl?.classList.add("busy");

  try {
    const now = await invoke("move_cards", { from, uids: [uid], to });
    if (now) offerUndo(`Moved to ${folderLabel(to)}`, [{ message_id: card.message_id, now: to, back: from }]);
    else toast(`No connection: it will be moved to ${folderLabel(to)} when the server can be reached`, "info");
  } catch (e) {
    toast("Move failed: " + e);
  }
  await Promise.all([from, to].filter((f) => columnEl(f)).map(loadColumn));
  if (state.view?.search) runSearch();
  scheduleFolderCounts();
}

$("only-important").addEventListener("click", (ev) => {
  state.onlyImportant = !state.onlyImportant;
  ev.currentTarget.setAttribute("aria-pressed", state.onlyImportant);
  local.set("onlyImportant", state.onlyImportant ? "1" : "");
  renderSoon();
});

// ---------- important senders ----------

const KNOWN_REFRESH_MS = 30 * 60 * 1000;

// Reading them means going through the sent emails on a connection of its
// own: the list kept from last time is used at once, and read again only
// when it is old.
const KNOWN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function rememberKnownSenders(at = cacheGet("known")?.at || 0) {
  cacheSet("known", { at, list: [...state.known] });
}

async function loadKnownSenders() {
  const saved = cacheGet("known");
  const show = () => {
    paintFolderCounts();
    renderSoon();
    if (readerCard) updateSenderPanel();
  };
  if (saved?.list?.length && !state.known.size) {
    state.known = new Set(saved.list);
    show();
  }
  if (saved && Date.now() - saved.at < KNOWN_MAX_AGE_MS) return;
  try {
    state.known = new Set(await invoke("known_senders"));
    rememberKnownSenders(Date.now());
    show();
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
/// Is your address (or an alias) in To, not only in Cc? Cards saved before
/// To was kept apart count as sent to you.
function sentToMe(card) {
  const to = (card.to_only || card.to || "").toLowerCase().split(/,\s*/);
  return [state.email, ...state.myAddresses].some((a) => to.includes(a.toLowerCase()));
}

function importance(card) {
  const a = (card.from_address || "").toLowerCase();
  const rule = senderRule(a);
  if (rule) return { important: rule.rule === "allow", why: rule.rule === "allow" ? `Your rule: ${rule.pattern} is always important` : `Your rule: ${rule.pattern} is never important` };
  if (card.automated) return { important: false, why: "Automated email (notification, newsletter or mailing list)" };
  if (a && a === state.email.toLowerCase()) return { important: true, why: "Sent by you" };
  if (state.onlyToMe && !sentToMe(card)) return { important: false, why: "You are only in Cc, or not among the recipients" };
  if (state.known.has(a)) return { important: true, why: "You have written to this person" };
  if (state.contacts.some((c) => c.email.toLowerCase() === a)) return { important: true, why: "In your contacts" };
  if (state.sameDomain && a && domainOf(a) === domainOf(state.email)) return { important: true, why: "Colleague (same domain as you)" };
  return { important: false, why: "You have never written to this sender" };
}

function updateSenderPanel() {
  const card = readerCard?.card;
  if (!card) return;
  const info = importance(card);
  $("sender-why").textContent = info.why;
  $("importance-label").textContent = info.important ? "Important" : "Not important";
  $("reader-importance").classList.toggle("important", info.important);
  $("reader-importance").querySelector("use").setAttribute("href", info.important ? "#i-important" : "#i-important-off");
  const rule = senderRule(card.from_address || "");
  $("rule-allow").classList.toggle("active", rule?.rule === "allow");
  $("rule-block").classList.toggle("active", rule?.rule === "block");
  if (rule) $("rule-scope").value = rule.pattern.startsWith("@") ? "domain" : "address";
  const disabled = !card.from_address;
  $("rule-allow").disabled = $("rule-block").disabled = $("rule-scope").disabled = disabled;
}

async function setSenderRule(kind, card = readerCard?.card, scope = $("rule-scope").value) {
  if (!card?.from_address) return;
  const current = senderRule(card.from_address);
  const pattern = scope === "domain" ? domainOf(card.from_address) : card.from_address.toLowerCase();
  // Clicking the active rule again removes it.
  const rule = current && current.rule === kind && current.pattern === pattern ? "none" : kind;
  try {
    [state.allow, state.block] = await invoke("set_sender_rule", { pattern, rule });
    updateSenderPanel();
    showImportanceMenu(false);
    paintFolderCounts();
    renderSoon();
    toast(rule === "none" ? `Rule removed for ${pattern}` : `${pattern} is now ${kind === "allow" ? "always" : "never"} important`, "info");
  } catch (e) {
    toast("Rule not saved: " + e);
  }
}

/// The menu of the importance chip: why, and the rules for this sender.
function showImportanceMenu(open) {
  $("importance-menu").hidden = !open;
  $("reader-importance").setAttribute("aria-expanded", String(open));
}
$("reader-importance").addEventListener("click", (ev) => {
  ev.stopPropagation();
  showImportanceMenu($("importance-menu").hidden);
});
$("importance-menu").addEventListener("click", (ev) => ev.stopPropagation());
document.addEventListener("click", () => showImportanceMenu(false));
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$("importance-menu").hidden) {
    ev.stopPropagation();
    showImportanceMenu(false);
  }
}, true);
$("rule-allow").addEventListener("click", () => setSenderRule("allow"));
$("rule-block").addEventListener("click", () => setSenderRule("block"));

$("only-unread").addEventListener("click", (ev) => {
  state.onlyUnread = !state.onlyUnread;
  ev.currentTarget.setAttribute("aria-pressed", state.onlyUnread);
  renderSoon();
});

/// The numbers on the filter buttons: unread emails, and the important ones among them,
/// in the lists on screen.
/// Asked for by every column drawn: counted once for all those drawn together.
let filterCountsQueued = false;
function updateFilterCounts() {
  if (filterCountsQueued) return;
  filterCountsQueued = true;
  queueMicrotask(() => {
    filterCountsQueued = false;
    countFilters();
  });
}

function countFilters() {
  if (state.view?.search) return;
  let unread = 0;
  let important = 0;
  for (const c of visibleColumns()) {
    for (const card of state.cards[c.folder] || []) {
      if (card.seen) continue;
      unread++;
      if (importance(card).important) important++;
    }
  }
  $("count-unread").textContent = unread || "";
  $("count-important").textContent = important || "";
}

$("refresh").addEventListener("click", () => {
  resetColumnWidths();
  for (const c of visibleColumns()) loadColumn(c.folder);
  loadFolders();
});

// ---------- sidebar ----------

const FOLDER_ICONS = { inbox: "inbox", drafts: "drafts", sent: "sent", archive: "archive", junk: "junk", trash: "trash" };

async function loadFolders() {
  try {
    const known = new Map(state.folders.map((f) => [f.name, f.unseen]));
    state.folders = (await invoke("list_folders")).map((f) => ({ ...f, unseen: known.get(f.name) }));
    refreshSentForWaiting();
    if (!draftIndex.size) refreshDrafts(0);
    paintFolderCounts();
    await refreshUnseen(state.folders.filter(countsUnseen).map((f) => f.name));
  } catch (e) {
    if (isOfflineError(e)) goOffline();
    else toast("Could not read folders: " + e);
  }
}

/// Counters change with the click; the server's numbers arrive later and correct them.
function changeUnseen(folder, by) {
  const f = state.folders.find((x) => x.name === folder);
  if (f) f.unseen = Math.max(0, (f.unseen || 0) + by);
  touchedFolders.add(folder);
}

/// All Mail and Gmail's views repeat other folders, and counting them takes long.
const countsUnseen = (f) => f.selectable && f.kind !== "all" && f.kind !== "view";

async function refreshUnseen(folders) {
  const counts = await invoke("folder_unseen", { folders });
  for (const f of state.folders) if (counts && f.name in counts) f.unseen = counts[f.name];
  cacheSet("folders", state.folders);
  paintFolderCounts();
}

function moveUnseen(from, to) {
  changeUnseen(from, -1);
  if (to) changeUnseen(to, 1);
}

function paintFolderCounts() {
  renderFolders();
  updateBadge();
  setAccountUnread(state.accountId, inboxUnread());
}

/// The Inbox number of the sidebar, the account rail and the Dock: every
/// unread email, or only the important ones (counted among the loaded emails).
function inboxUnread() {
  const inbox = state.cards.INBOX;
  if (state.countImportant && inbox) return inbox.filter((c) => !c.seen && importance(c).important).length;
  return state.folders.find((f) => f.kind === "inbox")?.unseen || 0;
}

function updateBadge() {
  invoke("set_unread_badge", { count: inboxUnread() }).catch(() => {});
}

/// After a change only the folders concerned are asked, not all of them.
let countsTimer;
const touchedFolders = new Set();
function scheduleFolderCounts() {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(() => {
    const wanted = new Set([...touchedFolders, ...visibleColumns().map((c) => c.folder)]);
    touchedFolders.clear();
    const folders = state.folders.filter((f) => countsUnseen(f) && (f.kind === "inbox" || wanted.has(f.name)));
    refreshUnseen(folders.map((f) => f.name)).catch((e) => console.error(e));
  }, 3000);
}

// ---------- desktop notifications ----------

// The backend's answer when the system does not allow notifications.
const NOTIFY_DENIED = "Notifications are turned off for Pigeonhole in System Settings.";
let notifyDeniedSaid = false;

/// Says once per launch that notifications are off, with the way to turn them on.
function notificationsOff() {
  if (notifyDeniedSaid) return;
  notifyDeniedSaid = true;
  toast("Notifications are off for Pigeonhole: turn them on in System Settings → Notifications.", "error", {
    label: "Open settings",
    run: () => invoke("open_notification_settings"),
  });
}

/// Asks macOS for permission at start (it shows its dialog only the first time).
async function prepareNotifications() {
  if (!(await invoke("prepare_notifications").catch(() => true))) notificationsOff();
}

/// `target`: what a click on the notification opens ({ folder, uid }).
function showNotification(title, body, target = null) {
  return invoke("notify", { title, body, target: target ? JSON.stringify(target) : null }).catch((e) => {
    if (String(e) === NOTIFY_DENIED) notificationsOff();
    else console.error("notification failed", e);
    throw e;
  });
}

/// A click on a notification: its email opens, or its column or folder.
listen("notification-clicked", (ev) => {
  let target;
  try {
    target = JSON.parse(ev.payload);
  } catch (_) {
    return;
  }
  const card = target.uid && (state.cards[target.folder] || []).find((c) => c.uid === target.uid);
  if (card) return openReader(target.folder, card);
  if (columnEl(target.folder) || state.columns.some((c) => c.folder === target.folder)) return goToColumn(target.folder);
  const folder = state.folders.find((f) => f.name === target.folder);
  if (folder) openFolder(folder);
});
