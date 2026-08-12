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
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && url.pathname === "/internal/instruments/search") {
        const query = url.searchParams.get("q");
        res.end(JSON.stringify({
          items: query === "002329" || query === "皇氏"
            ? [{ orderBookId: "002329.XSHE", name: "皇氏集团" }]
            : [],
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "not found" }));
    });
    await new Promise((resolve) => engineServer.listen(0, "127.0.0.1", resolve));
    const address = engineServer.address();
    root = mkdtempSync(join(tmpdir(), "investflow-standalone-stock-search-"));
    app = createApp({
      dbPath: join(root, "workbench.sqlite"),
      rankingDbPath: join(root, "rankings.sqlite"),
      storageRoot: join(root, "storage"),
      workspaceRoot: root,
      tradeRecordsRoot: join(root, "trade-records"),
      engineUrl: `http://127.0.0.1:${address.port}`,
    });
  });

  after(async () => {
    app.dispose();
    await new Promise((resolve) => engineServer.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  it("searches the local market index without the external decision service", async () => {
    const response = await request(app)
      .get("/api/quant/decision/stocks/search?query=002329");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      items: [{ code: "002329", name: "皇氏集团" }],
    });
  });

  it("keeps stock-name search on the same local index", async () => {
    const response = await request(app)
      .get("/api/quant/decision/stocks/search?query=%E7%9A%87%E6%B0%8F");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      items: [{ code: "002329", name: "皇氏集团" }],
    });
  });
});
