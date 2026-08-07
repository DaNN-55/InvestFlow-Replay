import assert from "node:assert/strict";
import test from "node:test";

import { isStandalonePathAllowed } from "./standalone-access.js";

test("standalone access allows readonly stock identity search", () => {
  assert.equal(isStandalonePathAllowed("/api/quant/decision/stocks/search"), true);
  assert.equal(isStandalonePathAllowed("/api/quant/decision/stocks/600000/evaluation"), false);
});
