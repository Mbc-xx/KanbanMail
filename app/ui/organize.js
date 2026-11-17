// Pigeonhole: All Mail, folder preferences, keyboard, Today, snooze, drafts, tasks and search.

// ---------- All Mail ----------

async function loadAllMail() {
  // What is already known first (in memory, else on this Mac), then the server's list.
  if (state.cards[ALL_KEY]?.length) renderCards(ALL_KEY);
  const local = await invoke("cached_all_mail").catch(() => []);
  const localCards = local.map((x) => ({ ...x.card, __folder: x.folder }));
  if (localCards.length && !state.cards[ALL_KEY]?.length) {
    state.cards[ALL_KEY] = localCards;
    renderCards(ALL_KEY);
  }
  try {
    const entries = await invoke("load_all_mail");
    state.cards[ALL_KEY] = entries.map((e) => ({ ...e.card, __folder: e.folder }));
    renderCards(ALL_KEY);
  } catch (e) {
    if (isOfflineError(e)) {
      state.cards[ALL_KEY] = localCards;
      renderCards(ALL_KEY);
      return goOffline();
    }
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

state.folderPrefs = []; // [{ name, hidden, hide_in_move, color }] in the chosen order
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

/// Does this folder hold every email, like Gmail's All Mail?
function isAllFolder(name) {
  return state.folders.some((f) => f.name === name && f.kind === "all");
}

/// The folders an email or conversation is in: two tags at most, then how many more.
function folderTags(members) {
  let folders = [...new Set(members.map((m) => m.folder))];
  // Gmail: under a label an email is also in All Mail, which says nothing more.
  if (folders.some((f) => !isAllFolder(f))) folders = folders.filter((f) => !isAllFolder(f));
  const tags = folders.slice(0, 2).map(folderTag);
  if (folders.length > 2) {
    const more = el("span", "row-folder", `+${folders.length - 2}`);
    more.title = folders.slice(2).map(folderLabel).join(", ");
    tags.push(more);
  }
  return tags;
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
    const unseen = f.kind === "inbox" ? inboxUnread() : f.unseen;
    if (unseen) item.append(el("span", "badge", String(unseen)));
    if (!f.selectable) {
      item.classList.add("disabled");
    } else {
      item.addEventListener("click", () => openFolder(f));
      setupFolderDrop(item, f.name);
    }
    nav.append(item);
  }
  $("nav-board").classList.toggle("active", !state.view);
  renderTaskList();
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

// ---------- keyboard ----------

// The card picked with the arrows ("folder/uid"); kept across redraws.
let focusKey = null;

const KEYBOARD_HELP = `Moving
↑ ↓ (or J K)  previous / next email
← →  previous / next column
Enter  open the email
Esc  close, or drop the outline

On the email picked or open
E  archive
⌫  delete
R  reply · A  reply all · F  forward
U  read / unread
P  pin
M  move to a folder (type to find it)
Z  snooze (put aside until later)

Anywhere
N  new email
⌘F  search · ⌘B  sidebar
?  this list`;

/// Keys typed in a field, or with a window or menu in front, are not shortcuts.
function shortcutsAllowed(ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  if (ev.target.closest?.("input, textarea, select, [contenteditable='true']")) return false;
  if ($("board-screen").hidden || !$("dialog").hidden || !$("settings").hidden) return false;
  if (!$("composer").hidden && !composerMinimized()) return false;
  return !document.querySelector(".conv-menu");
}

function boardCards(container = document) {
  return [...container.querySelectorAll(".card")].filter((c) => c.offsetParent);
}

function setFocus(cardEl) {
  for (const c of document.querySelectorAll(".card.kbd-focus")) c.classList.remove("kbd-focus");
  focusKey = cardEl ? selKey(cardEl.dataset.folder, { uid: cardEl.dataset.uid }) : null;
  if (!cardEl) return;
  cardEl.classList.add("kbd-focus");
  cardEl.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/// The card the keys act on: the open email's, else the one picked.
function currentCardEl() {
  if (readerCard) {
    const open = document.querySelector(`.card[data-folder="${CSS.escape(readerCard.folder)}"][data-uid="${readerCard.card.uid}"]`);
    if (open) return open;
  }
  return document.querySelector(".card.kbd-focus");
}

/// The card above or below (`step`), or in the column beside (`side`).
function neighbour(from, { step = 0, side = 0 }) {
  const columns = [...document.querySelectorAll("#board .column")];
  if (!from) return boardCards(columns[0] || document)[0] || null;
  const column = from.closest(".column");
  if (side) {
    const at = boardCards(column).indexOf(from);
    const next = columns[columns.indexOf(column) + side];
    const cards = next ? boardCards(next) : [];
    return cards[Math.min(Math.max(at, 0), cards.length - 1)] || from;
  }
  const cards = boardCards(column);
  return cards[cards.indexOf(from) + step] || from;
}

// The outline is for the keys: using the mouse takes it away.
document.addEventListener("mousedown", () => focusKey && setFocus(null), true);

function moveFocus(where) {
  const from = currentCardEl();
  const next = neighbour(from, where);
  if (!next) return;
  // With an email open, the arrows read the next one.
  if (readerCard && where.step) {
    if (next !== from) next.click();
    setFocus(next);
  } else setFocus(next);
}

document.addEventListener("keydown", (ev) => {
  if (!shortcutsAllowed(ev)) return;
  const key = ev.key;
  const nav = { ArrowDown: { step: 1 }, j: { step: 1 }, ArrowUp: { step: -1 }, k: { step: -1 }, ArrowLeft: { side: -1 }, ArrowRight: { side: 1 } }[key];
  if (nav) {
    ev.preventDefault();
    return moveFocus(nav);
  }
  if (key === "?") return ask(KEYBOARD_HELP, [{ label: "Close", value: null, kind: "primary" }]);
  if (key === "n") {
    ev.preventDefault();
    return $("compose").click();
  }
  const cardEl = currentCardEl();
  const info = cardEl?.menuInfo;
  if (!info && !readerCard) return;
  const members = readerCard ? [readerCard] : info.members;
  const { folder, card } = readerCard || info;
  // After the email leaves the list, the keys go on with the next one.
  const advance = () => setFocus(neighbour(cardEl, { step: 1 }) === cardEl ? neighbour(cardEl, { step: -1 }) : neighbour(cardEl, { step: 1 }));
  const reader = (id) => !$(id).hidden && $(id).click();
  const actions = {
    Enter: () => !readerCard && cardEl?.click(),
    o: () => !readerCard && cardEl?.click(),
    e: () => {
      advance();
      readerCard ? reader("reader-archive") : fileMany(members, "archive", { conversation: members.length > 1 });
    },
    Backspace: () => {
      advance();
      readerCard ? reader("reader-trash") : fileMany(members, "trash", { conversation: members.length > 1 });
    },
    Delete: () => actions.Backspace(),
    r: () => (readerCard ? reader("reader-reply") : openReader(folder, card, { then: "reply" })),
    a: () => (readerCard ? reader("reader-reply-all") : openReader(folder, card, { then: "reply-all" })),
    f: () => (readerCard ? reader("reader-forward") : openReader(folder, card, { then: "forward" })),
    u: () => (readerCard ? reader("reader-seen") : markMany(members, !members.every((m) => m.card.seen))),
    p: () => (readerCard ? reader("reader-pin") : pinMany(members, !members.some((m) => m.card.flagged), cardEl)),
    m: () =>
      readerCard
        ? reader("reader-move")
        : showFolderMenu(cardEl, (to) => {
            advance();
            moveMany(members, to);
          }, folder),
    z: () => (!readerCard || !$("reader-snooze").hidden) && popMenu(readerCard ? $("reader-snooze") : cardEl, (menu) => fillSnoozeMenu(menu, members, [])),
  };
  const run = actions[key];
  if (!run) return;
  ev.preventDefault();
  run();
});

// ---------- today ----------

// What needs a look, in the top bar: late to-dos, answers arrived, drafts not sent.
state.today = { late: 0, replied: 0, drafts: 0 };

function renderToday() {
  const t = state.today;
  const chip = (cls, text, title, run) => {
    const b = el("button", "today-chip " + cls, text);
    b.type = "button";
    b.title = title;
    b.addEventListener("click", run);
    return b;
  };
  const chips = [];
  if (t.late) chips.push(chip("late", `${t.late} late`, `In the to-do column for ${state.todoDays} days or more`, () => goToColumn(todoFolder())));
  if (t.replied) chips.push(chip("replied", `↩ ${t.replied} replied`, "Answers arrived to emails you are waiting on", () => goToColumn(waitingFolder())));
  if (t.drafts) chips.push(chip("draft", `✎ ${t.drafts} draft${t.drafts === 1 ? "" : "s"}`, "Emails still in Drafts, not sent", () => openFolder(state.folders.find((f) => f.name === draftsFolder()))));
  $("today").replaceChildren(...chips);
  $("today").hidden = !chips.length;
}

/// Shows a board column and makes it blink for a moment.
function goToColumn(folder) {
  if (!folder) return;
  if (state.view) showBoard();
  requestAnimationFrame(() => {
    const column = columnEl(folder);
    if (!column) return;
    column.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
    column.classList.remove("flash");
    void column.offsetWidth;
    column.classList.add("flash");
  });
}

/// A notification for each answer that arrived to the waiting column since
/// the last look (not the first time, and only for recent answers).
function noticeReplies(answers) {
  const key = "repliesSeen:" + state.accountId;
  const raw = local.get(key);
  let seen = [];
  try {
    seen = JSON.parse(raw || "[]");
  } catch (_) {}
  const idOf = (a) => mailId(a.card.message_id) || `${a.folder}/${a.card.uid}`;
  const recent = Date.now() / 1000 - 3 * 86400;
  if (raw !== null && state.notify !== "off") {
    for (const a of answers.filter((a) => !seen.includes(idOf(a)) && a.card.date > recent)) {
      showNotification(`Reply from ${shortName(a.card.from) || a.card.from_address}`, a.card.subject || "(no subject)", { folder: a.folder, uid: a.card.uid }).catch(() => {});
    }
  }
  local.set(key, JSON.stringify(answers.map(idOf)));
}

// ---------- snooze ----------

let snoozed = new Map(); // Message-ID -> { message_id, folder, back, until }

function setSnoozed(list) {
  snoozed = new Map((list || []).map((x) => [mailId(x.message_id), x]));
}

/// When to come back: later today, tomorrow or next Monday morning, or in a week.
function snoozeChoices() {
  const at = (d, h) => {
    const x = new Date(d);
    x.setHours(h, 0, 0, 0);
    return x;
  };
  const now = new Date();
  const tomorrow = at(new Date(now.getTime() + 86400000), 8);
  const monday = at(new Date(now.getTime() + (((8 - now.getDay()) % 7) || 7) * 86400000), 8);
  const choices = [];
  if (now.getHours() < 20) choices.push(["Later today", new Date(now.getTime() + 3 * 3600000)]);
  choices.push(["Tomorrow morning", tomorrow], ["Monday morning", monday], ["In a week", at(new Date(now.getTime() + 7 * 86400000), 8)]);
  return choices;
}

function fillSnoozeMenu(menu, members, head) {
  menu.replaceChildren(...head, el("div", "menu-head", "Snooze until"));
  for (const [label, when] of snoozeChoices()) {
    const b = menuButton("calendar", `${label} · ${formatDate(when.getTime() / 1000, false)}${when.toDateString() === new Date().toDateString() ? "" : " " + when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`, () => {
      closeConvMenu();
      snoozeMany(members, Math.floor(when.getTime() / 1000));
    });
    menu.append(b);
  }
  menu.append(el("div", "menu-hint muted", "It waits in the Snoozed folder and comes back while Pigeonhole is open."));
}

async function snoozeMany(members, until) {
  if (readerCard && members.some((m) => m.card === readerCard.card)) leaveEmail();
  let target;
  try {
    target = await invoke("ensure_folder", { name: "Snoozed" });
  } catch (e) {
    return toast("Could not snooze: " + e);
  }
  const moves = await moveEmails(members.filter((m) => m.folder !== target), { to: target, quiet: true });
  const items = moves.filter((m) => m.now && m.message_id).map((m) => ({ message_id: m.message_id, folder: m.now, back: m.back, until }));
  if (!items.length) return;
  try {
    setSnoozed(await invoke("add_snoozed", { items }));
  } catch (e) {
    return toast("Snoozed, but the time was not kept: " + e);
  }
  const when = new Date(until * 1000);
  toast(`Snoozed until ${when.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`, "info", {
    label: "Undo",
    run: async () => {
      setSnoozed(await invoke("remove_snoozed", { ids: items.map((i) => i.message_id) }).catch(() => []));
      for (const i of items) await invoke("undo_move", { messageId: i.message_id, nowIn: i.folder, backTo: i.back }).catch(() => {});
      await afterBulkChange(items.flatMap((i) => [i.folder, i.back]));
    },
  });
}

/// Brings back the emails whose time has come (or the given ones, now).
async function wakeSnoozed(only = null) {
  let list;
  try {
    list = await invoke("list_snoozed");
  } catch (_) {
    return;
  }
  setSnoozed(list);
  const now = Date.now() / 1000;
  const due = only || list.filter((x) => x.until <= now);
  if (!due.length) return;
  const done = [];
  for (const x of due) {
    try {
      await invoke("undo_move", { messageId: x.message_id, nowIn: x.folder, backTo: x.back });
      done.push(x);
    } catch (e) {
      // Moved elsewhere meanwhile: nothing to bring back. Offline: next time.
      if (!isOfflineError(e)) done.push(x);
    }
  }
  if (!done.length) return;
  setSnoozed(await invoke("remove_snoozed", { ids: done.map((x) => x.message_id) }).catch(() => list));
  toast(done.length === 1 ? "A snoozed email is back" : `${done.length} snoozed emails are back`, "info");
  await afterBulkChange(done.flatMap((x) => [x.folder, x.back]));
}
setInterval(() => state.columns.length && wakeSnoozed(), 60_000);

/// "Back Mon 08:00" on a snoozed email; a click brings it back now.
function snoozeTag(members) {
  if (!snoozed.size) return null;
  const x = members.map((m) => snoozed.get(mailId(m.card.message_id))).find(Boolean);
  if (!x) return null;
  const when = new Date(x.until * 1000);
  const tag = el("button", "wait-tag snooze-tag", `⏰ Back ${when.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`);
  tag.type = "button";
  tag.draggable = false;
  tag.title = `Snoozed: back in ${folderLabel(x.back)} on ${when.toLocaleString()}. Click to bring it back now.`;
  tag.addEventListener("click", (ev) => {
    ev.stopPropagation();
    wakeSnoozed([x]);
  });
  return tag;
}

// ---------- unsent drafts ----------

// A reply left in Drafts looks like a reply sent: the conversations it
// belongs to show it, so it is not forgotten.
let draftIndex = new Map(); // Message-ID an unsent reply refers to -> that draft

const draftsFolder = () => state.folders.find((f) => f.kind === "drafts")?.name;

/// Reads Drafts again (a moment after a change) and shows what it holds.
let draftsTimer;
function refreshDrafts(delay = 800) {
  clearTimeout(draftsTimer);
  draftsTimer = setTimeout(() => {
    const drafts = draftsFolder();
    if (!drafts) return;
    loadColumn(drafts);
    touchedFolders.add(drafts);
    scheduleFolderCounts();
  }, delay);
}

/// Called whenever the Drafts list changed.
function indexDrafts() {
  const drafts = draftsFolder();
  const next = new Map();
  for (const card of (drafts && state.cards[drafts]) || []) {
    for (const id of (card.thread_refs || []).map(mailId).filter(Boolean)) next.set(id, card);
  }
  const same = next.size === draftIndex.size && [...next].every(([id, c]) => draftIndex.get(id)?.uid === c.uid);
  draftIndex = next;
  state.today.drafts = (drafts && state.cards[drafts]?.length) || 0;
  renderToday();
  const f = state.folders.find((x) => x.name === drafts);
  // The count is every draft (the server's number arrives later and wins).
  if (f && state.cards[drafts]?.length > (f.unseen || 0)) {
    f.unseen = state.cards[drafts].length;
    paintFolderCounts();
  }
  // A draft sent or discarded leaves the open conversation.
  if (readerCard && (readerThread || []).some((e) => e.folder === drafts)) renderThread({ anchor: true });
  if (same) return;
  for (const c of visibleColumns()) if (c.folder !== drafts) renderCards(c.folder);
  if (readerCard) renderReaderDraft();
}

/// The unsent draft of an email or conversation, if there is one.
function draftOf(members) {
  if (!draftIndex.size) return null;
  for (const { card } of members) {
    for (const id of [card.message_id, ...(card.thread_refs || [])].map(mailId)) {
      if (id && draftIndex.has(id)) return draftIndex.get(id);
    }
  }
  return null;
}

function draftTag(members, folder) {
  const drafts = draftsFolder();
  // In a list of several folders, or inside a conversation, a draft says what it is.
  if (folder === drafts) {
    if (!state.view || state.view.folder === drafts) return null;
    const tag = el("span", "wait-tag draft-tag", "✎ Draft · not sent");
    tag.title = "This email is still in Drafts: it has not been sent";
    return tag;
  }
  const draft = draftOf(members);
  if (!draft) return null;
  const tag = el("button", "wait-tag draft-tag", "✎ Draft reply · not sent");
  tag.type = "button";
  tag.draggable = false;
  tag.title = `A reply to this conversation is still in Drafts (${formatDate(draft.date, true)}): open it to finish and send it`;
  tag.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openDraft(drafts, draft);
  });
  return tag;
}

/// The banner over an open email whose conversation has an unsent reply.
function renderReaderDraft() {
  const box = $("reader-draft");
  const members = [readerCard, ...(readerThread || [])].filter(Boolean);
  const draft = readerCard && folderKind(readerCard.folder) !== "drafts" ? draftOf(members) : null;
  box.hidden = !draft;
  if (!draft) return box.replaceChildren();
  const open = el("button", "", "Open the draft");
  open.type = "button";
  open.addEventListener("click", () => openDraft(draftsFolder(), draft));
  box.replaceChildren(el("span", "", `✎ A reply to this conversation is still in Drafts, not sent (saved ${formatDate(draft.date)}).`), open);
}

// ---------- tasks (Jira and the like) linked to emails ----------

state.tasks = []; // [{ url, name, emails }], most recently linked first
let taskIndex = new Map(); // Message-ID -> the tasks linked to that email

/// The tasks as the backend now has them: everything showing them follows.
function setTasks(tasks) {
  state.tasks = tasks || [];
  taskIndex = new Map();
  for (const t of state.tasks) {
    for (const id of t.emails) taskIndex.set(id, [...(taskIndex.get(id) || []), t]);
  }
  renderTaskList();
  renderReaderTasks();
  const open = state.view?.task;
  if (!open) {
    renderSoon();
    return;
  }
  // The task on screen: its emails changed, it was renamed or it is gone.
  const now = state.tasks.find((t) => t.url === open.url);
  if (!now) return showBoard();
  state.view.task = now;
  if (state.view.label !== now.name) {
    state.view.label = now.name;
    renderColumns();
  }
  loadTask();
}

/// The Message-IDs an email answers to, and its own: a link on any of them
/// makes it part of the task, so replies follow their conversation.
const cardIds = (card) => [card.message_id, ...(card.thread_refs || [])].map(mailId).filter(Boolean);

function tasksOf(members) {
  if (!taskIndex.size) return [];
  const found = new Set();
  for (const { card } of members) {
    for (const id of cardIds(card)) for (const t of taskIndex.get(id) || []) found.add(t);
  }
  return [...found];
}

/// The tasks of an email or conversation as small buttons (two at most). The
/// list of a task's emails leaves that task out: every row would repeat it.
function taskTags(members, all = false) {
  const tasks = tasksOf(members).filter((t) => all || t.url !== state.view?.task?.url);
  return tasks.slice(0, 2).map((task) => {
    const tag = el("button", "task-tag");
    tag.type = "button";
    tag.draggable = false;
    tag.title = `Task ${task.name}\n${task.url}`;
    tag.append(icon("link"), el("span", "", task.name));
    tag.addEventListener("click", (ev) => {
      ev.stopPropagation();
      popMenu(tag, (menu) => fillTaskMenu(menu, task, members));
    });
    return tag;
  });
}

function renderReaderTasks() {
  const tags = readerCard ? taskTags([readerCard], true) : [];
  $("reader-tasks").replaceChildren(...tags);
  $("reader-tasks").hidden = !tags.length;
}

async function changeTasks(command, args, done = "") {
  try {
    setTasks(await invoke(command, args));
    if (done) toast(done, "info");
    return true;
  } catch (e) {
    toast("Could not update the task: " + e);
    return false;
  }
}

function linkTask(url, members) {
  const ids = [...new Set(members.map((m) => mailId(m.card.message_id)).filter(Boolean))];
  if (!ids.length) return toast("This email has no Message-ID: it cannot be linked to a task.");
  return changeTasks("link_task", { url: url.trim(), ids }).then((ok) => ok && toast(`Linked to ${state.tasks[0].name}`, "info"));
}

/// What can be done with a task; with `members`, also taking them off it.
function fillTaskMenu(menu, task, members = null) {
  menu.classList.add("task-menu");
  const run = (fn) => () => {
    closeConvMenu();
    fn();
  };
  menu.replaceChildren(menuButton("link", `Open ${task.name} in the browser`, run(() => openLink(task.url))));
  if (state.view?.task?.url !== task.url) menu.append(menuButton("search", "Show the emails of this task", run(() => openTask(task))));
  if (members) {
    const ids = [...new Set(members.flatMap((m) => cardIds(m.card)))];
    const what = members.length > 1 ? "conversation" : "email";
    menu.append(menuButton("close", `Unlink this ${what}`, run(() => changeTasks("unlink_task", { url: task.url, ids }, `Unlinked from ${task.name}`))));
  }
  menu.append(
    el("div", "menu-sep"),
    menuButton("compose", "Rename…", () => {
      const input = menuInput("Name of the task", task.name, (name) => {
        closeConvMenu();
        changeTasks("rename_task", { url: task.url, name });
      });
      menu.replaceChildren(input);
      input.select();
    }),
    menuButton("trash", "Remove the task and its links", run(() => removeTask(task))),
  );
}

async function removeTask(task) {
  if (!(await changeTasks("unlink_task", { url: task.url, ids: null }))) return;
  toast(`Task ${task.name} removed`, "info", {
    label: "Undo",
    run: async () => (await changeTasks("link_task", { url: task.url, ids: task.emails })) && changeTasks("rename_task", { url: task.url, name: task.name }),
  });
}

/// A text field inside a menu; Enter hands over what was typed.
function menuInput(placeholder, value, done) {
  const input = el("input", "menu-input");
  input.placeholder = placeholder;
  input.value = value;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.addEventListener("click", (ev) => ev.stopPropagation());
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && input.value.trim()) done(input.value.trim());
    else if (ev.key === "Escape") closeConvMenu();
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  });
  setTimeout(() => input.focus());
  return input;
}

