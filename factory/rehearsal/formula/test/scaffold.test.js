import { strict as assert } from "node:assert";
import { test } from "node:test";

import { FORMULA_VERSION } from "../src/index.js";

test("formula scaffold is importable", () => {
  assert.equal(typeof FORMULA_VERSION, "string");
  assert.ok(FORMULA_VERSION.length > 0);
});
