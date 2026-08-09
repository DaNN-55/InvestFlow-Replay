import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";

import request from "supertest";

import { createApp } from "./app.js";
import { createDatabase } from "./db.js";

function privateScenario(gameLength = 20) {
  return {
    sourceDataVersion: "private-source-version",
    tsCode: "600000.SH",
    symbol: "600000",
    exchange: "SSE",
    name: "浦发银行",
    observationBars: 250,
    gameLength,
    bars: Array.from({ length: 250 + gameLength }, (_, index) => ({
      sequence: index + 1,
      tradeDate: `2024-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
      open: 10 + index,
      high: 11 + index,
      low: 9 + index,
      close: 10.5 + index,
      volume: 1000 + index,
      amount: 10000 + index,
      weekIndex: Math.floor(index / 5) + 1,
      monthIndex: Math.floor(index / 20) + 1,
    })),
  };
}

function assertLightweight(payload) {
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("snapshot_json"), false);
  assert.equal(serialized.includes('"snapshot"'), false);
  assert.equal(serialized.includes('"bars"'), false);
  assert.equal(serialized.includes("600000.SH"), false);
  assert.equal(serialized.includes("浦发银行"), false);
}

function blindReview(overrides = {}) {
  return {
    strategyName: "旧版自由文本战法",
    thesis: "价格突破整理区间，量能同步放大，预期后续延续上行。",
    tradePlan: "突破后分批买入，次日确认强度，弱于预期则停止加仓。",
    riskPlan: "跌回整理区间立即止损，单次风险不超过计划范围。",
    confidence: 4,
    trendView: "bullish",
    outlook: "bullish",
    reasonTags: ["突破", "放量"],
    stopLossPrice: 9.8,
    invalidationRule: null,
    ...overrides,
  };
}

function postReview(strategyAdjustment) {
  return {
    outcome: "partial",
    executionReview: "开仓按计划执行，但没有等待更明确的次日确认信号。",
    mistakes: "仓位建立略早，确认不足。",
    lessons: "后续需要把次日承接和量价确认写进执行清单。",
    disciplineScore: 4,
    riskControlScore: 4,
    playbookFitScore: 4,
    strategyAdjustment,
  };
}

describe("replay playbook API", () => {
  let app;
  let root;
  let dbPath;
  let engineServer;
  let customPlaybook;
  let customVersionOne;
  let customVersionTwo;
  let firstCandidate;

  before(async () => {
    engineServer = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && url.pathname === "/internal/replay/scenarios") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const payload = JSON.parse(body || "{}");
          res.end(JSON.stringify(privateScenario(payload.gameLength)));
        });
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "not found" }));
    });
    await new Promise((resolve) => engineServer.listen(0, "127.0.0.1", resolve));
    const address = engineServer.address();
    root = mkdtempSync(join(tmpdir(), "investflow-replay-playbook-"));
    dbPath = join(root, "workbench.sqlite");
    app = createApp({
      dbPath,
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

  async function createFinishedSession(seed) {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed })
      .expect(201);
    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/finish`)
      .send({
        actionId: `finish-${seed}`,
        expectedRevision: created.body.session.revision,
      })
      .expect(200);
    return finished.body.session;
  }

  async function saveLinkedBlind(session, actionId, playbook, version) {
    return request(app)
      .post(`/api/quant/replay/sessions/${session.id}/reviews/blind`)
      .send({
        actionId,
        expectedRevision: session.revision,
        ...blindReview({
          strategyName: "客户端伪造名称",
          playbookId: playbook.id,
          playbookVersionId: version.id,
        }),
      })
      .expect(200);
  }

  async function revealAndReview(session, prefix, suggestion) {
    const revealed = await request(app)
      .post(`/api/quant/replay/sessions/${session.id}/reveal`)
      .send({
        actionId: `${prefix}-reveal`,
        expectedRevision: session.revision,
      })
      .expect(200);
    return request(app)
      .post(`/api/quant/replay/sessions/${session.id}/reviews/post`)
      .send({
        actionId: `${prefix}-post`,
        expectedRevision: revealed.body.session.revision,
        ...postReview(suggestion),
      })
      .expect(200);
  }

  it("seeds stable default playbooks with an actionable immutable 少妇战法 version", async () => {
    const first = await request(app)
      .get("/api/quant/replay/playbooks")
      .expect(200);
    const second = await request(app)
      .get("/api/quant/replay/playbooks")
      .expect(200);

    assert.deepEqual(
      first.body.items.map((item) => [item.id, item.name]),
      [
        ["replay-playbook-longtou", "龙头战法"],
        ["replay-playbook-shaofu", "少妇战法"],
      ],
    );
    assert.deepEqual(
      second.body.items.map((item) => item.id),
      first.body.items.map((item) => item.id),
    );
    for (const item of first.body.items) {
      assert.equal(item.currentVersion.versionNumber, 1);
      assert.equal(item.pendingCandidateCount, 0);
    }
    assert.equal(
      first.body.items.find((item) => item.id === "replay-playbook-longtou").currentVersion.content,
      "",
    );
    assert.match(
      first.body.items.find((item) => item.id === "replay-playbook-shaofu").currentVersion.content,
      /本决策台不负责少妇战法选股/u,
    );
    assertLightweight(first.body);

    const detail = await request(app)
      .get("/api/quant/replay/playbooks/replay-playbook-longtou")
      .expect(200);
    assert.equal(detail.body.versions.length, 1);
    assert.equal(detail.body.versions[0].changeSummary, "默认空白模板");
    assert.deepEqual(detail.body.candidates, []);
    assertLightweight(detail.body);

    const restartDbPath = join(root, "restart-seed.sqlite");
    createDatabase(restartDbPath).close();
    createDatabase(restartDbPath).close();
    const restarted = new DatabaseSync(restartDbPath, { readOnly: true });
    const counts = {
      playbooks: restarted
        .prepare("SELECT COUNT(*) AS count FROM replay_playbooks")
        .get().count,
      versions: restarted
        .prepare("SELECT COUNT(*) AS count FROM replay_playbook_versions")
        .get().count,
    };
    restarted.close();
    assert.deepEqual(counts, { playbooks: 2, versions: 2 });
  });

  it("adds an actionable new version for an older blank 少妇战法 template without rewriting history", () => {
    const legacyPath = join(root, "legacy-shaofu.sqlite");
    createDatabase(legacyPath).close();
    const legacy = new DatabaseSync(legacyPath);
    legacy.prepare(
      `
      UPDATE replay_playbook_versions
      SET content = ''
      WHERE id = 'replay-playbook-shaofu-v1'
      `,
    ).run();
    legacy.close();

    createDatabase(legacyPath).close();
    const migrated = new DatabaseSync(legacyPath, { readOnly: true });
    const current = migrated.prepare(
      `
      SELECT versions.version_number AS versionNumber, versions.content AS content
      FROM replay_playbooks AS playbooks
      INNER JOIN replay_playbook_versions AS versions
        ON versions.id = playbooks.current_version_id
      WHERE playbooks.id = 'replay-playbook-shaofu'
      `,
    ).get();
    const legacyVersion = migrated.prepare(
      "SELECT content FROM replay_playbook_versions WHERE id = 'replay-playbook-shaofu-v1'",
    ).get();
    migrated.close();

    assert.equal(current.versionNumber, 2);
    assert.match(current.content, /本决策台不负责少妇战法选股/u);
    assert.equal(legacyVersion.content, "");
  });

  it("creates a playbook and appends versions without changing old content", async () => {
    await request(app)
      .post("/api/quant/replay/playbooks")
      .send({ name: "", content: "", changeSummary: "初始版本" })
      .expect(400);
    await request(app)
      .post("/api/quant/replay/playbooks")
      .send({ name: "无摘要", content: "", changeSummary: "" })
      .expect(400);

    const created = await request(app)
      .post("/api/quant/replay/playbooks")
      .send({
        name: "突破确认战法",
        content: "v1：突破后观察。",
        changeSummary: "创建战法",
      })
      .expect(201);
    customPlaybook = created.body.playbook;
    customVersionOne = created.body.playbook.currentVersion;
    assert.equal(customVersionOne.versionNumber, 1);

    const appended = await request(app)
      .post(`/api/quant/replay/playbooks/${customPlaybook.id}/versions`)
      .send({
        expectedVersionNumber: 1,
        content: "v2：突破后观察次日承接。",
        changeSummary: "增加次日承接",
      })
      .expect(201);
    customVersionTwo = appended.body.version;
    assert.equal(customVersionTwo.versionNumber, 2);

    await request(app)
      .post(`/api/quant/replay/playbooks/${customPlaybook.id}/versions`)
      .send({
        expectedVersionNumber: 1,
        content: "过期写入",
        changeSummary: "并发冲突",
      })
      .expect(409);

    const detail = await request(app)
      .get(`/api/quant/replay/playbooks/${customPlaybook.id}`)
      .expect(200);
    assert.equal(detail.body.playbook.currentVersion.id, customVersionTwo.id);
    assert.equal(detail.body.versions[0].content, "v2：突破后观察次日承接。");
    assert.equal(detail.body.versions[1].id, customVersionOne.id);
    assert.equal(detail.body.versions[1].content, "v1：突破后观察。");
  });

  it("renames and soft-deletes a playbook without removing frozen versions", async () => {
    const created = await request(app)
      .post("/api/quant/replay/playbooks")
      .send({
        name: "待整理战法",
        content: "首版规则保持不变。",
        changeSummary: "创建待整理战法",
      })
      .expect(201);
    const playbookId = created.body.playbook.id;
    const versionId = created.body.playbook.currentVersion.id;

    const renamed = await request(app)
      .patch(`/api/quant/replay/playbooks/${playbookId}`)
      .send({ name: "整理后的战法" })
      .expect(200);
    assert.equal(renamed.body.playbook.name, "整理后的战法");

    await request(app)
      .patch(`/api/quant/replay/playbooks/${playbookId}`)
      .send({ name: "少妇战法" })
      .expect(409);

    await request(app)
      .delete(`/api/quant/replay/playbooks/${playbookId}`)
      .expect(204);
    const list = await request(app)
      .get("/api/quant/replay/playbooks")
      .expect(200);
    assert.equal(
      list.body.items.some((item) => item.id === playbookId),
      false,
    );
    await request(app)
      .get(`/api/quant/replay/playbooks/${playbookId}`)
      .expect(404);

    const inspection = new DatabaseSync(dbPath, { readOnly: true });
    const storedPlaybook = inspection
      .prepare(
        "SELECT name, deleted_at FROM replay_playbooks WHERE id = ?",
      )
      .get(playbookId);
    const storedVersion = inspection
      .prepare(
        "SELECT content FROM replay_playbook_versions WHERE id = ?",
      )
      .get(versionId);
    inspection.close();
    assert.equal(storedPlaybook.name, "整理后的战法");
    assert.ok(storedPlaybook.deleted_at);
    assert.equal(storedVersion.content, "首版规则保持不变。");
  });

  it("validates linked blind reviews while preserving legacy free text", async () => {
    const session = await createFinishedSession(101);
    await request(app)
      .post(`/api/quant/replay/sessions/${session.id}/reviews/blind`)
      .send({
        actionId: "pair-missing",
        expectedRevision: session.revision,
        ...blindReview({ playbookId: customPlaybook.id }),
      })
      .expect(400);
    await request(app)
      .post(`/api/quant/replay/sessions/${session.id}/reviews/blind`)
      .send({
        actionId: "wrong-version-owner",
        expectedRevision: session.revision,
        ...blindReview({
          playbookId: customPlaybook.id,
          playbookVersionId: "replay-playbook-longtou-v1",
        }),
      })
      .expect(400);

    const linked = await saveLinkedBlind(
      session,
      "valid-link",
      customPlaybook,
      customVersionTwo,
    );
    assert.equal(
      linked.body.session.review.blindReview.strategyName,
      "突破确认战法",
    );
    assert.equal(
      linked.body.session.review.blindReview.playbookVersionId,
      customVersionTwo.id,
    );
    assert.equal(
      linked.body.session.review.blindReview.playbookVersionNumber,
      2,
    );
    await request(app)
      .post(`/api/quant/replay/sessions/${session.id}/reviews/blind`)
      .send({
        actionId: "client-version-number",
        expectedRevision: linked.body.session.revision,
        ...blindReview({
          playbookId: customPlaybook.id,
          playbookVersionId: customVersionTwo.id,
          playbookVersionNumber: 999,
        }),
      })
      .expect(400);

    const legacySession = await createFinishedSession(102);
    const legacy = await request(app)
      .post(`/api/quant/replay/sessions/${legacySession.id}/reviews/blind`)
      .send({
        actionId: "legacy-blind",
        expectedRevision: legacySession.revision,
        ...blindReview(),
      })
      .expect(200);
    const reviewed = await revealAndReview(
      legacy.body.session,
      "legacy",
      "旧会话也可继续填写复盘。",
    );
    await request(app)
      .post("/api/quant/replay/playbook-candidates")
      .send({ sessionId: reviewed.body.session.id })
      .expect(409);
  });

  it("creates candidates only after reveal and does so idempotently", async () => {
    const session = await createFinishedSession(103);
    const blind = await saveLinkedBlind(
      session,
      "candidate-blind",
      customPlaybook,
      customVersionTwo,
    );
    await request(app)
      .post("/api/quant/replay/playbook-candidates")
      .send({ sessionId: session.id })
      .expect(409);

    const reviewed = await revealAndReview(
      blind.body.session,
      "candidate",
      "增加大盘强弱过滤条件。",
    );
    const created = await request(app)
      .post("/api/quant/replay/playbook-candidates")
      .send({ sessionId: reviewed.body.session.id })
      .expect(200);
    const repeated = await request(app)
      .post("/api/quant/replay/playbook-candidates")
      .send({ sessionId: reviewed.body.session.id })
      .expect(200);
    firstCandidate = created.body.candidate;
    assert.equal(firstCandidate.state, "pending");
    assert.equal(firstCandidate.sourceVersionId, customVersionTwo.id);
    assert.equal(repeated.body.candidate.id, firstCandidate.id);
    assertLightweight(created.body);

    const changedReview = await request(app)
      .post(
        `/api/quant/replay/sessions/${reviewed.body.session.id}/reviews/post/corrections`,
      )
      .send({
        actionId: "candidate-post-updated",
        expectedRevision: reviewed.body.session.revision,
        changeNote: "补充行业景气度过滤建议",
        ...postReview("改为增加行业景气度过滤条件。"),
      })
      .expect(200);
    const unchangedCandidate = await request(app)
      .post("/api/quant/replay/playbook-candidates")
      .send({ sessionId: changedReview.body.session.id })
      .expect(200);
    assert.equal(unchangedCandidate.body.candidate.id, firstCandidate.id);

    const list = await request(app)
      .get("/api/quant/replay/playbooks")
      .expect(200);
    const summary = list.body.items.find(
      (item) => item.id === customPlaybook.id,
    );
    assert.equal(summary.pendingCandidateCount, 1);
    assertLightweight(list.body);
  });

  it("accepts into a new immutable version and rejects other pending candidates", async () => {
    const accepted = await request(app)
      .post(
        `/api/quant/replay/playbook-candidates/${firstCandidate.id}/accept`,
      )
      .send({
        expectedVersionNumber: 2,
        content: "v3：突破后观察次日承接，并增加大盘强弱过滤。",
        changeSummary: "采纳演练候选",
      })
      .expect(200);
    assert.equal(accepted.body.candidate.state, "accepted");
    assert.equal(accepted.body.version.versionNumber, 3);
    assert.equal(accepted.body.version.sourceCandidateId, firstCandidate.id);
    assert.equal(
      accepted.body.candidate.acceptedVersionId,
      accepted.body.version.id,
    );

    const detail = await request(app)
      .get(`/api/quant/replay/playbooks/${customPlaybook.id}`)
      .expect(200);
    assert.equal(detail.body.versions.length, 3);
    assert.equal(detail.body.versions[1].id, customVersionTwo.id);
    assert.equal(detail.body.versions[1].content, "v2：突破后观察次日承接。");
    assert.equal(detail.body.versions[2].id, customVersionOne.id);

    const another = await createFinishedSession(104);
    const anotherBlind = await saveLinkedBlind(
      another,
      "reject-blind",
      customPlaybook,
      accepted.body.version,
    );
    const anotherReviewed = await revealAndReview(
      anotherBlind.body.session,
      "reject",
      "增加板块热度确认。",
    );
    const candidate = await request(app)
      .post("/api/quant/replay/playbook-candidates")
      .send({ sessionId: anotherReviewed.body.session.id })
      .expect(200);

    await request(app)
      .post(
        `/api/quant/replay/playbook-candidates/${candidate.body.candidate.id}/accept`,
      )
      .send({
        expectedVersionNumber: 2,
        content: "不能写入",
        changeSummary: "过期版本",
      })
      .expect(409);

    const rejected = await request(app)
      .post(
        `/api/quant/replay/playbook-candidates/${candidate.body.candidate.id}/reject`,
      )
      .send({ reason: "证据不足，继续观察" })
      .expect(200);
    assert.equal(rejected.body.candidate.state, "rejected");
    assert.equal(rejected.body.candidate.reason, "证据不足，继续观察");
    await request(app)
      .post(
        `/api/quant/replay/playbook-candidates/${candidate.body.candidate.id}/reject`,
      )
      .send({ reason: "重复处理" })
      .expect(409);
  });

  it("deletes only unreferenced non-current playbook versions", async () => {
    const detail = await request(app)
      .get(`/api/quant/replay/playbooks/${customPlaybook.id}`)
      .expect(200);
    const current = detail.body.versions.find(
      (version) => version.id === detail.body.playbook.currentVersion.id,
    );
    const referenced = detail.body.versions.find(
      (version) => version.id === customVersionTwo.id,
    );
    const unreferenced = detail.body.versions.find(
      (version) => version.id === customVersionOne.id,
    );

    assert.deepEqual(
      {
        canDelete: current.canDelete,
        deletionBlockReason: current.deletionBlockReason,
      },
      { canDelete: false, deletionBlockReason: "current" },
    );
    assert.equal(referenced.canDelete, false);
    assert.equal(referenced.deletionBlockReason, "referenced");
    assert.ok(referenced.referenceCount >= 1);
    assert.deepEqual(
      {
        canDelete: unreferenced.canDelete,
        deletionBlockReason: unreferenced.deletionBlockReason,
        referenceCount: unreferenced.referenceCount,
      },
      { canDelete: true, deletionBlockReason: null, referenceCount: 0 },
    );

    await request(app)
      .delete(
        `/api/quant/replay/playbooks/${customPlaybook.id}/versions/${current.id}`,
      )
      .expect(409);
    await request(app)
      .delete(
        `/api/quant/replay/playbooks/${customPlaybook.id}/versions/${referenced.id}`,
      )
      .expect(409);
    await request(app)
      .delete(
        `/api/quant/replay/playbooks/${customPlaybook.id}/versions/${unreferenced.id}`,
      )
      .expect(204);

    const refreshed = await request(app)
      .get(`/api/quant/replay/playbooks/${customPlaybook.id}`)
      .expect(200);
    assert.equal(
      refreshed.body.versions.some((version) => version.id === unreferenced.id),
      false,
    );
  });

  it("stores no market snapshot in playbook domain tables", () => {
    const inspection = new DatabaseSync(dbPath, { readOnly: true });
    for (const table of [
      "replay_playbooks",
      "replay_playbook_versions",
      "replay_playbook_candidates",
    ]) {
      const columns = inspection
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name);
      assert.equal(columns.includes("snapshot_json"), false);
      assert.equal(columns.includes("bars"), false);
    }
    const storedVersions = inspection
      .prepare(
        `
        SELECT content, change_summary
        FROM replay_playbook_versions
        WHERE playbook_id = ?
        ORDER BY version_number
        `,
      )
      .all(customPlaybook.id);
    inspection.close();
    assert.deepEqual(
      storedVersions.map((row) => row.content),
      [
        "v2：突破后观察次日承接。",
        "v3：突破后观察次日承接，并增加大盘强弱过滤。",
      ],
    );
  });
});