/// Fills `menu` with the ways to link `members` to a task: pasting its link
/// (which links at once) or picking a task already in use. `close` runs first.
function fillTaskPicker(menu, head, members, close) {
  menu.classList.add("task-menu");
  const pick = (url) => {
    close();
    linkTask(url, members);
  };
  const input = menuInput("Paste the link of the task", "", pick);
  input.addEventListener("paste", () => setTimeout(() => /^https?:\/\/\S+$/i.test(input.value.trim()) && pick(input.value)));
  menu.replaceChildren(...head, input);
  const linked = new Set(tasksOf(members));
  const others = state.tasks.filter((t) => !linked.has(t)).slice(0, 12);
  if (others.length) menu.append(el("div", "menu-head", "Tasks in use"));
  for (const t of others) {
    const b = menuButton("link", t.name, () => pick(t.url));
    b.title = t.url;
    menu.append(b);
  }
}

/// The tasks in the sidebar: a click lists their emails, a card dropped on
/// one is linked to it.
function renderTaskList() {
  // Tasks pile up: they get a tab of their own beside the folders, with a
  // field to find one. Without tasks the sidebar is the folders, as ever.
  const has = state.tasks.length > 0;
  const tab = has && local.get("sideTab") === "tasks" ? "tasks" : "folders";
  $("side-tabs").hidden = !has;
  $("folders-title").hidden = has;
  $("folder-list").hidden = tab !== "folders";
  $("task-pane").hidden = tab !== "tasks";
  for (const b of $("side-tabs").children) b.classList.toggle("active", b.dataset.side === tab);
  $("side-tabs").querySelector("[data-side='tasks']").textContent = `Tasks ${state.tasks.length || ""}`.trim();
  if (tab !== "tasks") return $("task-list").replaceChildren();
  const words = $("task-filter").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = state.tasks.filter((t) => words.every((w) => (t.name + " " + t.url).toLowerCase().includes(w)));
  if (!shown.length) return $("task-list").replaceChildren(el("div", "nav-empty muted small", "No task found"));
  $("task-list").replaceChildren(
    ...shown.map((task) => {
      const item = el("button", "nav-item");
      item.title = `${task.emails.length} linked · ${task.url}`;
      if (state.view?.task?.url === task.url) item.classList.add("active");
      item.append(icon("link"), el("span", "label", task.name), el("span", "badge", String(task.emails.length)));
      item.addEventListener("click", () => openTask(task));
      item.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        popMenuAt(ev.clientX, ev.clientY, (menu) => fillTaskMenu(menu, task));
      });
      item.addEventListener("dragover", (ev) => {
        if (!state.dragging) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        item.classList.add("drop-target");
      });
      item.addEventListener("dragleave", () => item.classList.remove("drop-target"));
      item.addEventListener("drop", (ev) => {
        ev.preventDefault();
        item.classList.remove("drop-target");
        if (state.dragging) linkTask(task.url, state.dragging.members);
      });
      return item;
    }),
  );
}

