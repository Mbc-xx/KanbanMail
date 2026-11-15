// Pigeonhole: reading an email, its conversation and the confirmation dialog.

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
  const label = seen ? "Mark as unread" : "Mark as read";
  $("reader-seen").replaceChildren(icon(seen ? "envelope" : "envelope-open"), el("span", "", label));
  $("reader-seen").title = label;
  const pinned = !!readerCard.card.flagged;
  $("reader-pin").replaceChildren(icon("pin"), el("span", "", pinned ? "Unpin" : "Pin"));
  $("reader-pin").title = pinned ? "Unpin this email" : "Pin this email";
  $("reader-pin").classList.toggle("active", pinned);
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
      chip.title = `Save ${a.name} · or drag it to a folder`;
      const look = el("span", "att-preview");
      look.title = "Preview without saving (space)";
      look.append(icon("eye"));
      const preview = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        invoke("preview_attachment", { folder, uid, index: a.index }).catch((e) => toast("Could not show the attachment: " + e));
      };
      look.addEventListener("click", preview);
      // Space on the attachment previews it (Quick Look on macOS), Enter saves it.
      chip.addEventListener("keydown", (ev) => ev.key === " " && preview(ev));
      chip.addEventListener("keyup", (ev) => ev.key === " " && ev.preventDefault());
      chip.append(icon("paperclip"), el("span", "att-name", a.name), el("span", "att-size muted", formatSize(a.size)), look, icon("download", "att-dl"));
      dragOut(chip, () => invoke("prepare_attachment", { folder, uid, index: a.index }));
      chip.addEventListener("click", async () => {
        if (Date.now() - (chip.draggedAt || 0) < 400) return; // the end of a drag, not a click
        chip.disabled = true;
        try {
          const path = await invoke("save_attachment", { folder, uid, index: a.index });
          if (path) savedToast("Saved", path);
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

const IS_MAC = /Mac/.test(navigator.platform || navigator.userAgent);

// ---------- people in an email: the contact menu ----------

let readerSender = null; // { name, email } of the open email's sender

/// Recipients as names: pointing shows the address, a click or right-click
/// opens the contact menu.
function renderPeople(target, text) {
  target.replaceChildren();
  parseAddresses(text || "").forEach((p, i) => {
    if (i) target.append(", ");
    const person = el("span", "person", p.name || p.email);
    person.title = formatAddress(p);
    contactMenuOn(person, () => p);
    target.append(person);
  });
}

function contactMenuOn(elem, who, extra = () => []) {
  const open = (ev) => {
    const p = who();
    if (!p?.email) return;
    ev.preventDefault();
    ev.stopPropagation();
    openContactMenu(ev.clientX, ev.clientY, p, extra());
  };
  elem.addEventListener("contextmenu", open);
  elem.addEventListener("click", open);
}
contactMenuOn($("reader-from"), () => readerSender);
contactMenuOn($("reader-from-address"), () => readerSender);
contactMenuOn($("reader-avatar"), () => readerSender);

/// Leaves the mailing list of the open email: with one click when the list
/// allows it, otherwise its page in the browser or an email to write.
$("reader-unsubscribe").addEventListener("click", async () => {
  const u = readerMessage?.unsubscribe;
  if (!u) return;
  const who = readerSender?.name || readerSender?.email || "this sender";
  if (u.one_click) {
    const choice = await ask(`Leave the mailing list of ${who}?\n\nPigeonhole tells the list directly; nothing else is sent.`, [
      { label: "Cancel", value: null },
      { label: "Unsubscribe", value: "go", kind: "primary" },
    ]);
    if (choice !== "go") return;
    try {
      await invoke("unsubscribe", { url: u.url });
      $("reader-unsubscribe").hidden = true;
      return toast(`Unsubscribed from ${who}`, "info", { label: "Archive this email", run: () => $("reader-archive").click() });
    } catch (e) {
      if (!u.url) return toast("Could not unsubscribe: " + e);
      toast("The list did not answer: its page opens instead", "info");
    }
  }
  if (u.url) return openLink(u.url);
  openLink(u.mailto);
});

/// What can be done with a person: write to them, find their emails, copy
/// the address, see or add them in Contacts. `extra`: menu items to add.
function openContactMenu(x, y, person, extra = []) {
  const address = formatAddress(person);
  const known = (state.contacts || []).some((c) => c.email.toLowerCase() === person.email.toLowerCase());
  const run = (fn) => () => {
    closeConvMenu();
    fn();
  };
  popMenuAt(x, y, (menu) => {
    menu.classList.add("contact-menu");
    const head = el("div", "menu-head", person.name || person.email);
    head.title = person.email;
    menu.append(
      head,
      menuButton("compose", `New email to ${shortName(person.name) || person.email}`, run(() => openComposer({ to: address, body: signatureBlock() }))),
      menuButton("search", "Emails from this person", run(() => startSearch(`from:${person.email}`))),
      menuButton("envelope", "Copy the address", run(() => copyText(address).then(() => toast("Address copied", "info", null, 2), () => toast("Could not copy the address")))),
    );
    if (IS_MAC) menu.append(menuButton("plus", known ? "Show in Contacts" : "Add to Contacts", run(() => showInContacts(person))));
    if (extra.length) menu.append(el("div", "menu-sep"), ...extra);
  });
}

/// Opens the person in Contacts, after adding them when they are not there.
async function showInContacts(person) {
  try {
    const created = await invoke("open_contact", { name: person.name || "", email: person.email });
    if (created) {
      toast(`${person.name || person.email} added to Contacts`, "info");
      // Suggestions and "Important only" know them at once.
      state.contacts = [...(state.contacts || []), { name: person.name || "", email: person.email }];
    }
  } catch (e) {
    if (String(e).includes("not allowed Pigeonhole")) {
      toast(String(e), "error", { label: "Open settings", run: () => invoke("open_contacts_privacy").catch(() => {}) });
    } else toast(String(e));
  }
}

/// "Saved in Downloads" (the folder only; the full path when pointing at
/// it), with a button that shows the file in its folder.
function savedToast(what, path) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const folder = parts.length > 1 ? parts[parts.length - 2] : path;
  toast(`${what} in ${folder}`, "info", { label: IS_MAC ? "Show in Finder" : "Show in folder", primary: true, run: () => invoke("reveal_file", { path }).catch((e) => toast(String(e))) }, 8);
  $("toast").title = path;
}

/// Lets an element be dragged out of the app as a file: moving it a few
/// pixels while pressed writes the file (`prepare`) and hands it to the
/// system's drag, so it can be dropped on the Finder, the desktop or another
/// app. A plain click writes nothing.
function dragOut(item, prepare) {
  item.addEventListener("mousedown", (down) => {
    if (down.button !== 0) return;
    let pressed = true;
    let started = false;
    const move = async (ev) => {
      if (started || Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < 5) return;
      started = true;
      item.classList.add("dragging-out");
      const path = await prepare().catch((e) => {
        toast("Could not prepare the file: " + e);
        return null;
      });
      // The system's drag needs the button still down.
      if (path && pressed) invoke("drag_attachment", { path }).catch((e) => toast("Could not drag the file: " + e));
      item.classList.remove("dragging-out");
    };
    const up = () => {
      pressed = false;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up, true);
      // A press without a move is a click: it saves as before.
      if (started) item.draggedAt = Date.now();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, true);
  });
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
  if (card.seen !== seen) changeUnseen(folder, seen ? -1 : 1);
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
  paintFolderCounts();
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

/// Closes the open email because it leaves the list (archived, deleted,
/// moved, snoozed). With "Open the next email" in the settings, the email
/// below it opens instead (or the one above, at the end of the list).
function leaveEmail() {
  const from = currentCardEl();
  let next = null;
  if (state.afterAction === "next" && from) {
    const below = neighbour(from, { step: 1 });
    next = below !== from ? below : neighbour(from, { step: -1 });
    if (next === from) next = null;
  }
  const info = next?.menuInfo;
  closeReader();
  if (info) {
    setFocus(next);
    openReader(info.folder, info.card);
  }
}

$("reader-spam").addEventListener("click", () => {
  const one = readerCard;
  leaveEmail();
  if (folderKind(one.folder) === "junk") moveMany([one], "INBOX");
  else fileMany([one], "junk");
});

for (const kind of ["trash", "archive"]) {
  $("reader-" + kind).addEventListener("click", () => {
    const one = readerCard;
    leaveEmail();
    fileMany([one], kind);
  });
}

$("reader-seen").addEventListener("click", () => {
  const { folder, card } = readerCard;
  setSeen(folder, card, !card.seen);
});

$("reader-pin").addEventListener("click", async () => {
  const one = readerCard;
  one.card.flagged = !one.card.flagged;
  updateSeenButton();
  updateConvBar();
  await pinMany([one], one.card.flagged, $("reader-pin"));
});

$("reader-move").addEventListener("click", (ev) => {
  ev.stopPropagation();
  showFolderMenu($("reader-move"), (to) => {
    const one = readerCard;
    leaveEmail();
    moveMany([one], to);
  });
});

$("reader-snooze").addEventListener("click", (ev) => {
  ev.stopPropagation();
  if (document.querySelector(".conv-menu")) return closeConvMenu();
  popMenu($("reader-snooze"), (menu) => fillSnoozeMenu(menu, [readerCard], []));
});

$("reader-task").addEventListener("click", (ev) => {
  ev.stopPropagation();
  if (document.querySelector(".conv-menu.task-menu")) return closeConvMenu();
  popMenu($("reader-task"), (menu) => fillTaskPicker(menu, [], [readerCard], closeConvMenu));
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
  dropMinimized(folder, card);
  readerCard = { folder, card };
  readerMessage = null;
  readerQuoteShown = false;
  if (!opts.thread) readerThread = opts.cachedThread || null;
  else readerThread = opts.thread;
  updateConvBar();
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
  $("reader-archive").hidden = folderKind(folder) === "archive";
  const inJunk = folderKind(folder) === "junk";
  $("reader-spam").querySelector("span").textContent = inJunk ? "Not spam" : "Spam";
  $("reader-spam").title = inJunk ? "Move back to the Inbox" : "Move to Junk";
  $("rule-scope").value = "address";
  updateSenderPanel();
  $("reader-subject").textContent = card.subject || "(no subject)";
  renderReaderTasks();
  renderReaderDraft();
  $("reader-from").textContent = card.from || "(unknown sender)";
  $("reader-from-address").textContent = card.from_address && card.from_address !== card.from ? card.from_address : "";
  readerSender = { name: card.from && card.from !== card.from_address ? card.from : "", email: card.from_address || "" };
  setAvatar($("reader-avatar"), card.from || card.from_address || "?");
  $("reader-to").textContent = "";
  $("reader-cc").textContent = "";
  $("reader-unsubscribe").hidden = true;
  $("quick-reply").hidden = $("reader-quick").hidden = true;
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
    renderPeople($("reader-to"), msg.to);
    renderPeople($("reader-cc"), msg.cc);
    $("reader-unsubscribe").hidden = !msg.unsubscribe;
    showQuickReply();
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
    ({ reply: () => replyTo(false), "reply-all": () => replyTo(true), forward }[opts.then])?.();
    if (!opts.thread) loadThread(folder, card, msg);
  } catch (e) {
    $("reader-body").replaceChildren(
      isOfflineError(e)
        ? el("p", "muted offline-note", "This email is not on this Mac yet and the server cannot be reached. It will open when the connection is back.")
        : el("pre", "error", String(e)),
    );
  }
}

/// Joins conversation lists (local and from the server): one entry per email,
/// the later list wins, oldest first.
function mergeThread(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const e of list || []) byKey.set((e.card.message_id || "").toLowerCase() || `${e.folder}/${e.card.uid}`, e);
  }
  return [...byKey.values()].sort((a, b) => a.card.date - b.card.date);
}

