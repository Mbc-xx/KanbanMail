// Pigeonhole: the settings, signatures, address suggestions and recipients.

// ---------- settings ----------

function showSettingsTab(name) {
  for (const t of document.querySelectorAll(".tabs .tab")) {
    t.classList.toggle("active", t.dataset.tab === name);
    t.setAttribute("aria-selected", t.dataset.tab === name ? "true" : "false");
  }
  for (const p of document.querySelectorAll(".tab-panel")) p.hidden = p.dataset.panel !== name;
  if (name === "signatures") renderSignatureOwners(); // addresses typed in Account
}
for (const t of document.querySelectorAll(".tabs .tab")) t.addEventListener("click", () => showSettingsTab(t.dataset.tab));

$("open-settings").addEventListener("click", () => openSettings());

async function openSettings(lookOf = null) {
  try {
    const s = await invoke("get_settings");
    showSettingsTab("account");
    renderAccountLooks(lookOf);
    $("set-bcc").value = s.default_bcc;
    $("settings-email").textContent = "Account: " + s.email;
    $("set-name").value = s.display_name;
    $("set-smtp").value = s.smtp_server;
    $("set-port").value = String(s.smtp_port);
    mainSignature = { signature: s.signature, signature_html: s.signature_html };
    $("set-contacts").checked = s.use_system_contacts;
    wasUsingContacts = s.use_system_contacts;
    showContactsStatus();
    $("set-remote").checked = s.load_remote_images;
    $("set-same-domain").checked = s.important_same_domain;
    $("set-group").checked = s.group_threads;
    showThemeInForm(s.theme || "system");
    $("set-zoom").value = String(s.zoom || 100);
    $("set-preview-board").value = String(s.preview_board ?? 2);
    $("set-preview-list").value = String(s.preview_list ?? 1);
    $("set-compact").checked = s.compact_actions ?? true;
    $("set-mail-surface").value = s.mail_surface || "light";
    $("set-theme-per-account").checked = !!s.theme_per_account;
    // Only meaningful with more than one account.
    $("theme-per-account-row").hidden = $("theme-per-account-hint").hidden = !severalAccounts();
    $("set-ask-conv").checked = s.ask_conversation ?? true;
    $("set-after-action").value = s.after_action || "list";
    renderWaitingChoices(s.waiting_folder || "");
    $("set-waiting-days").value = String(s.waiting_days ?? 3);
    renderColumnChoice("set-todo", s.todo_folder || "", "Todo");
    $("set-todo-days").value = String(s.todo_days ?? 5);
    renderColumnChoice("set-done", s.done_folder || "", "Done");
    $("set-done-days").value = String(s.done_days ?? 0);
    $("set-done-target").value = s.done_target || "";
    showDoneTarget();
    $("set-cache-mb").value = String(s.cache_max_mb ?? 1024);
    if (!$("set-cache-mb").value) $("set-cache-mb").value = "1024";
    $("set-prefetch").checked = s.prefetch ?? true;
    showCacheStats();
    $("set-notify").value = s.notify || "important";
    $("set-undo").value = String(s.undo_seconds ?? 8);
    $("set-undo-send").value = String(s.undo_send_seconds ?? 10);
    rulesDraft = (s.rules || []).map((r) => ({ ...r }));
    templatesDraft = (s.templates || []).map((t) => ({ ...t }));
    renderTemplatePrefs();
    // A sender is only saved with its password, so the saved ones have one in the keychain.
    sendersDraft = (s.senders || []).map((x) => ({ ...x, password: "", saved: true }));
    renderSenderPrefs();
    editSignatureOf(mainSignature, false);
    columnsDraft = state.columns.map((c) => ({ name: c.name, folder: c.folder }));
    columnsChanged = false;
    renderFolderNames();
    renderRulePrefs();
    renderColumnPrefs();
    prefsDraft = mergeFolderPrefs(s.folders || []);
    renderFolderPrefs();
    $("set-allow").value = s.important_allow.join("\n");
    $("set-block").value = s.important_block.join("\n");
    showSaveFolder(s.save_folder || "ask");
    $("set-never").checked = s.mark_read_after_seconds < 0;
    $("set-seconds").value = Math.max(0, s.mark_read_after_seconds < 0 ? 3 : s.mark_read_after_seconds);
    $("set-seconds").disabled = s.mark_read_after_seconds < 0;
    $("settings").hidden = false;
    return true;
  } catch (e) {
    toast(String(e));
    return false;
  }
}

