import { strict as assert } from "node:assert";
import { test } from "node:test";

import { POCKET_LEDGER_VERSION } from "../src/index.js";

test("pocket-ledger scaffold is importable", () => {
  assert.equal(typeof POCKET_LEDGER_VERSION, "string");
  assert.ok(POCKET_LEDGER_VERSION.length > 0);
});
