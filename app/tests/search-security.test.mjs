// The search box's language and the security bell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.mjs";

test("the search box understands from:, subject:, quotes and dates", async () => {
  const app = await openApp();
  const q = (text) => app.get(`parseQuery(${JSON.stringify(text)})`);
  assert.deepEqual(q(`from:"Rachel Green" subject:budget "kick off" q3`), {
    words: ["kick off", "q3"], from: ["Rachel Green"], to: [], subject: ["budget"], since: null, before: null,
  });
  assert.deepEqual(q("date:2026-10"), { words: [], from: [], to: [], subject: [], since: "2026-10-01", before: "2026-11-01" });
  assert.deepEqual(q("after:2026-12-31 before:2027").since, "2026-12-31");
  assert.deepEqual(q("after:2026-12-31 before:2027").before, "2028-01-01", "both ends included: all of 2027");
  assert.deepEqual(q("date:5/10/2026"), { words: [], from: [], to: [], subject: [], since: "2026-10-05", before: "2026-10-06" });
  assert.deepEqual(q("after:soon").words, ["after:soon"], "not a date: searched as a word");
});

const advisory = (id, kind) => ({ id, aliases: [], package: "x", version: "1.0.0", via: "", summary: "s", kind, fixed: [], upgrade_to: null, url: "", published: "2026-11-01" });

test("the bell turns red only for vulnerabilities and counts what is new", async () => {
  const app = await openApp();
  const show = (view) => app.run(`showSecurityBell(${JSON.stringify({ checked_at: 1, components: 300, error: null, seen: [], auto: true, ...view })})`);
  const bell = app.$("open-security");

  show({ advisories: [advisory("RUSTSEC-1", "unmaintained")], unseen: 1 });
  assert.equal(bell.classList.contains("alert"), false);
  assert.equal(app.$("security-count").textContent, "1");
  assert.match(bell.title, /no known vulnerabilities · 1 to keep an eye on/);

  show({ advisories: [advisory("RUSTSEC-2", "vulnerability"), advisory("RUSTSEC-1", "unmaintained")], unseen: 0 });
  assert.equal(bell.classList.contains("alert"), true);
  assert.equal(app.$("security-count").textContent, "");
  assert.match(bell.title, /1 vulnerability to fix/);
});