$("set-never").addEventListener("change", (ev) => ($("set-seconds").disabled = ev.target.checked));
// Theme and size preview while choosing; Cancel restores the saved ones.
for (const id of ["set-theme", "set-theme-mode", "set-theme-tint", "set-mail-surface", "set-zoom", "set-preview-board", "set-preview-list", "set-compact"]) {
  $(id).addEventListener("change", () => {
    applyAppearance(appearanceFromForm());
    if (readerMessage) renderReaderBody();
  });
}
$("set-theme-color").addEventListener("input", () => applyAppearance(appearanceFromForm()));
for (const color of AVATAR_COLORS) {
  const b = el("button");
  b.type = "button";
  b.style.background = color;
  b.setAttribute("aria-label", color);
  b.addEventListener("click", () => {
    $("set-theme-color").value = color;
    applyAppearance(appearanceFromForm());
  });
  $("theme-swatches").append(b);
}

function showThemeInForm(theme) {
  const custom = parseCustomTheme(theme);
  $("set-theme").value = custom ? "custom" : theme;
  $("custom-theme").hidden = !custom;
  $("set-theme-color").value = custom?.color || AVATAR_COLORS[0];
  $("set-theme-mode").value = custom?.mode || "dark";
  $("set-theme-tint").value = custom?.tint || "neutral";
}
function closeSettingsWithoutSaving() {
  if (state.appearance) applyAppearance(state.appearance);
  if (readerMessage) renderReaderBody();
  $("settings").hidden = true;
}
$("settings-cancel").addEventListener("click", closeSettingsWithoutSaving);

