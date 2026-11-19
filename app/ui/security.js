// The bell in the top bar: known vulnerabilities in the components built into
// this version of Pigeonhole, checked on OSV.dev once a day (see security.rs).
// The number on the bell counts the advisories not yet seen; the bell turns red
// while a vulnerability is open, until a new version without it is installed.

const KIND_LABEL = { unmaintained: "No longer maintained", unsound: "Unsound code", notice: "Notice" };
let securityView = null;
let securityChecking = false;

function showSecurityBell(view) {
  securityView = view;
  const vulns = view.advisories.filter((a) => a.kind === "vulnerability");
  const bell = $("open-security");
  bell.classList.toggle("alert", vulns.length > 0);
  $("security-count").textContent = view.unseen ? String(view.unseen) : "";
  bell.title = vulns.length
    ? `Security: ${vulns.length} ${vulns.length === 1 ? "vulnerability" : "vulnerabilities"} to fix with an update`
    : view.checked_at
      ? `Security: no known vulnerabilities${view.advisories.length ? ` · ${view.advisories.length} to keep an eye on` : ""}`
      : "Security of the app's components";
  if (!$("security").hidden) renderSecurity();
}

function when(seconds) {
  const d = new Date(seconds * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return today ? `today at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function code(text) {
  return el("code", "", text);
}

function linkButton(label, url) {
  const b = el("button", "link-btn", label);
  b.type = "button";
  b.title = url;
  b.addEventListener("click", () => invoke("open_url", { url }).catch((e) => toast("Could not open the link: " + e)));
  return b;
}

/// What to do about an advisory, in a few words.
function securityAdvice(a) {
  const p = el("p", "security-advice");
  if (a.kind === "vulnerability" && a.upgrade_to) {
    p.append("Fixed in ", code(a.upgrade_to), ": run ", code(`cargo update -p ${a.package} --precise ${a.upgrade_to}`), ", then build a new version of Pigeonhole.");
    if (a.via) p.append(" It comes through ", code(a.via), ": if the update is refused, update that one first.");
  } else if (a.kind === "vulnerability") {
    p.append("No fixed version yet: follow the advisory, and consider doing without ", code(a.via || a.package), " if it stays open.");
  } else if (a.kind === "unmaintained") {
    p.append("No more fixes will come for it. Nothing to do now", a.via ? ", it comes with " : ".", ...(a.via ? [code(a.via), ": a newer version of that one may drop it."] : []));
  } else {
    p.append("Read the advisory to see whether the way Pigeonhole uses it is affected.");
  }
  return p;
}

function securityItem(a, isNew) {
  const item = el("article", "security-item " + (a.kind === "vulnerability" ? "vuln" : "notice"));
  const head = el("div", "security-item-head");
  head.append(el("strong", "", a.package), el("span", "muted", a.version));
  if (a.kind !== "vulnerability") head.append(el("span", "security-tag", KIND_LABEL[a.kind] || a.kind));
  if (isNew) head.append(el("span", "security-tag new", "New"));
  item.append(head, el("p", "security-summary-line", a.summary || a.id));
  const ids = el("div", "security-ids small muted");
  const cve = a.aliases.filter((x) => x.startsWith("CVE-"));
  ids.append(linkButton(a.id, a.url));
  for (const x of [...cve, ...a.aliases.filter((x) => x.startsWith("GHSA-"))]) ids.append(linkButton(x, `https://osv.dev/vulnerability/${x}`));
  if (a.published) ids.append(el("span", "", "published " + a.published));
  item.append(ids, securityAdvice(a));
  return item;
}

function renderSecurity() {
  const v = securityView;
  if (!v) return;
  $("security-auto").checked = v.auto;
  const summary = $("security-summary");
  summary.replaceChildren();
  if (securityChecking) summary.textContent = "Checking the components on OSV.dev…";
  else if (v.checked_at) summary.textContent = `Pigeonhole ${v.app_version} · ${v.components} components checked ${when(v.checked_at)} against OSV.dev (RustSec, GitHub advisories, CVE).`;
  else summary.textContent = "Not checked yet.";
  if (v.error && !securityChecking) summary.append(el("span", "security-error", ` The last check failed: ${v.error}`));
  $("security-check").disabled = securityChecking;

  const list = $("security-list");
  list.replaceChildren();
  const seen = new Set(v.seen);
  const isNew = (a) => !seen.has(`${a.id} ${a.package} ${a.version}`);
  const vulns = v.advisories.filter((a) => a.kind === "vulnerability");
  const notices = v.advisories.filter((a) => a.kind !== "vulnerability");
  if (v.checked_at && !vulns.length) {
    const ok = el("div", "security-ok");
    ok.append(el("strong", "", "No known vulnerabilities"), el("span", "muted", ` in the ${v.components} components of this version.`));
    list.append(ok);
  }
  if (vulns.length) {
    list.append(el("h3", "settings-sub", `To fix (${vulns.length})`));
    for (const a of vulns) list.append(securityItem(a, isNew(a)));
  }
  if (notices.length) {
    list.append(el("h3", "settings-sub", `To keep an eye on (${notices.length})`));
    for (const a of notices) list.append(securityItem(a, isNew(a)));
  }
}

async function openSecurity() {
  $("security").hidden = false;
  renderSecurity();
  if (!securityView?.checked_at) await runSecurityCheck(true);
}

/// Everything shown in the panel is now seen: the "New" tags and the number on the bell go away.
function closeSecurity() {
  $("security").hidden = true;
  invoke("security_seen").then(showSecurityBell).catch(() => {});
}

/// `force`: check now; otherwise only when the daily check is due.
async function runSecurityCheck(force) {
  if (securityChecking) return;
  securityChecking = force;
  if (force) renderSecurity();
  try {
    const view = await invoke("security_check", { force });
    securityChecking = false;
    showSecurityBell(view);
    if (force && !view.error) toast(view.advisories.some((a) => a.kind === "vulnerability") ? "Check done: there are vulnerabilities to fix" : "Check done: no known vulnerabilities");
    if (view.new.length && state.notify !== "off") {
      const a = view.new[0];
      const more = view.new.length > 1 ? ` (+${view.new.length - 1} more)` : "";
      const fix = a.upgrade_to ? ` Update to ${a.upgrade_to}.` : "";
      showNotification(`Vulnerability in ${a.package} ${a.version}${more}`, `${a.summary}.${fix}`, { security: true }).catch(() => {});
    }
  } catch (e) {
    securityChecking = false;
    if (force) toast("Security check failed: " + e);
    renderSecurity();
  }
}

$("open-security").addEventListener("click", openSecurity);
$("security-close").addEventListener("click", closeSecurity);
$("security").addEventListener("click", (ev) => {
  if (ev.target === $("security")) closeSecurity();
});
$("security-check").addEventListener("click", () => runSecurityCheck(true));
$("security-auto").addEventListener("change", (ev) => {
  invoke("security_auto", { auto: ev.target.checked })
    .then((view) => {
      showSecurityBell(view);
      if (view.auto) runSecurityCheck(false);
    })
    .catch((e) => toast(String(e)));
});
listen("notification-clicked", (ev) => {
  try {
    if (JSON.parse(ev.payload)?.security) openSecurity();
  } catch (_) {}
});

// The last result at once, then the daily check a little after start and every hour
// (it goes on the network only when a day has passed or the app was updated).
invoke("security_status").then(showSecurityBell).catch(() => {});
setTimeout(() => runSecurityCheck(false), 15000);
setInterval(() => runSecurityCheck(false), 3600 * 1000);
