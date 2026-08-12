import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import request from "supertest";

import { createApp } from "./app.js";

describe("standalone stock search", () => {
  let app;
  let engineServer;
  let root;

  before(async () => {
    engineServer = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      assert.equal(req.method, "GET");
      assert.equal(url.pathname, "/internal/instruments/search");
      assert.equal(url.searchParams.get("limit"), "8");
      const query = url.searchParams.get("q");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        items: query === "002329" || query === "皇氏"
          ? [{ orderBookId: "002329.XSHE", name: "皇氏集团" }]
          : [],
      }));
    });
    await new Promise((resolve) => engineServer.listen(0, "127.0.0.1", resolve));
    const address = engineServer.address();
    root = mkdtempSync(join(tmpdir(), "investflow-standalone-stock-search-"));
    app = createApp({
      dbPath: join(root, "replay.sqlite"),
      tradeRecordsRoot: join(root, "trade-records"),
      engineUrl: `http://127.0.0.1:${address.port}`,
    });
  });

  after(async () => {
    app.dispose();
    await new Promise((resolve, reject) => engineServer.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  for (const query of ["002329", "皇氏"]) {
    it(`searches the local market index for ${query}`, async () => {
      const response = await request(app)
        .get("/api/quant/decision/stocks/search")
        .query({ query });

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        query,
        items: [{ code: "002329", name: "皇氏集团" }],
      });
    });
  }
});