$("settings-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const seconds = $("set-never").checked ? -1 : Math.max(0, parseInt($("set-seconds").value, 10) || 0);
  editSignatureOf(null); // keeps the signature being edited
  const noPassword = sendersDraft.find((x) => x.email.trim() && !x.password && !x.saved);
  if (noPassword) {
    showSettingsTab("account");
    return toast(`Type the password of ${noPassword.email.trim()}.`);
  }
  try {
    await invoke("save_settings", {
      settings: {
        email: state.email,
        display_name: $("set-name").value,
        smtp_server: $("set-smtp").value,
        smtp_port: parseInt($("set-port").value, 10),
        mark_read_after_seconds: seconds,
        save_folder: saveFolderFromForm(),
        signature: mainSignature.signature,
        signature_html: mainSignature.signature_html,
        default_bcc: $("set-bcc").value,
        use_system_contacts: $("set-contacts").checked,
        load_remote_images: $("set-remote").checked,
        important_allow: $("set-allow").value.split(/[\n,;]+/),
        important_block: $("set-block").value.split(/[\n,;]+/),
        important_same_domain: $("set-same-domain").checked,
        group_threads: $("set-group").checked,
        folders: prefsDraft,
        rules: rulesDraft.filter((r) => r.contains.trim() && r.folder.trim()),
        templates: templatesDraft.filter((t) => t.text.trim()),
        senders: sendersDraft.map(senderOf),
        sender_passwords: Object.fromEntries(sendersDraft.filter((x) => x.password).map((x) => [x.email.trim(), x.password])),
        notify: $("set-notify").value,
        undo_seconds: parseInt($("set-undo").value, 10),
        undo_send_seconds: parseInt($("set-undo-send").value, 10),
        ...appearanceFromForm(),
        waiting_folder: $("set-waiting").value,
        waiting_days: parseInt($("set-waiting-days").value, 10),
        todo_folder: $("set-todo").value,
        todo_days: parseInt($("set-todo-days").value, 10),
        done_folder: $("set-done").value,
        done_days: parseInt($("set-done-days").value, 10),
        done_target: $("set-done-target").value.trim(),
        cache_max_mb: parseInt($("set-cache-mb").value, 10),
        prefetch: $("set-prefetch").checked,
        ask_conversation: $("set-ask-conv").checked,
        after_action: $("set-after-action").value,
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
    renderSoon();
    if ($("set-contacts").checked) loadContacts(!wasUsingContacts);
    else state.contacts = [];
    state.markReadAfter = seconds;
    state.signature = mainSignature.signature;
    state.signatureHtml = mainSignature.signature_html;
    state.defaultBcc = $("set-bcc").value.trim();
    state.undoSendSeconds = parseInt($("set-undo-send").value, 10);
    state.loadRemoteImages = $("set-remote").checked;
    $("settings").hidden = true;
    toast("Settings saved", "info");
  } catch (e) {
    toast("Settings not saved: " + e);
  }
});

function showDoneTarget() {
  $("done-target-row").hidden = $("set-done-days").value === "0";
}
$("set-done-days").addEventListener("change", showDoneTarget);

$("test-notification").addEventListener("click", async () => {
  $("notify-state").textContent = "";
  try {
    await showNotification("Pigeonhole", "Notifications work: new emails will show up like this.");
    $("notify-state").textContent = "Sent: it should appear at the top right.";
  } catch (e) {
    $("notify-state").textContent = String(e) === NOTIFY_DENIED ? "Turned off in System Settings → Notifications." : "Not sent: " + e;
  }
});

// ---------- export / import ----------

// ---------- where files are saved ----------

function showSaveFolder(value) {
  const preset = value === "ask" || value === "downloads";
  $("set-save-where").value = preset ? value : "folder";
  $("save-folder-path").textContent = preset ? "" : value;
  $("save-folder-row").hidden = preset;
}

const saveFolderFromForm = () => {
  const where = $("set-save-where").value;
  return where === "folder" ? $("save-folder-path").textContent || "ask" : where;
};

async function chooseSaveFolder() {
  const folder = await invoke("pick_save_folder").catch(() => null);
  if (folder) $("save-folder-path").textContent = folder;
  showSaveFolder(saveFolderFromForm());
}

$("set-save-where").addEventListener("change", () => {
  const folder = $("set-save-where").value === "folder";
  $("save-folder-row").hidden = !folder;
  if (folder && !$("save-folder-path").textContent) chooseSaveFolder();
});
$("save-folder-pick").addEventListener("click", chooseSaveFolder);

$("export-settings").addEventListener("click", async () => {
  try {
    const path = await invoke("export_settings");
    if (path) savedToast("Settings saved", path);
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

let sendersDraft = []; // extra senders being edited, with a typed password and whether one is saved

/// A sender as saved in the settings (without the password fields).
const senderOf = ({ email, display_name, smtp_server, smtp_port, signature, signature_html }) => ({ email, display_name, smtp_server, smtp_port, signature, signature_html });

function renderSenderPrefs() {
  const box = $("sender-prefs");
  box.replaceChildren();
  sendersDraft.forEach((s, i) => {
    const field = (tag, key, placeholder, type) => {
      const f = el(tag);
      if (type) f.type = type;
      f.placeholder = placeholder;
      f.value = s[key];
      f.addEventListener("input", () => (s[key] = f.value));
      return f;
    };
    const port = document.createElement("select");
    port.append(...[...$("set-port").options].map((o) => new Option(o.text, o.value)));
    port.value = String(s.smtp_port);
    port.addEventListener("change", () => (s.smtp_port = parseInt(port.value, 10)));
    const password = field("input", "password", s.saved ? "Password saved in the keychain (type to change)" : "Password", "password");
    password.classList.add("wide");
    const signature = el("button", "", "Signature…");
    signature.type = "button";
    signature.title = "Edit the signature of this mailbox";
    signature.addEventListener("click", () => {
      showSettingsTab("signatures");
      editSignatureOf(s);
    });
    const status = el("span", "muted");
    const test = el("button", "", "Test");
    test.type = "button";
    test.addEventListener("click", async () => {
      status.textContent = "Logging in…";
      try {
        await invoke("test_sender", { sender: senderOf(s), password: s.password });
        status.textContent = "✓ The login works";
      } catch (e) {
        status.textContent = String(e);
      }
    });
    const actions = el("div", "sender-actions");
    actions.append(status, signature, test, removeButton(() => {
      sendersDraft.splice(i, 1);
      renderSenderPrefs();
      if (signatureOwner === s) editSignatureOf(mainSignature, false);
    }));
    const row = el("div", "sender-pref");
    row.append(field("input", "email", "Address, e.g. desk@example.org", "email"), field("input", "display_name", "Sender name (optional)", "text"), field("input", "smtp_server", "SMTP server", "text"), port, password, actions);
    box.append(row);
  });
}

$("add-sender").addEventListener("click", () => {
  sendersDraft.push({ email: "", display_name: "", smtp_server: $("set-smtp").value.trim(), smtp_port: parseInt($("set-port").value, 10), signature: "", signature_html: "", password: "", saved: false });
  renderSenderPrefs();
  $("sender-prefs").lastElementChild.querySelector("input").focus();
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

let templatesDraft = [];

function renderTemplatePrefs() {
  const box = $("template-prefs");
  box.replaceChildren();
  if (!templatesDraft.length) box.append(el("p", "muted small", "None yet. Example: “Received, thanks: I will answer by tomorrow.”"));
  templatesDraft.forEach((t, i) => {
    const row = el("div", "template-pref");
    const grip = el("span", "fp-grip");
    grip.append(icon("grip"));
    const name = el("input");
    name.value = t.name;
    name.placeholder = "Name (how you find it)";
    name.addEventListener("input", () => (t.name = name.value));
    const text = el("textarea");
    text.rows = 3;
    text.value = t.text;
    text.placeholder = "The text that goes in the email";
    text.addEventListener("input", () => (t.text = text.value));
    const fields = el("div", "template-fields");
    fields.append(name, text);
    row.append(grip, fields, removeButton(() => {
      templatesDraft.splice(i, 1);
      renderTemplatePrefs();
    }));
    makeSortable(row, templatesDraft, i, renderTemplatePrefs, box);
    box.append(row);
  });
}
$("add-template").addEventListener("click", () => {
  templatesDraft.push({ name: "", text: "" });
  renderTemplatePrefs();
  $("template-prefs").lastElementChild?.querySelector("input")?.focus();
});

/// A new rule row in the settings ("from" contains `text`), ready to be completed.
function addRule(text = "") {
  const firstFolder = orderedFolders(true).find((f) => f.selectable && f.kind !== "inbox")?.name || "";
  rulesDraft.push({ field: "from", contains: text, folder: firstFolder });
  renderRulePrefs();
  $("rule-prefs").lastElementChild?.querySelector(text ? "select:last-of-type" : "input")?.focus();
}
$("add-rule").addEventListener("click", () => addRule());

$("run-rules").addEventListener("click", async () => {
  state.rules = rulesDraft.filter((r) => r.contains.trim() && r.folder.trim());
  const inbox = state.cards.INBOX || (await invoke("load_column", { folder: "INBOX", limit: null }).catch(() => []));
  ruleTried.clear();
  const moved = await applyRules(inbox);
  if (!moved.size) toast("No email in the Inbox matches the rules", "info");
});

// ---------- folders tab ----------

let prefsDraft = []; // folder preferences being edited in the settings

/// Every server folder in the current order, with its preferences.
function mergeFolderPrefs(prefs) {
  state.folderPrefs = prefs;
  return orderedFolders(true).map((f) => ({ name: f.name, hidden: !!folderPref(f.name)?.hidden, hide_in_move: !!folderPref(f.name)?.hide_in_move, color: folderPref(f.name)?.color || "" }));
}

function renderFolderPrefs() {
  const box = $("folder-prefs");
  const head = el("div", "folder-pref fp-head muted small");
  head.append(el("span"), el("span", "", "Sidebar"), el("span", "", "Move to"));
  box.replaceChildren(head);
  prefsDraft.forEach((p, i) => {
    const f = state.folders.find((x) => x.name === p.name);
    const row = el("div", "folder-pref" + (p.hidden ? " hidden-folder" : ""));
    // Drag the row to reorder; a line shows where it will land.
    const grip = el("span", "fp-grip");
    grip.title = "Drag to reorder";
    grip.append(icon("grip"));
    makeSortable(row, prefsDraft, i, renderFolderPrefs, box);
    const show = el("input");
    show.type = "checkbox";
    show.checked = !p.hidden;
    show.title = "Show in the sidebar";
    show.addEventListener("change", () => {
      p.hidden = !show.checked;
      row.classList.toggle("hidden-folder", p.hidden);
    });
    const move = el("input");
    move.type = "checkbox";
    move.checked = !p.hide_in_move;
    move.title = "Offer in the Move to… lists";
    move.disabled = f?.selectable === false || folderKind(p.name) === "drafts"; // never offered
    move.addEventListener("change", () => {
      p.hide_in_move = !move.checked;
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
    row.append(grip, show, move, color, label, path);
    box.append(row);
  });
}

$("move-like-sidebar").addEventListener("click", () => {
  for (const p of prefsDraft) p.hide_in_move = p.hidden;
  renderFolderPrefs();
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
  checkSignatureImages();
}

// One editor for the signatures of all mailboxes: the main account and each
// extra sender (objects with `signature` and `signature_html`).
let mainSignature = { signature: "", signature_html: "" };
let signatureOwner = null; // whose signature is in the editor

/// Keeps the editor's signature in its owner, then shows `owner`'s (null = just keep).
/// `keep` false drops the editor content (the owner is gone or the dialog reopens).
function editSignatureOf(owner, keep = true) {
  if (keep && signatureOwner) {
    const { text, html } = readSignatureEditor();
    Object.assign(signatureOwner, { signature: text, signature_html: html });
  }
  if (!owner) return;
  signatureOwner = owner;
  loadSignatureEditor(owner.signature, owner.signature_html);
  renderSignatureOwners();
}

function renderSignatureOwners() {
  const box = $("sig-mailboxes");
  box.replaceChildren();
  for (const owner of [mainSignature, ...sendersDraft]) {
    const email = owner === mainSignature ? state.email : owner.email.trim() || "New sender";
    const b = el("button", "", email);
    b.type = "button";
    b.setAttribute("aria-pressed", String(owner === signatureOwner));
    if (owner !== mainSignature && !owner.signature) b.title = "No signature of its own: the main one is used";
    b.addEventListener("click", () => editSignatureOf(owner));
    box.append(b);
  }
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
sigEditor.addEventListener("paste", pasteClean);

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
  if (RCPT_FIELDS.includes(input.id)) {
    input.value = "";
    addRecipients(input.id, [{ name: c.name, email: c.email }]);
    return hideSuggestions();
  }
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
    } else if ((ev.key === "Enter" && !ev.metaKey && !ev.ctrlKey) || ev.key === "Tab") {
      ev.preventDefault();
      pickSuggestion(suggest.active);
    } else if (ev.key === "Escape") {
      ev.stopPropagation();
      hideSuggestions();
    }
  });
}

// ---------- recipients as chips ----------

const RCPT_FIELDS = ["compose-to", "compose-cc", "compose-bcc"];
compose.rcpt = { "compose-to": [], "compose-cc": [], "compose-bcc": [] };
let chipDrag = null; // { from, items } while a chip is being dragged

function validAddress(email) {
  return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email);
}

const EMAIL_IN_TEXT = /[^\s<>()[\]{},;:"'|@]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/// The addresses found in any text (pasted lists, signatures, "Name <a@b.c>",
/// "Rossi, Mario <m@x.it>", "a@b.c (Anna)"...), each with the name written
/// next to it. Text without "@" is split at commas and semicolons instead.
function parseAddresses(text) {
  const found = [...(text || "").matchAll(EMAIL_IN_TEXT)];
  if (!found.length) return splitAddresses(text);
  let from = 0;
  return found.map((m, i) => {
    const end = m.index + m[0].length;
    const next = found[i + 1]?.index ?? text.length;
    // The name is on the same line before the address: the whole segment when
    // the address is in <...> (names may contain commas), else after the last separator.
    let name = text.slice(from, m.index).split(/[\r\n]/).pop();
    if (text[m.index - 1] !== "<") name = name.split(/[,;|]/).pop();
    name = name.replace(/mailto:?\s*$/i, "").replace(/^[\s>,;:|-]+|[\s<(,;:|-]+$/g, "").replace(/^(["'])(.*)\1$/, "$2").replace(/\s+/g, " ").trim();
    from = end;
    // ...or in brackets right after it: "a@b.c (Anna)".
    const after = text.slice(end, next).match(/^\s*>?\s*\(([^()@]{1,80})\)/);
    if (!name && after) {
      name = after[1].trim();
      from = end + after[0].length;
    }
    // Not a name: too long, another address, or a phone number nearby.
    return { name: name.length > 80 || name.includes("@") || /\d.*\d.*\d/.test(name) ? "" : name, email: m[0] };
  });
}

/// "Name <a@b.c>, d@e.f; \"Doe, John\" <j@x.y>" -> [{ name, email }]
function splitAddresses(text) {
  const parts = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  for (const ch of text || "") {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if ((ch === "," || ch === ";") && !quoted && !angle) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(.*?)<([^>]*)>\s*$/);
      const name = m ? m[1].trim().replace(/^"(.*)"$/, "$1").trim() : "";
      const email = (m ? m[2] : p).trim();
      return { name, email };
    });
}

/// One address as the SMTP side expects it (no commas or quotes in names).
function formatAddress({ name, email }) {
  const clean = (name || "").replace(/[,;"<>]+/g, " ").replace(/\s+/g, " ").trim();
  return clean && clean.toLowerCase() !== email.toLowerCase() ? `${clean} <${email}>` : email;
}

/// The chips plus whatever is still being typed, as an address list.
function recipientValue(id) {
  return [...compose.rcpt[id], ...parseAddresses($(id).value)].map(formatAddress).join(", ");
}

function setRecipients(id, text) {
  compose.rcpt[id] = [];
  $(id).value = "";
  addRecipients(id, parseAddresses(text));
}

/// Adds addresses (skipping ones already in the field), finding a name for bare addresses.
function addRecipients(id, items) {
  const list = compose.rcpt[id];
  const pool = items.some((r) => !r.name) ? addressPool() : [];
  for (const r of items) {
    if (list.some((x) => x.email.toLowerCase() === r.email.toLowerCase())) continue;
    const name = r.name || pool.find((p) => p.email.toLowerCase() === r.email.toLowerCase())?.name || "";
    list.push({ name, email: r.email });
  }
  renderChips(id);
}

/// Turns typed text into chips: what comes before a comma, or everything when `all`.
function commitRecipients(id, all = false) {
  const input = $(id);
  const text = input.value;
  const cut = all ? text.length : Math.max(text.lastIndexOf(","), text.lastIndexOf(";"));
  if (cut < 0 || !text.slice(0, cut).trim()) return;
  input.value = text.slice(cut + (all ? 0 : 1)).trimStart();
  addRecipients(id, parseAddresses(text.slice(0, cut)));
}

function clearChipSelection(except = null) {
  for (const c of document.querySelectorAll(".chip.selected")) if (c !== except) c.classList.remove("selected");
}

function renderChips(id) {
  const input = $(id);
  const box = input.parentElement;
  for (const c of box.querySelectorAll(".chip")) c.remove();
  input.dataset.placeholder ??= input.placeholder;
  input.placeholder = compose.rcpt[id].length ? "" : input.dataset.placeholder;
  compose.rcpt[id].forEach((r) => {
    const chip = el("span", "chip" + (validAddress(r.email) ? "" : " invalid"));
    chip.draggable = true;
    chip.title = formatAddress(r);
    chip._rcpt = r;
    chip.append(el("span", "chip-name", r.name || r.email));
    if (r.name) chip.append(el("span", "chip-email", r.email));
    const x = el("button", "chip-x", "×");
    x.type = "button";
    x.title = "Remove";
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeRecipients(id, [r]);
    });
    chip.append(x);
    // Click selects (⌘/Ctrl-click adds to the selection; ⌘C then copies),
    // double-click edits the name and the address.
    chip.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!(ev.metaKey || ev.ctrlKey || ev.shiftKey)) clearChipSelection(chip);
      chip.classList.toggle("selected", ev.metaKey || ev.ctrlKey || ev.shiftKey ? !chip.classList.contains("selected") : true);
      input.focus();
    });
    // Right-click: the contact menu, with editing and removing the recipient.
    chip.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openContactMenu(ev.clientX, ev.clientY, r, [
        menuButton("compose", "Edit name and address", () => {
          closeConvMenu();
          editChip(id, chip, r);
        }),
        menuButton("close", "Remove", () => {
          closeConvMenu();
          removeRecipients(id, [r]);
        }),
      ]);
    });
    chip.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      editChip(id, chip, r);
    });
    chip.addEventListener("dragstart", (ev) => {
      if (!chip.classList.contains("selected")) {
        clearChipSelection();
        chip.classList.add("selected");
      }
      const items = [...document.querySelectorAll("#compose-form .chip.selected")].map((c) => ({
        from: c.parentElement.querySelector("input").id,
        r: c._rcpt,
      }));
      chipDrag = { items };
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", items.map((i) => formatAddress(i.r)).join(", "));
      requestAnimationFrame(() => chip.classList.add("dragging"));
    });
    chip.addEventListener("dragend", () => {
      chip.classList.remove("dragging");
      chipDrag = null;
      for (const b of document.querySelectorAll(".rcpt.drop-target")) b.classList.remove("drop-target");
    });
    box.insertBefore(chip, input);
  });
}

/// Edits a recipient in place, as "Name <address>": typing a name before a
/// bare address is enough to give it one. Enter or a click elsewhere keeps
/// the change, Esc drops it; an emptied field removes the recipient.
function editChip(id, chip, r) {
  const field = el("input", "chip-edit");
  field.value = r.name ? `${r.name} <${r.email}>` : r.email;
  field.spellcheck = false;
  field.autocomplete = "off";
  const fit = () => (field.size = Math.max(12, field.value.length + 2));
  fit();
  let finished = false;
  const done = (keep) => {
    if (finished) return;
    finished = true;
    field.remove();
    const list = compose.rcpt[id];
    const at = list.indexOf(r);
    if (keep && at >= 0) {
      const others = new Set(list.filter((x) => x !== r).map((x) => x.email.toLowerCase()));
      list.splice(at, 1, ...parseAddresses(field.value).filter((x) => x.email && !others.has(x.email.toLowerCase())));
    }
    renderChips(id);
  };
  field.addEventListener("input", fit);
  field.addEventListener("blur", () => done(true));
  field.addEventListener("mousedown", (ev) => ev.stopPropagation());
  field.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); // the composer's own shortcuts stay out of this field
    if (ev.key !== "Enter" && ev.key !== "Escape") return;
    ev.preventDefault();
    done(ev.key === "Enter");
    $(id).focus();
  });
  clearChipSelection();
  chip.replaceWith(field);
  field.focus();
  // Ready to type the name: before a bare address, or over the one there is.
  field.setSelectionRange(0, r.name ? r.name.length : 0);
}

