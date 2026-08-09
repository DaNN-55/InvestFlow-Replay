import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const confirmDialogUrl = new URL("../../src/components/ConfirmDialog.vue", import.meta.url);

test("confirmation dialogs render above ordinary modal overlays", async () => {
  const source = await readFile(confirmDialogUrl, "utf8");

  assert.match(source, /ql-z-\[200\]/u);
});