async function loadThread(folder, card, msg) {
  if (!msg.message_id && !msg.references.length) return;
  // First what this Mac knows (instant), then the server lookup.
  let local = [];
  try {
    local = await invoke("local_thread", { messageId: msg.message_id, references: msg.references });
    if (readerCard?.card !== card) return;
    if (local.length > 1) {
      readerThread = mergeThread(local);
      renderThread({ anchor: true });
    }
  } catch (_) {}
  try {
    const entries = await invoke("load_thread", {
      folder,
      messageId: msg.message_id,
      references: msg.references,
      columns: state.columns.map((c) => c.folder),
    });
    if (readerCard?.card !== card) return; // another email was opened meanwhile
    readerThread = mergeThread(local, entries);
    renderThread({ anchor: true });
  } catch (e) {
    console.error("conversation lookup failed", e);
  }
}

const AVATAR_COLORS = ["#4f8fd6", "#43a07a", "#c4684f", "#8a6fd1", "#c98a2e", "#3e9bb0", "#b85c8f"];

function avatarColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/// A round badge with the sender's initials ("Anna Bianchi" -> AB), in a color of its own for each name.
function setAvatar(a, name) {
  const n = name.trim();
  const words = n.includes("@") ? [] : n.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const initials = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || n)[0] || "?";
  a.textContent = initials.toUpperCase();
  a.setAttribute("aria-hidden", "true");
  a.style.background = avatarColor(name);
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