/// The selected recipients as text for the clipboard ("Name <address>, …"),
/// unless some text is selected: then the usual copy is meant.
function selectedChipsText() {
  const chips = [...document.querySelectorAll("#compose-form .chip.selected")];
  const field = document.activeElement;
  const typing = field && typeof field.selectionStart === "number" && field.selectionStart !== field.selectionEnd;
  if (!chips.length || typing || String(window.getSelection() || "")) return null;
  return { chips, text: chips.map((c) => formatAddress(c._rcpt)).join(", ") };
}

/// Puts text on the clipboard: the modern way, else through a hidden field.
function copyText(text) {
  const byCommand = () => {
    const back = document.activeElement;
    const field = el("textarea");
    field.value = text;
    field.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    back?.focus();
    return ok ? Promise.resolve() : Promise.reject(new Error("copy refused"));
  };
  return navigator.clipboard?.writeText ? navigator.clipboard.writeText(text).catch(byCommand) : byCommand();
}

function removeSelectedChips(chips) {
  for (const id of RCPT_FIELDS) {
    const gone = chips.filter((c) => c.parentElement === $(id).parentElement).map((c) => c._rcpt);
    if (gone.length) removeRecipients(id, gone);
  }
}

// ⌘C / ⌘X on selected recipients. Both the key and the Edit menu's command
// are answered, since the system may send only one of the two.
for (const kind of ["copy", "cut"]) {
  document.addEventListener(kind, (ev) => {
    const sel = selectedChipsText();
    if (!sel) return;
    ev.preventDefault();
    ev.clipboardData.setData("text/plain", sel.text);
    toast(sel.chips.length > 1 ? `${sel.chips.length} addresses copied` : "Address copied", "info", null, 2);
    if (kind === "cut") removeSelectedChips(sel.chips);
  });
}
$("compose-form").addEventListener("keydown", (ev) => {
  const key = ev.key.toLowerCase();
  if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || (key !== "c" && key !== "x")) return;
  const sel = selectedChipsText();
  if (!sel) return;
  copyText(sel.text).then(() => {
    toast(sel.chips.length > 1 ? `${sel.chips.length} addresses copied` : "Address copied", "info", null, 2);
    if (key === "x") removeSelectedChips(sel.chips.filter((c) => c.isConnected));
  }, () => {});
});

