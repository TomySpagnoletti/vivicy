import { strict as assert } from "node:assert";
import { test } from "node:test";

import { FORMULA_VERSION } from "../src/index.js";

// Placeholder gate test: proves `npm test` (node --test) is wired and green on
// the scaffold. The dev-loop agents replace this with real behavior tests as
// they implement each issue.
test("formula scaffold is importable", () => {
  assert.equal(typeof FORMULA_VERSION, "string");
  assert.ok(FORMULA_VERSION.length > 0);
});
