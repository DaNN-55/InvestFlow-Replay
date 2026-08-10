import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import request from "supertest";

import { createApp } from "./app.js";

describe("standalone stock search", () => {
  let root;
  let app;
  let engineServer;
  let engineUrl;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "investflow-stock-search-"));
    engineServer = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      assert.equal(url.pathname, "/internal/instruments/search");
      assert.equal(url.searchParams.get("q"), "600267");
      assert.equal(url.searchParams.get("limit"), "8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        items: [{ orderBookId: "600267.XSHG", name: "海正药业" }],
      }));
    });
    await new Promise((resolve) => engineServer.listen(0, "127.0.0.1", resolve));
    const { port } = engineServer.address();
    engineUrl = `http://127.0.0.1:${port}`;
    app = createApp({
      engineUrl,
      dbPath: join(root, "workbench.sqlite"),
      rankingDbPath: join(root, "mainline-rankings.sqlite"),
      storageRoot: join(root, "storage"),
      workspaceRoot: root,
      tradeRecordsRoot: join(root, "trade-records"),
    });
  });

  after(async () => {
    app.dispose();
    await new Promise((resolve, reject) => engineServer.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it("uses the replay engine catalog and returns the trade-record identity shape", async () => {
    const response = await request(app)
      .get("/api/quant/decision/stocks/search")
      .query({ query: "600267" });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      query: "600267",
      items: [{ code: "600267", name: "海正药业" }],
    });
  });
});
