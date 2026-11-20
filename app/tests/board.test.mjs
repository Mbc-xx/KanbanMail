// The board's own logic: conversations, days in Todo, answers in Waiting,
// rules and what counts as important.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openApp, card } from "./harness.mjs";

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const tick = () => new Promise((r) => setTimeout(r, 120));
const columnText = (app, folder) => app.run(`columnEl(${JSON.stringify(folder)}).textContent`);

test("emails group into conversations through their references", async () => {
  const app = await openApp();
  const groups = app.get(`groupByThread([
    { uid: 1, message_id: "<A@x>", thread_refs: [], date: 100 },
    { uid: 2, message_id: "<b@x>", thread_refs: ["a@x"], date: 300 },
    { uid: 3, message_id: "<c@x>", thread_refs: ["<B@X>"], date: 200 },
    { uid: 4, message_id: "<d@x>", thread_refs: [], date: 50, flagged: true },
    { uid: 5, message_id: "<e@x>", thread_refs: [], date: 400 },
  ], "INBOX").map((g) => g.members.map((m) => m.card.uid))`);
  // Pinned conversations first, then the newest; newest email first in each.
  assert.deepEqual(groups, [[4], [5], [2, 3, 1]]);
});

test("a conversation in Todo counts from the newest email of others, not from my reply", async () => {
  const app = await openApp();
  // In the column for 10 days; Anna wrote again 3 days ago, I answered yesterday.
  const days = app.run(`daysInColumn(
    { since: { "a@x": ${now - 10 * DAY}, "b@x": ${now - 3 * DAY}, "c@x": ${now - DAY} }, now: ${now} },
    [
      { folder: "INBOX.Todo", card: { message_id: "<c@x>", from_address: "me@example.com", date: ${now - DAY} } },
      { folder: "INBOX.Todo", card: { message_id: "<b@x>", from_address: "anna@example.com", date: ${now - 3 * DAY} } },
      { folder: "INBOX.Todo", card: { message_id: "<a@x>", from_address: "anna@example.com", date: ${now - 10 * DAY} } },
    ],
    new Set(["me@example.com"]),
  )`);
  assert.equal(days, 3);
});

test("a late email in Todo is tagged and counted in the column title", async () => {
  const app = await openApp({
    data: { "INBOX.Todo": [card(1, { date: now - 6 * DAY }), card(2, { date: now - 11 * DAY }), card(3, { date: now - DAY })] },
  });
  const text = columnText(app, "INBOX.Todo");
  assert.match(text, /2 late/);
  assert.match(text, /To do · 6 days/);
  assert.match(text, /To do · 11 days/);
  assert.equal(app.run(`columnEl("INBOX.Todo").querySelectorAll(".wait-tag.overdue").length`), 1, "twice the time is overdue");
});

const waiting = (extra = {}) => ({
  "INBOX.Waiting": [card(1, { from: "Me", from_address: "me@example.com", message_id: "<w1@x>", date: now - 9 * DAY })],
  ...extra,
});

test("an answer in the Inbox marks the email in Waiting as replied", async () => {
  const app = await openApp({
    data: waiting({ INBOX: [card(2, { from: "Marco Gialli", message_id: "<r1@x>", thread_refs: ["<w1@x>"], date: now - DAY })] }),
  });
  await tick();
  assert.match(columnText(app, "INBOX.Waiting"), /↩ Replied · Marco/);
  assert.equal(app.run("state.today.replied"), 1);
});

test("without an answer the email shows how long it has waited", async () => {
  const app = await openApp({ data: waiting() });
  await tick();
  assert.match(columnText(app, "INBOX.Waiting"), /Waiting 9 days/);
  assert.doesNotMatch(columnText(app, "INBOX.Waiting"), /Replied/);
});

test("a reminder I send after the answer starts the wait again", async () => {
  const app = await openApp({
    data: waiting({
      INBOX: [card(2, { message_id: "<r1@x>", thread_refs: ["<w1@x>"], date: now - 3 * DAY })],
      "INBOX.Sent": [card(3, { from_address: "me@example.com", message_id: "<s1@x>", thread_refs: ["<w1@x>", "<r1@x>"], date: now - DAY, seen: true })],
    }),
  });
  await app.until(() => app.called("load_column").some((a) => a.folder === "INBOX.Sent"), "the Sent folder");
  await tick();
  assert.doesNotMatch(columnText(app, "INBOX.Waiting"), /Replied|Waiting \d+ days/);
});

test("rules move matching Inbox emails, ignoring case and accents", async () => {
  const app = await openApp({
    settings: {
      rules: [
        { field: "from", contains: "societa", folder: "INBOX.News" },
        { field: "subject", contains: "invoice", folder: "INBOX" }, // never back to the Inbox
      ],
    },
    data: {
      INBOX: [
        card(1, { from: "Società Rossi", from_address: "info@rossi.example" }),
        card(2, { subject: "Your INVOICE" }),
        card(3),
      ],
    },
  });
  const moved = await app.run(`applyRules(state.cards.INBOX, { announce: false }).then((s) => [...s])`);
  assert.deepEqual([...moved], ["<m1@example.com>"]);
  assert.deepEqual(app.called("move_cards").map((a) => [a.from, a.to, a.uids]), [["INBOX", "INBOX.News", [1]]]);
  assert.deepEqual(app.data["INBOX.News"].map((c) => c.uid), [1]);
});

test("what counts as important", async () => {
  const app = await openApp({ settings: { important_block: [], important_allow: [] } });
  const important = (fields) => app.run(`importance(${JSON.stringify({ from_address: "", ...fields })}).important`);
  assert.equal(important({ from_address: "boss@example.com" }), true, "same domain as me");
  assert.equal(important({ from_address: "news@example.com", automated: true }), false, "automated");
  assert.equal(important({ from_address: "stranger@elsewhere.example" }), false, "never written to");
  app.run(`state.known.add("friend@elsewhere.example")`);
  assert.equal(important({ from_address: "friend@elsewhere.example" }), true, "written to before");
});
