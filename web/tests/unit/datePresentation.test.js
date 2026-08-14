import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDisplayDate, toDateInput } from "../../src/utils/datePresentation.js";

describe("date presentation", () => {
  it("renders supported timestamps as YYYY/MM/DD without timezone conversion", () => {
    assert.equal(formatDisplayDate("2026-08-13T00:30:00.000Z"), "2026/08/13");
    assert.equal(formatDisplayDate("2026/8/7"), "2026/08/07");
    assert.equal(formatDisplayDate("2026-08-13"), "2026/08/13");
    assert.equal(formatDisplayDate("20260710"), "2026/07/10");
  });

  it("normalizes supported historical dates for native date inputs", () => {
    assert.equal(toDateInput("2026/8/7"), "2026-08-07");
    assert.equal(toDateInput("2026-08-13T09:45:30"), "2026-08-13");
  });
});
