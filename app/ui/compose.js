// Pigeonhole: writing, replying, attachments and extra senders.

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
  from: "", // extra sender's address; "" = the main account
};

const MAX_ATTACH_BYTES = 25 * 1024 * 1024; // most mail servers refuse larger emails

function composeSnapshot() {
  return RCPT_FIELDS.map(recipientValue)
    .concat(["compose-subject", "compose-body"].map((id) => $(id).value))
    .concat(compose.rich ? $("compose-rich").innerHTML : compose.markdown ? "md" : "plain", compose.attachments.map((a) => a.name + ":" + a.size).join("|"), compose.from)
    .join("\u0000");
}

function composeDraft() {
  return {
    to: recipientValue("compose-to"),
    cc: recipientValue("compose-cc"),
    bcc: recipientValue("compose-bcc"),
    subject: $("compose-subject").value,
    body: compose.rich ? richText() : $("compose-body").value,
    html: compose.rich ? $("compose-rich").innerHTML : null,
    in_reply_to: compose.context?.in_reply_to ?? null,
    references: compose.context?.references ?? [],
    message_id: compose.messageId,
    from: compose.from || null,
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
      refreshDrafts(1500);
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

async function openComposer({ to = "", cc = "", bcc = state.defaultBcc, subject = "", body = "", html = null, format = null, reply = null, context = null, title = "New email", messageId = null, fromDraft = false, attachments = [], from = "", quote = null } = {}) {
  if (!$("composer").hidden) {
    // One email at a time: the one being written (maybe minimized) comes back.
    minimizeComposer(false);
    return toast("Finish or close the email you are writing first.", "info");
  }
  compose.attachments = attachments;
  compose.from = senderNamed(from)?.email || "";
  compose.quote = quote;
  // A draft opens in the editor it was written in; a new email in the usual one.
  const fmt = format || local.get("composeFormat");
  compose.markdown = fmt === "markdown";
  compose.rich = fmt === "rich";
  setPreview(false);
  renderComposeAttachments();
  renderFormat();
  compose.title = title;
  $("compose-title").textContent = title;
  setRecipients("compose-to", to);
  setRecipients("compose-cc", cc);
  setRecipients("compose-bcc", bcc);
  $("compose-subject").value = subject;
  $("compose-body").value = body;
  if (compose.rich) $("compose-rich").innerHTML = html ?? richFromText(body);
  renderComposeSender();
  setComposeStatus("");
  compose.reply = reply;
  compose.context = context;
  compose.initial = compose.saved = composeSnapshot();
  compose.hasDraft = fromDraft;
  $("compose-drop").hidden = true;
  compose.messageId = messageId;
  $("composer").hidden = false;
  const bodyEl = composeEditor();
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
  minimizeComposer(false);
  $("composer").hidden = true;
}

/// The editor in use: rich (visual) or plain text.
const composeEditor = () => (compose.rich ? $("compose-rich") : $("compose-body"));

/// Minimized, the email being written becomes a bar at the bottom right: the board and
/// other emails stay usable meanwhile, a click on the bar brings it back.
const composerMinimized = () => $("composer").classList.contains("minimized");
function minimizeComposer(on) {
  $("composer").classList.toggle("minimized", on);
  $("compose-minimize").querySelector("use").setAttribute("href", on ? "#i-expand" : "#i-minimize");
  $("compose-minimize").title = on ? "Open the email again" : "Minimize: keep writing later, read other emails meanwhile";
  $("compose-title").textContent = (on && $("compose-subject").value.trim()) || compose.title;
  if (on) hideSuggestions();
  else if (!$("composer").hidden) composeEditor().focus();
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
    refreshDrafts(0);
  }
}

/// Opens a saved draft in the composer to keep writing it.
async function openDraft(folder, card) {
  try {
    const msg = await invoke("read_message", { folder, uid: card.uid });
    const attachments = await loadAttachments(folder, card.uid, msg.attachments || []);
    // Written in the visual editor: its HTML comes back, with the formatting
    // and the rich signature (drafts of older versions say nothing: then the
    // HTML is used when the visual editor is the usual one).
    const format = msg.draft_format || (msg.html && local.get("composeFormat") === "rich" ? "rich" : null);
    const html = format === "rich" ? msg.html : null;
    openComposer({
      attachments,
      to: msg.to,
      cc: msg.cc,
      bcc: msg.bcc,
      subject: msg.subject,
      body: msg.text || "",
      html,
      format: html || format !== "rich" ? format : null,
      context: msg.in_reply_to ? { in_reply_to: msg.in_reply_to, references: msg.references.filter((r) => r !== msg.in_reply_to) } : null,
      messageId: msg.message_id,
      from: msg.reply_address,
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

/// A file's content as base64. Throws when nothing could be read, so an
/// attachment is never sent empty.
async function readFile(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length && file.size) {
    // Some files (e.g. not yet downloaded from iCloud/OneDrive) need a second try.
    await new Promise((r) => setTimeout(r, 400));
    bytes = new Uint8Array(await file.arrayBuffer());
  }
  if (!bytes.length) {
    throw new Error(
      file.size
        ? "its content could not be read. If it is in iCloud Drive, OneDrive or Dropbox, make sure it is downloaded to this Mac, then attach it again"
        : "the file is empty",
    );
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
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
      const data = await readFile(file);
      compose.attachments.push({ name: file.name, mime: file.type || "application/octet-stream", size: Math.floor((data.length * 3) / 4), data });
    } catch (e) {
      toast(`Could not attach ${file.name}: ${e.message || e}`);
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

// The paperclip opens the system "Open" panel and the app reads the files
// itself (the web view's file picker could hand over files with no content).
$("compose-attach").addEventListener("click", async () => {
  let picked;
  try {
    picked = await invoke("pick_attachments");
  } catch (e) {
    return toast("Could not attach: " + e);
  }
  for (const f of picked) {
    if (formatSizeTotal() + f.size > MAX_ATTACH_BYTES) {
      toast(`${f.name} is too big: emails can carry about ${formatSize(MAX_ATTACH_BYTES)} in total.`);
      continue;
    }
    compose.attachments.push({ name: f.name, mime: f.mime, size: f.size, data: f.data });
  }
  renderComposeAttachments();
});

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
      was === "markdown" ? await invoke("render_markdown", { text }).catch(() => textToRichHtml(text)) : richFromText(text);
  } else if (was === "rich") {
    $("compose-body").value = richText();
  }
  compose.markdown = fmt === "markdown";
  compose.rich = fmt === "rich";
  local.set("composeFormat", fmt);
  if (fmt !== "markdown") await setPreview(false);
  renderFormat();
  composeEditor().focus();
}

const textToHtml = (t) => escapeHtml(t).replace(/\n/g, "<br>");

/// Plain text to editor HTML, with the quoted email of a reply or forward
/// in its own formatting when it is still there unchanged.
function richFromText(text) {
  const q = compose.quote;
  if (q?.html && text.endsWith(q.text)) return textToRichHtml(text.slice(0, -q.text.length)) + q.html;
  return textToRichHtml(text);
}

/// Plain text to editor HTML. The signature block becomes the rich signature
/// when there is one, in a block found again when the sender changes.
function textToRichHtml(text) {
  const sig = signatureFor(compose.from);
  const marker = sig ? "-- \n" + sig : null;
  const pos = marker ? text.indexOf(marker) : -1;
  if (pos < 0) return textToHtml(text);
  return textToHtml(text.slice(0, pos)) + `<div data-signature>-- <br>${signatureHtml(compose.from)}</div>` + textToHtml(text.slice(pos + marker.length));
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
/// Font and size go in the style of the text: a <font> tag would be lost when the
/// email is shown again, here and by some mail programs.
function richStyle(select, command) {
  select.addEventListener("change", () => {
    const value = select.value;
    select.value = "";
    if (!value) return;
    restoreRich();
    document.execCommand("styleWithCSS", false, true);
    document.execCommand(command, false, value);
    document.execCommand("styleWithCSS", false, false);
    rememberRich();
  });
}
richStyle($("rich-font"), "fontName");
richStyle($("rich-size"), "fontSize");
// Tab moves a list item in and out; elsewhere it keeps leaving the field.
const RICH_SHORTCUTS = { b: "bold", i: "italic", u: "underline" };
$("compose-rich").addEventListener("keydown", (ev) => {
  const shortcut = (ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey && RICH_SHORTCUTS[ev.key.toLowerCase()];
  if (shortcut) {
    ev.preventDefault();
    document.execCommand(shortcut);
    return;
  }
  const node = window.getSelection().anchorNode;
  const inList = (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest("li");
  if (ev.key === " " && !inList && startList(node)) ev.preventDefault();
  if (ev.key !== "Tab" || !inList) return;
  ev.preventDefault();
  document.execCommand(ev.shiftKey ? "outdent" : "indent");
});
/// "- " or "* " at the start of a line begins a bulleted list, "1. " a numbered one.
function startList(node) {
  const sel = window.getSelection();
  if (!sel.isCollapsed || node?.nodeType !== Node.TEXT_NODE) return false;
  const typed = node.data.slice(0, sel.anchorOffset);
  const cmd = /^[-*]$/.test(typed) ? "insertUnorderedList" : typed === "1." ? "insertOrderedList" : null;
  const prev = node.previousSibling;
  if (!cmd || (prev && prev.nodeName !== "BR") || !/^(DIV|P)$/.test(node.parentElement.nodeName)) return false;
  sel.setBaseAndExtent(node, 0, node, typed.length);
  document.execCommand("delete");
  document.execCommand(cmd);
  return true;
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
// Pasted text keeps bold, lists and links but not its colors and fonts: text copied from a
// dark window would otherwise arrive white on the white editor. The paste itself is left to
// the system (it also converts RTF from Word, Pages or Notes); the nodes it adds are cleaned.
function cleanPasted(root) {
  if (root.nodeType !== 1) return;
  for (const n of [root, ...root.querySelectorAll("*")]) {
    if (/^(STYLE|SCRIPT|META|LINK|TITLE|IFRAME|OBJECT)$/.test(n.tagName)) { n.remove(); continue; }
    for (const a of [...n.attributes]) {
      if (/^on|^(color|bgcolor|face|class)$/i.test(a.name)) n.removeAttribute(a.name);
    }
    if (/^\s*javascript:/i.test(n.getAttribute("href") || "")) n.removeAttribute("href");
    for (const p of ["color", "background", "background-color", "caret-color", "-webkit-text-fill-color", "font-family"]) n.style?.removeProperty(p);
    if (!n.getAttribute("style")) n.removeAttribute("style");
  }
}

function pasteClean(ev) {
  const editor = ev.currentTarget;
  const added = [];
  const watch = new MutationObserver((records) => records.forEach((r) => added.push(...r.addedNodes)));
  watch.observe(editor, { childList: true, subtree: true });
  setTimeout(() => {
    watch.takeRecords().forEach((r) => added.push(...r.addedNodes));
    watch.disconnect();
    added.filter((n) => editor.contains(n)).forEach(cleanPasted);
  });
}

// Pasted images go into the email as embedded images.
$("compose-rich").addEventListener("paste", async (ev) => {
  const files = [...(ev.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return pasteClean(ev);
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
  const dark = darkFrameLook();
  if (dark) frame.style.filter = dark.frame;
  frame.srcdoc =
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
    `<style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:12px 14px;color:#1c1f24}img{max-width:100%}${dark?.inside || ""}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:10px;color:#555}</style>` +
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
  const from = senderAmong(msg.all_recipients);
  const text = "\n\n" + header.join("\n") + "\n\n" + (msg.text || "");
  const html = msg.html ? `<br><div>${header.map(escapeHtml).join("<br>")}</div><br>${emailBodyHtml(msg)}` : null;
  await openComposer({
    subject,
    from,
    body: signatureBlock(from) + text,
    quote: { text, html },
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

// ---------- extra senders ----------

/// The extra sender with this address, if any.
function senderNamed(email) {
  const key = (email || "").trim().toLowerCase();
  return key ? state.senders.find((s) => s.email.toLowerCase() === key) : undefined;
}
/// The extra sender an email was addressed to (to reply from it), or "".
const senderAmong = (addresses = []) => state.senders.find((s) => addresses.some((a) => a.toLowerCase() === s.email.toLowerCase()))?.email.toLowerCase() || "";
/// The signature text of a sender: its own, or the main one.
const signatureFor = (from) => senderNamed(from)?.signature || state.signature;
/// The signature as editor HTML: the main one may be rich.
function signatureHtml(from) {
  const own = senderNamed(from);
  if (own?.signature) return own.signature_html || textToHtml(own.signature);
  return state.signatureHtml || textToHtml(state.signature);
}

/// "From": plain text with only the main account, a menu with extra senders.
function renderComposeSender() {
  const account = currentAccount();
  const badge = $("compose-account");
  badge.hidden = !severalAccounts();
  badge.replaceChildren(accountBadge(el("span", "avatar"), account));
  badge.title = account.label || account.email;
  const select = $("compose-sender");
  select.hidden = !state.senders.length;
  $("compose-from").textContent = state.senders.length ? "From" : "From: " + state.email;
  if (!state.senders.length) return;
  const label = (name, email) => (name ? `${name} <${email}>` : email);
  select.replaceChildren(new Option(label(state.displayName, state.email), ""), ...state.senders.map((s) => new Option(label(s.display_name, s.email), s.email)));
  select.value = compose.from;
}

/// Changing the sender swaps the signature in the text, if it is still there.
$("compose-sender").addEventListener("change", (ev) => {
  const [before, after] = [signatureFor(compose.from), signatureFor(ev.target.value)];
  compose.from = ev.target.value;
  if (compose.rich) {
    const block = $("compose-rich").querySelector("[data-signature]");
    if (block && after) block.innerHTML = "-- <br>" + signatureHtml(compose.from);
    else block?.remove();
    return;
  }
  const body = $("compose-body");
  if (before) body.value = body.value.replace("-- \n" + before, () => (after ? "-- \n" + after : ""));
});

/// Signature in the standard format: "-- " on a line of its own, then the text.
function signatureBlock(from = "") {
  const sig = signatureFor(from);
  return sig ? `\n\n-- \n${sig}` : "";
}

const quoteIntro = (msg) => `${msg.date ? "On " + formatDate(msg.date, true) + ", " : ""}${msg.from} wrote:`;

/// The earlier email quoted under a reply: as text, and as HTML keeping its
/// formatting when it has some.
function quote(msg) {
  const text = msg.text || "";
  const quoted = text.replace(/\s+$/, "").split("\n").map((l) => "> " + l).join("\n");
  return `\n\n${quoteIntro(msg)}\n${quoted}\n`;
}
function replyQuote(msg) {
  const html = `<br><div>${escapeHtml(quoteIntro(msg))}</div><blockquote type="cite" style="margin:0 0 0 0.8ex; border-left:2px solid #ccc; padding-left:1ex">${emailBodyHtml(msg)}</blockquote>`;
  return { text: quote(msg), html: msg.html ? html : null };
}

/// The body of an email for quoting in the visual editor: without its styles
/// and head, which would change the whole app once inside the editor.
function emailBodyHtml(msg) {
  if (!msg.html) return textToHtml(msg.text || "");
  const doc = new DOMParser().parseFromString(msg.html, "text/html");
  for (const n of doc.querySelectorAll("style, link, meta, title, base, script")) n.remove();
  return doc.body.innerHTML;
}

/// Who and what a reply to `msg` goes to (from the open email).
function replyFields(msg, all) {
  const me = state.email.toLowerCase();
  const to = msg.reply_address;
  const from = senderAmong(msg.all_recipients);
  let cc = "";
  if (all) {
    const seen = new Set([me, from, to.toLowerCase()]);
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
  return { to, cc, subject, from, reply: { folder: readerCard.folder, uid: readerCard.card.uid }, context: { in_reply_to: msg.message_id, references: msg.references } };
}

function replyTo(all, text = "") {
  const msg = readerMessage;
  if (!msg) return;
  const f = replyFields(msg, all);
  const q = replyQuote(msg);
  openComposer({ ...f, body: text + signatureBlock(f.from) + q.text, quote: q, title: all ? "Reply all" : "Reply" });
}

// ---------- quick reply ----------

/// The quick reply under the open email, only for emails someone else sent.
/// It stays closed until asked for, so reading is not an invitation to answer.
function showQuickReply() {
  const msg = readerMessage;
  const kind = readerCard && folderKind(readerCard.folder);
  const can = !!msg?.reply_address && !["drafts", "sent"].includes(kind) && !myAddresses().has(msg.reply_address.toLowerCase());
  $("reader-quick").hidden = !can;
  closeQuickReply();
}

function openQuickReply() {
  const msg = readerMessage;
  if ($("reader-quick").hidden || !msg) return;
  $("quick-reply-text").placeholder = `Quick reply to ${shortName(msg.from) || msg.reply_address}…  (⌘↵ sends, Esc closes)`;
  $("quick-reply").hidden = false;
  $("quick-reply").scrollIntoView({ block: "nearest" });
  $("quick-reply-text").focus();
}

function closeQuickReply() {
  $("quick-reply").hidden = true;
  $("quick-reply-text").value = "";
}

$("reader-quick").addEventListener("click", openQuickReply);
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "ArrowDown" || !(ev.metaKey || ev.ctrlKey) || ev.shiftKey || ev.altKey) return;
  // Only with an email open and visible, and not while typing elsewhere.
  if (ev.target.closest?.("input, textarea, [contenteditable='true']") || !$("reader-quick").offsetParent) return;
  if (!$("composer").hidden && !composerMinimized()) return;
  ev.preventDefault();
  openQuickReply();
});

/// Sends what was typed as a plain reply, with signature and quote, through
/// the usual way (Undo brings it back in the full editor).
async function quickReply() {
  const text = $("quick-reply-text").value.trim();
  if (!text || !readerMessage) return;
  const f = replyFields(readerMessage, false);
  const id = await invoke("new_message_id").catch(() => null);
  // With an HTML email, the reply is HTML too, so the quote keeps its look.
  const q = replyQuote(readerMessage);
  const sig = signatureFor(f.from) ? `<br><div data-signature>-- <br>${signatureHtml(f.from)}</div>` : "";
  const html = q.html ? textToHtml(text) + sig + q.html : null;
  const draft = {
    to: f.to,
    cc: "",
    bcc: state.defaultBcc || "",
    subject: f.subject,
    body: text + signatureBlock(f.from) + q.text,
    html,
    in_reply_to: f.context.in_reply_to,
    references: f.context.references,
    message_id: id,
    from: f.from || null,
    markdown: false,
    attachments: [],
  };
  closeQuickReply();
  queueSend({ draft, reply: f.reply, context: f.context, title: "Reply", rich: !!html, markdown: false, hasDraft: false, attachments: [], saved: true });
}

$("quick-reply-send").addEventListener("click", quickReply);
$("quick-reply-text").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    quickReply();
  } else if (ev.key === "Escape") {
    // Hidden, not emptied: ⌘↓ brings back what was typed.
    ev.stopPropagation();
    $("quick-reply").hidden = true;
  }
});
$("quick-reply-open").addEventListener("click", () => {
  const text = $("quick-reply-text").value.trim();
  replyTo(false, text);
  closeQuickReply();
});
$("quick-reply-templates").addEventListener("click", (ev) => {
  ev.stopPropagation();
  showTemplateMenu($("quick-reply-templates"), (text) => insertText($("quick-reply-text"), text));
});

// ---------- saved replies ----------

/// Puts text where the cursor is in a text field.
function insertText(field, text) {
  field.focus();
  const at = field.selectionStart ?? field.value.length;
  field.setRangeText(text, at, field.selectionEnd ?? at, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/// The saved replies in a menu, with a field to find one; `insert` gets the text.
function showTemplateMenu(anchor, insert) {
  if (document.querySelector(".conv-menu.templates")) return closeConvMenu();
  popMenu(anchor, (menu) => {
    menu.classList.add("templates");
    const list = state.templates || [];
    if (!list.length) {
      menu.append(
        el("div", "menu-hint muted", "No saved replies yet."),
        menuButton("plus", "Write one in the settings…", async () => {
          closeConvMenu();
          if (await openSettings()) showSettingsTab("writing");
        }),
      );
      return;
    }
    const items = el("div", "menu-items");
    const fill = (words = "") => {
      items.replaceChildren();
      for (const t of list.filter((t) => (t.name + " " + t.text).toLowerCase().includes(words))) {
        const b = menuButton("list", t.name, () => {
          closeConvMenu();
          insert(t.text);
        });
        b.title = t.text;
        items.append(b);
      }
      if (!items.childElementCount) items.append(el("div", "menu-hint muted", "None found"));
    };
    if (list.length > 6) {
      const find = menuInput("Find a saved reply", "", () => items.querySelector("button")?.click());
      find.addEventListener("input", () => fill(find.value.trim().toLowerCase()));
      menu.append(find);
    }
    menu.append(items);
    fill();
  });
}

$("compose-templates").addEventListener("mousedown", (ev) => ev.preventDefault()); // keeps the cursor in the text
$("compose-templates").addEventListener("click", (ev) => {
  ev.stopPropagation();
  showTemplateMenu($("compose-templates"), (text) => {
    if (!compose.rich) return insertText($("compose-body"), text);
    restoreRich();
    document.execCommand("insertText", false, text);
  });
});

$("reader-reply").addEventListener("click", () => replyTo(false));
$("reader-reply-all").addEventListener("click", () => replyTo(true));
$("compose").addEventListener("click", () => openComposer({ body: signatureBlock() }));
$("compose-close").addEventListener("click", () => closeComposer());
$("compose-minimize").addEventListener("click", () => minimizeComposer(!composerMinimized()));
$("compose-form").querySelector(".reader-head").addEventListener("click", (ev) => {
  if (composerMinimized() && !ev.target.closest("button")) minimizeComposer(false);
});
$("compose-cancel").addEventListener("click", () => closeComposer());
$("compose-discard").addEventListener("click", () => discardComposer());

// ⌘↩ (Ctrl+Enter on Windows/Linux) sends from any field of the composer.
$("compose-form").addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" || !(ev.metaKey || ev.ctrlKey) || $("compose-send").disabled) return;
  ev.preventDefault();
  hideSuggestions();
  $("compose-form").requestSubmit();
});

$("compose-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  for (const id of RCPT_FIELDS) commitRecipients(id, true);
  if (!recipientValue("compose-to")) {
    $("compose-to").focus();
    return toast("Add at least one recipient in To.");
  }
  const invalid = RCPT_FIELDS.flatMap((id) => compose.rcpt[id]).filter((r) => !validAddress(r.email));
  if (invalid.length) return toast("Check this address: " + invalid[0].email);
  if (!$("compose-subject").value.trim()) {
    const choice = await ask("This email has no subject. Send it anyway?", [
      { label: "Cancel", value: null },
      { label: "Send", value: "send", kind: "primary" },
    ]);
    if (choice !== "send") return;
  }
  if (formatSizeTotal() > MAX_ATTACH_BYTES) return toast("The attachments are too big to send: remove some of them.");
  clearInterval(compose.timer);
  // Everything needed to send it, or to bring it back to the composer on "Undo".
  const pending = {
    draft: composeDraft(),
    reply: compose.reply,
    context: compose.context,
    title: $("compose-title").textContent,
    rich: compose.rich,
    markdown: compose.markdown,
    hasDraft: compose.hasDraft,
    attachments: compose.attachments,
    // Kept in Drafts while it waits, so closing the app does not lose it.
    saved: state.undoSendSeconds > 0 ? saveDraft() : compose.saving,
  };
  hideComposer();
  queueSend(pending);
});

/// Sends an email after the undo delay (or at once), with its Undo.
function queueSend(pending) {
  state.sending = (state.sending || 0) + 1;
  if (!(state.undoSendSeconds > 0)) return sendPending(pending);
  pending.timer = setTimeout(() => sendPending(pending), state.undoSendSeconds * 1000);
  toast("Sending…", "info", { label: "Undo", run: () => undoSend(pending) }, state.undoSendSeconds);
}

/// Sends an email the composer handed over (after the undo delay, if any).
async function sendPending(pending) {
  if (pending.cancelled) return;
  pending.sending = true;
  await pending.saved;
  try {
    const result = await invoke("send_mail", { draft: pending.draft, reply: pending.reply });
    // People you just wrote to become known senders right away.
    const sent = pending.draft;
    for (const part of [sent.to, sent.cc, sent.bcc].join(",").split(/[,;]/)) {
      const m = part.match(/<([^>]+)>/) || part.match(/(\S+@\S+)/);
      if (m) state.known.add(m[1].trim().toLowerCase());
    }
    rememberKnownSenders();
    if (result.warning) toast(result.warning);
    else toast(`Email sent (copy saved to ${result.saved_to})`, "info");
    refreshSentForWaiting(true);
    if (result.saved_to) showSentCopy(result.saved_to, pending.reply);
  } catch (e) {
    toast("Sending failed: " + e, "error", { label: "Open", run: () => reopenPending(pending) });
  }
  state.sending--;
  refreshDrafts(0);
}

/// Puts the copy of a sent email on screen. A server that saves it by itself
/// (Gmail) may take a moment, so there is one more look shortly after.
function showSentCopy(folder, reply) {
  scheduleReload(folder);
  setTimeout(() => {
    scheduleReload(folder);
    refreshSentForWaiting(true);
    // The conversation open in the reader gets the reply too.
    if (reply && readerMessage && readerCard?.folder === reply.folder && readerCard.card.uid === reply.uid) {
      loadThread(readerCard.folder, readerCard.card, readerMessage);
    }
  }, SENT_RECHECK_MS);
}

/// "Undo": the email is not sent and goes back to the composer.
async function undoSend(pending) {
  if (pending.sending) return toast("Too late: the email is already being sent.");
  pending.cancelled = true;
  state.sending--;
  clearTimeout(pending.timer);
  const saved = await pending.saved;
  await reopenPending(pending, saved === true || pending.hasDraft);
}

async function reopenPending(pending, fromDraft = true) {
  if (!$("composer").hidden) {
    // Another email is open: this one stays in Drafts.
    return toast("Not sent: the email is in Drafts.", "info");
  }
  const d = pending.draft;
  await openComposer({
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    body: d.body,
    reply: pending.reply,
    context: pending.context,
    title: pending.title,
    messageId: d.message_id,
    fromDraft,
    attachments: pending.attachments,
  });
  compose.rich = pending.rich;
  compose.markdown = pending.markdown;
  renderFormat();
  if (pending.rich) $("compose-rich").innerHTML = d.html || "";
  compose.initial = compose.saved = composeSnapshot();
}
