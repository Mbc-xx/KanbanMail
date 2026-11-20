import { test } from "node:test";
import assert from "node:assert/strict";
import { openApp, card } from "./harness.mjs";

test("the board opens with its columns and cards", async () => {
  const app = await openApp({ data: { INBOX: [card(1), card(2, { seen: true })] } });
  assert.deepEqual(app.run("state.columns.map((c) => c.folder)"), ["INBOX", "INBOX.Todo", "INBOX.Waiting", "INBOX.Done"]);
  assert.equal(app.run("state.cards.INBOX.length"), 2);
  assert.deepEqual(app.shown("INBOX"), { 1: true, 2: false });
});