function removeRecipients(id, items) {
  compose.rcpt[id] = compose.rcpt[id].filter((r) => !items.includes(r));
  renderChips(id);
}

for (const id of RCPT_FIELDS) {
  const input = $(id);
  const box = input.parentElement;
  box.addEventListener("mousedown", (ev) => {
    if (ev.target === box) {
      ev.preventDefault();
      clearChipSelection();
      input.focus();
    }
  });
  input.addEventListener("input", () => {
    clearChipSelection();
    if (/[,;]/.test(input.value)) commitRecipients(id);
  });
  // A pasted list becomes chips at once (a text field would turn its line breaks into spaces).
  input.addEventListener("paste", (ev) => {
    const text = ev.clipboardData?.getData("text/plain") || "";
    if (!text.includes("@")) return;
    ev.preventDefault();
    const typed = input.value;
    input.value = "";
    hideSuggestions();
    addRecipients(id, parseAddresses(typed + "\n" + text));
  });
  input.addEventListener("blur", () => setTimeout(() => {
    if (document.activeElement !== input) commitRecipients(id, true);
  }, 150));
  input.addEventListener("keydown", (ev) => {
    const suggesting = !$("suggestions").hidden && suggest.input === input;
    if (suggesting) return;
    if (ev.key === "Enter" && !ev.metaKey && !ev.ctrlKey && input.value.trim()) {
      ev.preventDefault();
      commitRecipients(id, true);
    } else if ((ev.key === "Backspace" || ev.key === "Delete") && !input.value) {
      // Delete selected chips; otherwise Backspace selects the last one first.
      const selected = [...box.querySelectorAll(".chip.selected")].map((c) => c._rcpt);
      if (selected.length) {
        ev.preventDefault();
        removeRecipients(id, selected);
      } else if (ev.key === "Backspace" && compose.rcpt[id].length) {
        ev.preventDefault();
        box.querySelectorAll(".chip")[compose.rcpt[id].length - 1].classList.add("selected");
      }
    }
  });
  box.addEventListener("dragover", (ev) => {
    if (!chipDrag) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    box.classList.add("drop-target");
  });
  box.addEventListener("dragleave", (ev) => {
    if (!box.contains(ev.relatedTarget)) box.classList.remove("drop-target");
  });
  box.addEventListener("drop", (ev) => {
    if (!chipDrag) return;
    ev.preventDefault();
    box.classList.remove("drop-target");
    const moving = chipDrag.items.filter((i) => i.from !== id);
    for (const from of new Set(moving.map((i) => i.from))) {
      removeRecipients(from, moving.filter((i) => i.from === from).map((i) => i.r));
    }
    addRecipients(id, moving.map((i) => i.r));
    chipDrag = null;
    input.focus();
  });
}
// Clicking elsewhere in the composer clears the chip selection.
$("compose-form").addEventListener("mousedown", (ev) => {
  if (!ev.target.closest?.(".chip")) clearChipSelection();
});

start();