// ---------- actions on the whole conversation ----------

/// Every email of the open conversation (just the open email until the rest is found).
function convMembers() {
  if (!readerCard) return [];
  const seen = new Set();
  const out = [];
  for (const m of [readerCard, ...(readerThread || [])]) {
    const key = `${m.folder}/${m.card.uid}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}

/// The emails to move: your own sent emails and drafts stay where they are
/// (unless the conversation is only those).
function convMovable() {
  const all = convMembers();
  const received = all.filter((m) => !["sent", "drafts"].includes(folderKind(m.folder)));
  return received.length ? received : all;
}

function updateConvBar() {
  const members = convMembers();
  const n = members.length;
  // A single email has its own actions: the bar is only for whole conversations.
  $("conv-bar").hidden = n < 2;
  $("conv-label").textContent = `Whole conversation · ${n} emails`;
  for (const b of document.querySelectorAll("#conv-bar .conv-btn")) {
    const badge = b.querySelector(".conv-n") || b.appendChild(el("span", "conv-n"));
    badge.textContent = String(n);
  }
  const what = n > 1 ? `all ${n} emails of the conversation` : "this email";
  const pinned = members.some((m) => m.card.flagged);
  $("conv-pin").classList.toggle("active", pinned);
  $("conv-pin").title = pinned ? `Unpin ${what}` : `Pin ${what}`;
  const unread = members.some((m) => !m.card.seen);
  $("conv-seen").querySelector("use").setAttribute("href", unread ? "#i-envelope-open" : "#i-envelope");
  $("conv-seen").title = unread ? `Mark ${what} as read` : `Mark ${what} as unread`;
  const movable = convMovable().length;
  const moveWhat = movable === n ? what : `the ${movable} received email${movable === 1 ? "" : "s"} (your sent ones stay)`;
  $("conv-archive").title = `Archive ${moveWhat}`;
  $("conv-trash").title = `Delete ${moveWhat} (move to trash)`;
  const inJunk = readerCard && folderKind(readerCard.folder) === "junk";
  $("conv-spam").title = inJunk ? `Not spam: move ${moveWhat} back to the Inbox` : `Mark ${moveWhat} as spam`;
  $("conv-move").title = `Move ${moveWhat} to a folder…`;
}

$("conv-pin").addEventListener("click", async () => {
  const members = convMembers();
  const pinned = !members.some((m) => m.card.flagged);
  for (const m of members) m.card.flagged = pinned;
  updateConvBar();
  await pinMany(members, pinned, $("conv-pin"));
});

$("conv-seen").addEventListener("click", async () => {
  const members = convMembers();
  const seen = members.some((m) => !m.card.seen);
  if (!seen) stopSeenTimer(); // otherwise the open email would be marked read again
  await markMany(members, seen);
  updateConvBar();
  updateSeenButton();
  fillThread();
});

/// The emails a conversation button acts on: all of them, or (when the
/// settings ask so) the choice of the open email only.
async function convTargets(button, verb) {
  const all = convMovable();
  if (!state.askConversation || all.length < 2) return all;
  const total = convMembers().length;
  const allText = all.length === total ? `all ${total} emails of the conversation` : `the ${all.length} received emails of the conversation (your sent ones stay)`;
  const choice = await chooseScope(button, verb, allText);
  if (choice === "one") return [readerCard];
  return choice === "all" ? all : null;
}

for (const [id, kind, verb] of [["conv-archive", "archive", "Archive"], ["conv-trash", "trash", "Delete"]]) {
  $(id).addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const members = await convTargets($(id), verb);
    if (!members) return;
    leaveEmail();
    fileMany(members, kind, { conversation: members.length > 1 });
  });
}

$("conv-spam").addEventListener("click", async (ev) => {
  ev.stopPropagation();
  const inJunk = folderKind(readerCard.folder) === "junk";
  const members = await convTargets($("conv-spam"), inJunk ? "Not spam" : "Spam");
  if (!members) return;
  leaveEmail();
  if (inJunk) moveMany(members, "INBOX");
  else fileMany(members, "junk", { conversation: members.length > 1 });
});

function closeConvMenu() {
  document.querySelector(".conv-menu")?.remove();
}

/// A small menu under `anchor`, filled by `fill(menu)`.
function popMenu(anchor, fill) {
  const r = anchor.getBoundingClientRect();
  return popMenuAt(r.right, r.bottom + 6, fill, true);
}

/// A small menu at (x, y) (its right edge there with `alignRight`), kept on screen.
function popMenuAt(x, y, fill, alignRight = false) {
  closeConvMenu();
  const menu = el("div", "conv-menu");
  fill(menu);
  document.body.append(menu);
  const left = alignRight ? x - menu.offsetWidth : x;
  menu.style.left = Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + "px";
  return menu;
}

function menuButton(iconName, text, run) {
  const b = el("button");
  b.type = "button";
  b.append(icon(iconName), el("span", "", text));
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    run();
  });
  return b;
}

/// Asks whether to act on the open email only or on the whole conversation.
/// Resolves to "one", "all" or null (menu closed).
function chooseScope(anchor, verb, allText) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeConvMenu();
      resolve(v);
    };
    const menu = popMenu(anchor, (m) => {
      m.classList.add("scope-menu");
      m.append(
        menuButton("envelope", `${verb}: only this email`, () => finish("one")),
        menuButton("reply-all", `${verb}: ${allText}`, () => finish("all")),
        el("div", "menu-hint muted", "You can stop this question in Settings → Reading."),
      );
    });
    new MutationObserver((_, obs) => {
      if (!menu.isConnected) {
        obs.disconnect();
        finish(null);
      }
    }).observe(document.body, { childList: true });
  });
}

/// Fills `menu` with the folders offered for a move, in the sidebar's order
/// and without the ones left out in Settings → Folders; "All folders…" brings
/// those back for the odd email. A field on top finds a folder by name among
/// all of them (Enter takes the first). `here` is the folder the emails are in.
function fillMoveList(menu, head, here, pick, all = false) {
  const can = orderedFolders(true).filter((f) => f.selectable !== false && f.name !== here && folderKind(f.name) !== "drafts");
  const find = el("input", "menu-input");
  find.placeholder = "Find a folder";
  find.spellcheck = false;
  find.autocomplete = "off";
  const items = el("div", "menu-items");
  const fill = () => {
    const words = find.value.trim().toLowerCase();
    const shown = words ? can.filter((f) => (folderLabel(f.name) + " " + f.name).toLowerCase().includes(words)) : all ? can : can.filter((f) => !folderPref(f.name)?.hide_in_move);
    items.replaceChildren();
    for (const f of shown) {
      const b = menuButton("folder", folderLabel(f.name), () => pick(f.name));
      if (!words) b.style.paddingLeft = 10 + (f.depth || 0) * 14 + "px";
      items.append(b);
    }
    if (!shown.length) items.append(el("div", "menu-hint muted", "No folder found"));
    if (!words && shown.length < can.length) {
      if (shown.length) items.append(el("div", "menu-sep"));
      items.append(menuButton("folder", "All folders…", () => {
        all = true;
        fill();
        // The longer list must stay on screen.
        menu.style.top = Math.max(8, Math.min(menu.offsetTop, window.innerHeight - menu.offsetHeight - 8)) + "px";
      }));
    }
  };
  find.addEventListener("click", (ev) => ev.stopPropagation());
  find.addEventListener("input", fill);
  find.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      items.querySelector("button")?.click();
    } else if (ev.key === "Escape") closeConvMenu();
  });
  menu.replaceChildren(...head, find, items);
  fill();
  setTimeout(() => find.focus());
}

/// The folders an email can be moved to, as a menu under `anchor`.
function showFolderMenu(anchor, pick, here = readerCard?.folder) {
  if (document.querySelector(".conv-menu.folders")) return closeConvMenu();
  popMenu(anchor, (menu) => {
    menu.classList.add("folders");
    fillMoveList(menu, [], here, (to) => {
      closeConvMenu();
      pick(to);
    });
  });
}

$("conv-move").addEventListener("click", async (ev) => {
  ev.stopPropagation();
  if (document.querySelector(".conv-menu")) return closeConvMenu();
  const members = await convTargets($("conv-move"), "Move");
  if (!members) return;
  showFolderMenu($("conv-move"), (to) => {
    leaveEmail();
    moveMany(members, to, { conversation: members.length > 1 });
  });
});
document.addEventListener("mousedown", (ev) => {
  if (!ev.target.closest?.(".conv-menu, #conv-move, #reader-move, [data-sel='move']")) closeConvMenu();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && document.querySelector(".conv-menu")) {
    ev.stopImmediatePropagation();
    closeConvMenu();
  }
}, true);

/// Earlier and later emails of the conversation as compact rows around the open one.
/// With `anchor`, the open email keeps its place on screen while rows are added above it.
function renderThread({ anchor = false } = {}) {
  updateConvBar();
  renderReaderDraft();
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
  const drafts = draftsFolder();
  const row = (e) => {
    if (e.folder === drafts) {
      // Not an email of the conversation yet: a reply not sent.
      const r = el("div", "thread-row draft");
      r.title = "Still in Drafts: open it to finish and send it";
      const from = el("span", "t-from");
      from.append(el("span", "wait-tag draft-tag", "✎ Draft · not sent"));
      r.append(el("span", "avatar draft-avatar", "✎"), from, el("span", "t-preview", e.card.preview || e.card.subject), el("span", "t-date", formatDate(e.card.date)));
      r.addEventListener("click", () => openDraft(e.folder, e.card));
      return r;
    }
    const r = el("div", "thread-row" + (e.card.seen ? "" : " unseen"));
    r.title = `${e.card.subject} — ${e.folder}`;
    const reply = el("button", "t-reply");
    reply.title = "Reply to this email";
    reply.append(icon("reply"));
    reply.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openReader(e.folder, e.card, { thread: entries, then: "reply" });
    });
    // Actions on this email only, shown when pointing at the row.
    const tools = el("span", "t-tools");
    const tool = (iconName, title, run) => {
      const b = el("button", "t-reply");
      b.title = title;
      b.append(icon(iconName));
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        run();
      });
      tools.append(b);
    };
    tool(e.card.seen ? "envelope" : "envelope-open", e.card.seen ? "Mark this email as unread" : "Mark this email as read", async () => {
      await setSeen(e.folder, e.card, !e.card.seen);
      fillThread();
    });
    const drop = (kind) => {
      readerThread = (readerThread || []).filter((x) => x !== e);
      renderThread({ anchor: true });
      fileMany([e], kind);
    };
    const kind = folderKind(e.folder);
    if (kind !== "archive" && kind !== "sent") tool("archive", "Archive this email", () => drop("archive"));
    if (kind !== "trash") tool("trash", "Delete this email (move to trash)", () => drop("trash"));
    r.append(avatar(e.card.from || "?"), el("span", "t-from", e.card.from), el("span", "t-preview", e.card.preview), el("span", "t-date", formatDate(e.card.date)), tools, reply);
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
  // Keys pressed after clicking inside the email still reach the shortcuts.
  doc.addEventListener("keydown", (ev) => {
    if (ev.metaKey || ev.ctrlKey) return; // copying text inside the email stays as it is
    const copy = new KeyboardEvent("keydown", { key: ev.key, code: ev.code, shiftKey: ev.shiftKey, bubbles: true, cancelable: true });
    document.dispatchEvent(copy);
    if (copy.defaultPrevented) ev.preventDefault();
  });
  for (const img of doc.images) img.addEventListener("load", fit);
  // A click on a link is handled by the app itself (external_links in main.rs).
  for (const a of doc.querySelectorAll("a[href]")) {
    let href = a.getAttribute("href").trim();
    if (/^www\./i.test(href)) href = "https://" + href;
    a.title = href;
    if (/^mailto:/i.test(href)) a.href = "https://mailto.invalid/?" + encodeURIComponent(href);
    else if (linkWarning(a.textContent, href)) {
      // Opened only after a question (external_links in main.rs sends it back here).
      a.href = "https://link-check.invalid/?" + encodeURIComponent(JSON.stringify({ url: href, shown: a.textContent.trim() }));
    } else a.href = href;
  }
}

/// The site a web address leads to, without "www.", or "" when it is not one.
function siteOf(address) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(address) ? address : "https://" + address);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, "") : "";
  } catch (_) {
    return "";
  }
}

/// Why a link of an email may not go where it seems to, or "" when it looks
/// fine: its text names another site (the classic phishing trick), the
/// address hides its real site behind a name and an "@", or the site is
/// written with look-alike letters from other alphabets.
function linkWarning(text, href) {
  let u;
  try {
    u = new URL(href);
  } catch (_) {
    return "";
  }
  if (!/^https?:$/.test(u.protocol)) return "";
  const site = u.hostname.toLowerCase().replace(/^www\./, "");
  if (u.username || u.password) return `The address hides where it leads: it goes to ${site}.`;
  if (/(^|\.)xn--/.test(site)) return `The site name uses letters that look like others (${site}): it may imitate a known site.`;
  // Only a text that is itself an address can lie about it: "Click here" cannot.
  const shown = (text || "").trim().replace(/[.,;:)\]]+$/, "");
  if (!/^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(shown)) return "";
  const claimed = siteOf(shown);
  if (!claimed || claimed === site || site.endsWith("." + claimed) || claimed.endsWith("." + site)) return "";
  return `The link shows ${claimed} but leads to ${site}.`;
}

/// A link of an email that may not go where it seems: says where it really
/// leads and opens it only if asked to.
async function openCheckedLink({ url, shown }) {
  const why = linkWarning(shown, url);
  const choice = await ask(`${why || "This link may not go where it seems."}\n\nFull address:\n${url}`, [
    { label: "Cancel", value: null },
    { label: "Open anyway", value: "open", kind: "danger" },
  ]);
  if (choice === "open") openLink(url);
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

/// A dark place for emails: their HTML has its own colors, so the whole frame is
/// inverted down to the color of the background, and pictures are turned back
/// (invert and contrast together exactly undo that on the way through the frame).
function darkFrameLook() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--mail-bg").trim();
  if (!/^#[0-9a-f]{6}$/i.test(bg)) return null;
  const level = [1, 3, 5].reduce((sum, i) => sum + parseInt(bg.slice(i, i + 2), 16), 0) / 765;
  if (level > 0.5) return null;
  const strength = (1 - level).toFixed(3);
  return {
    frame: `invert(${strength}) hue-rotate(180deg)`,
    inside: `img,video{filter:invert(1) contrast(${(1 / (1 - 2 * level)).toFixed(3)}) hue-rotate(180deg)}`,
  };
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
    const dark = darkFrameLook();
    if (dark) frame.style.filter = dark.frame;
    frame.srcdoc =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${readerRemoteAllowed ? FRAME_CSP_REMOTE_IMAGES : FRAME_CSP}">` +
      `<style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:16px;color:#1c1f24;overflow-wrap:anywhere}img{max-width:100%}${dark?.inside || ""}</style>` +
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
  closeConvMenu();
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
$("reader-minimize").addEventListener("click", minimizeReader);

const MINIMIZED_MAX = 4;
let minimizedEmails = [];

/// Puts the open email in a bar at the bottom, to come back to it later.
function minimizeReader() {
  if (!readerCard) return;
  minimizedEmails = [...minimizedEmails, { ...readerCard, thread: readerThread }].slice(-MINIMIZED_MAX);
  closeReader();
  renderReaderDock();
}

function dropMinimized(folder, card) {
  const left = minimizedEmails.filter((m) => m.folder !== folder || m.card.uid !== card.uid);
  if (left.length === minimizedEmails.length) return;
  minimizedEmails = left;
  renderReaderDock();
}

function renderReaderDock() {
  const dock = $("reader-dock");
  dock.hidden = !minimizedEmails.length;
  dock.replaceChildren(
    ...minimizedEmails.map((m) => {
      const subject = m.card.subject || "(no subject)";
      const bar = el("div", "reader-bar");
      const open = el("button", "reader-bar-open", subject);
      open.title = subject;
      open.addEventListener("click", () => openReader(m.folder, m.card, { thread: m.thread }));
      const close = el("button", "icon-btn");
      close.append(icon("close"));
      close.title = "Close";
      close.addEventListener("click", () => dropMinimized(m.folder, m.card));
      bar.append(open, close);
      return bar;
    }),
  );
}
$("reader").addEventListener("click", (ev) => {
  if (ev.target === $("reader")) closeReader();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (!$("dialog").hidden) closeDialog(null);
  else if (!$("composer").hidden && !composerMinimized()) closeComposer();
  else if (!$("settings").hidden) closeSettingsWithoutSaving();
  else if (!$("reader").hidden) closeReader();
  else if (focusKey) setFocus(null);
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
