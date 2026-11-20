// Read and unread: every place that holds an email changes together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openApp, card } from "./harness.mjs";

const tick = () => new Promise((r) => setTimeout(r, 20));

// An email sent to two addresses of the same mailbox arrives twice, with the
// same Message-ID under two UIDs (fixed in 2.15.1).
const twoCopies = () => ({
  INBOX: [
    card(1, { message_id: "<Same@Example.com>" }),
    card(2, { message_id: "same@example.com" }),
    card(3),
  ],
});

test("reading one copy of an email reads the other copies too", async () => {
  const app = await openApp({ data: twoCopies() });
  await app.run(`setSeen("INBOX", state.cards.INBOX.find((c) => c.uid === 1), true)`);
  await tick();
  assert.deepEqual(app.get(`state.cards.INBOX.map((c) => [c.uid, c.seen])`), [[1, true], [2, true], [3, false]]);
  assert.deepEqual(app.called("set_seen"), [{ folder: "INBOX", uid: 1, seen: true }]);
  assert.deepEqual(app.called("set_seen_many"), [{ folder: "INBOX", uids: [2], seen: true }]);
  assert.deepEqual(app.data.INBOX.map((c) => c.seen), [true, true, false], "the server has both copies read");
  assert.deepEqual(app.shown("INBOX"), { 1: false, 2: false, 3: true });
});

test("marking unread brings every copy back", async () => {
  const data = twoCopies();
  for (const c of data.INBOX) c.seen = true;
  const app = await openApp({ data });
  await app.run(`setSeen("INBOX", state.cards.INBOX.find((c) => c.uid === 2), false)`);
  await tick();
  assert.deepEqual(app.get(`state.cards.INBOX.map((c) => c.seen)`), [false, false, true]);
});

test("marking a selection reads the copies outside it, once each", async () => {
  const app = await openApp({ data: twoCopies() });
  await app.run(`markMany([{ folder: "INBOX", card: state.cards.INBOX[0] }, { folder: "INBOX", card: state.cards.INBOX[2] }], true)`);
  await tick();
  assert.deepEqual(app.get(`state.cards.INBOX.map((c) => c.seen)`), [true, true, true]);
  assert.deepEqual(app.called("set_seen_many"), [{ folder: "INBOX", uids: [1, 3, 2], seen: true }]);
});

test("Mark all read reads the whole column and its count goes away", async () => {
  const app = await openApp({ data: twoCopies() });
  const unread = () => app.run(`columnEl("INBOX").querySelector(".unread").textContent`);
  assert.equal(unread(), "3 unread");
  app.run(`markAllRead("INBOX")`);
  await tick();
  assert.equal(unread(), "");
  assert.deepEqual(app.data.INBOX.map((c) => c.seen), [true, true, true]);
});

test("a failed change on the server is reported and the column reloaded", async () => {
  const app = await openApp({
    data: twoCopies(),
    handlers: { set_seen: () => Promise.reject("offline: the server cannot be reached right now") },
  });
  const loads = app.called("load_column").length;
  await app.run(`setSeen("INBOX", state.cards.INBOX[2], true)`);
  await tick();
  assert.match(app.$("toast").textContent, /Read state not changed/);
  assert.ok(app.called("load_column").length > loads, "the column is loaded again");
  assert.equal(app.get(`state.cards.INBOX[2].seen`), false, "back to what the server has");
});