for (const b of $("side-tabs").children) {
  b.addEventListener("click", () => {
    local.set("sideTab", b.dataset.side);
    renderTaskList();
    if (b.dataset.side === "tasks") $("task-filter").focus();
  });
}
$("task-filter").addEventListener("input", renderTaskList);
$("task-filter").addEventListener("keydown", (ev) => {
  // Enter opens the first task found.
  if (ev.key === "Enter") $("task-list").querySelector(".nav-item")?.click();
});

function openTask(task) {
  local.set("sideTab", "tasks");
  state.view = { folder: TASK_KEY, label: task.name, task, multi: true };
  state.cards[TASK_KEY] = [];
  renderColumns();
  renderFolders();
  loadTask();
}

/// The emails of the task on screen, from the copy on this computer: the
/// linked ones with the rest of their conversations, newest first.
async function loadTask() {
  const view = state.view;
  if (!view?.task) return;
  const entries = await invoke("task_emails", { ids: view.task.emails }).catch(() => []);
  if (state.view !== view) return;
  state.cards[TASK_KEY] = entries.sort((a, b) => b.card.date - a.card.date).map((e) => ({ ...e.card, __folder: e.folder }));
  renderCards(TASK_KEY);
}

// ---------- search ----------

const SEARCH_KEY = "__search__";
const ALL_KEY = "__all__";
const TASK_KEY = "__task__";
const MULTI_KEYS = [SEARCH_KEY, ALL_KEY, TASK_KEY]; // lists with emails from several folders
state.filter = null; // the search box as a filter of the loaded cards
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
  view.serverSearch = null;
  const folders = state.columns.map((c) => c.folder);
  if (view.from && !MULTI_KEYS.includes(view.from) && !folders.includes(view.from)) folders.push(view.from);
  const query = parseQuery(view.search);
  const args = { query, inBody: !!view.inBody, folders };
  // Results found on this Mac come first (instant, also offline); the server
  // results are merged in as they arrive and win for the same email.
  let entries = [];
  const merge = (found) => {
    const byKey = new Map(entries.map((e) => [searchKey(e.card, e.folder), e]));
    for (const e of found) {
      const key = searchKey(e.card, e.folder);
      if (!isAllFolder(e.folder) || !byKey.has(key)) byKey.set(key, e);
    }
    entries = [...byKey.values()];
  };
  const show = () => {
    entries.sort((a, b) => b.card.date - a.card.date);
    state.cards[SEARCH_KEY] = entries.map((e) => ({ ...e.card, __folder: e.folder }));
    renderCards(SEARCH_KEY);
  };
  let local = [];
  try {
    local = await invoke("search_local", { query });
  } catch (_) {}
  if (!alive()) return;
  merge(local);
  if (local.length) show();
  const onMac = local.length ? `${local.length} on this Mac · ` : "";
  try {
    setStatus(onMac + (view.inBody ? "Searching the main folders, in the text too (slow)…" : "Searching the main folders…"));
    merge(await invoke("search_emails", { ...args, scope: "main" }));
    if (!alive()) return;
    show();
    setStatus(summary(entries) + " · searching the other folders…");
    merge(await invoke("search_emails", { ...args, scope: "rest" }));
    if (!alive()) return;
    view.searchDone = true;
    show();
    setStatus(summary(entries) + " · all folders searched");
  } catch (e) {
    if (!alive()) return;
    view.searchDone = true;
    show();
    if (entries.length) {
      setStatus(summary(entries) + " · server not reachable: results from this Mac");
    } else {
      setStatus("Search failed");
      toast("Search failed: " + e);
    }
  }
}

