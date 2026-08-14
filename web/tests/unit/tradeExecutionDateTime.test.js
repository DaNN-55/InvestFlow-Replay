import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toDateInput, toExecutionEventDate } from "../../src/utils/tradeExecutionDateTime.js";

describe("trade execution date time", () => {
  it("converts stored timestamps for the native date picker", () => {
    assert.equal(toDateInput("2026-08-06 09:45"), "2026-08-06");
    assert.equal(toDateInput("2026-08-06T09:45:30"), "2026-08-06");
  });

  it("submits only the selected date", () => {
    assert.equal(toExecutionEventDate("2026-08-06"), "2026-08-06");
    assert.equal(toExecutionEventDate("2026-08-06T09:45:30"), "2026-08-06");
  });

  it("clears values that cannot be represented by the picker", () => {
    assert.equal(toDateInput("2026/08/06 09:45"), "");
    assert.equal(toExecutionEventDate("not-a-date"), "");
  });
});
