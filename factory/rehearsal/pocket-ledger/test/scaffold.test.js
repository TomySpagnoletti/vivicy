import { strict as assert } from "node:assert";
import { test } from "node:test";

import { POCKET_LEDGER_VERSION } from "../src/index.js";

// Placeholder gate test: proves `npm test` (node --test) is wired and green on
// the scaffold. The dev-loop agents replace this with real behavior tests as
// they implement each issue.
test("pocket-ledger scaffold is importable", () => {
  assert.equal(typeof POCKET_LEDGER_VERSION, "string");
  assert.ok(POCKET_LEDGER_VERSION.length > 0);
});