const searchKey = (card, folder) => (card.message_id || "").toLowerCase() || folder + "/" + card.uid;

/// Under the results: the search of every email on the server, then its outcome.
function appendServerSearch(container) {
  const view = state.view;
  if (!view.searchDone) return;
  if (view.serverSearch === "done") return container.append(el("div", "empty muted", "The whole server was searched"));
  const b = el("button", "load-more", view.serverSearch === "running" ? "Searching the whole server…" : "Search the whole server");
  b.title = "Every email of every folder, in the text too, with no limit on the results. It can take a few minutes.";
  b.disabled = view.serverSearch === "running";
  b.addEventListener("click", searchWholeServer);
  container.append(b);
}

/// Every email of every folder, one folder at a time so results arrive as they are found.
async function searchWholeServer() {
  const view = state.view;
  const seq = ++searchSeq;
  const alive = () => seq === searchSeq && state.view === view;
  const setStatus = (text) => {
    const s = $("search-status");
    if (s) s.textContent = text;
  };
  view.serverSearch = "running";
  renderCards(SEARCH_KEY);
  const query = parseQuery(view.search);
  const folders = state.folders.filter((f) => f.selectable !== false && f.kind !== "view").map((f) => f.name);
  const found = new Map(state.cards[SEARCH_KEY].map((c) => [searchKey(c, c.__folder), c]));
  const failed = [];
  for (const [i, folder] of folders.entries()) {
    setStatus(`${found.size} found · searching ${folderLabel(folder)} (${i + 1} of ${folders.length})…`);
    try {
      const entries = await invoke("search_emails", { query, inBody: true, folders: [folder], scope: "full" });
      if (!alive()) return;
      for (const e of entries) {
        const key = searchKey(e.card, e.folder);
        if (!isAllFolder(e.folder) || !found.has(key)) found.set(key, { ...e.card, __folder: e.folder });
      }
      state.cards[SEARCH_KEY] = [...found.values()].sort((a, b) => b.date - a.date);
      renderCards(SEARCH_KEY);
    } catch (e) {
      if (!alive()) return;
      console.error(folder, e);
      failed.push(folderLabel(folder));
    }
  }
  view.serverSearch = failed.length ? null : "done";
  renderCards(SEARCH_KEY);
  setStatus(`${found.size} found · ` + (failed.length ? `could not search ${failed.join(", ")}` : "whole server searched"));
}

function startSearch(text) {
  const from = state.view && !state.view.search ? state.view.folder : state.view?.from;
  state.view = { folder: SEARCH_KEY, label: `Search: ${text}`, search: text, inBody: state.view?.inBody || false, from, multi: true };
  state.cards[SEARCH_KEY] = [];
  renderColumns();
  renderFolders();
  runSearch();
}

/// All Mail holds only the latest emails, so what is typed there searches every folder.
const inAllMail = () => state.view?.folder === ALL_KEY || (state.view?.search && state.view.from === ALL_KEY);
let allMailSearch = null;

$("search").addEventListener("input", () => {
  state.filter = boardFilter($("search").value);
  clearTimeout(allMailSearch);
  if (inAllMail()) {
    allMailSearch = setTimeout(() => {
      if (!inAllMail()) return;
      if (state.filter) startSearch($("search").value.trim());
      else if (state.view.search) openAllMail();
    }, 500);
  }
  // Typing fast redraws once at the end, not at every letter.
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => !state.view?.search && renderSoon(), 120);
});
let filterTimer;

$("search").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    clearTimeout(allMailSearch);
    const text = $("search").value.trim();
    if (text) startSearch(text);
  } else if (ev.key === "Escape") {
    ev.stopPropagation();
    clearTimeout(allMailSearch);
    $("search").value = "";
    state.filter = null;
    if (state.view?.search) inAllMail() ? openAllMail() : showBoard();
    else renderSoon();
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

listen("open-link", (ev) => {
  const link = decodeURIComponent(ev.payload);
  if (!link.startsWith("{")) return openLink(link);
  try {
    openCheckedLink(JSON.parse(link));
  } catch (_) {}
});

listen("folder-changed", (ev) => {
  if (String(ev.payload).toUpperCase() === "INBOX" && !columnEl(ev.payload)) checkInbox();
  scheduleReload(ev.payload);
});
