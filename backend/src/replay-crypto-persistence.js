import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { cryptoExposure, cryptoExposureConflict } from "./replay-crypto-pool.js";

const D = Decimal.clone({ precision: 96 });
const zero = "0.00000000", money = (v) => { const n = new D(v).toDecimalPlaces(8); return n.isZero() ? zero : n.toFixed(8); };
export const cryptoHash = (text) => createHash("sha256").update(text).digest("hex");
export function cryptoPersistenceError(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
const fail = (code, message, status) => { throw cryptoPersistenceError(code, message, status); };
export function initializeCryptoReplaySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_crypto_journals (
      session_id TEXT PRIMARY KEY, content_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replay_crypto_snapshots (
      id TEXT PRIMARY KEY, document_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replay_execution_traces (
      session_id TEXT NOT NULL, action_id TEXT NOT NULL, event_sequence INTEGER NOT NULL,
      revision INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, event_sequence)
    );
    CREATE TABLE IF NOT EXISTS replay_account_entries (
      session_id TEXT NOT NULL, action_id TEXT NOT NULL, revision INTEGER NOT NULL, cursor_minute INTEGER NOT NULL,
      available_delta TEXT NOT NULL, reserved_delta TEXT NOT NULL, margin_delta TEXT NOT NULL,
      initial_delta TEXT NOT NULL, fees_delta TEXT NOT NULL, funding_delta TEXT NOT NULL,
      realized_delta TEXT NOT NULL, liquidation_delta TEXT NOT NULL, topup_delta TEXT NOT NULL,
      balances_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(session_id, action_id)
    );
    CREATE TRIGGER IF NOT EXISTS replay_crypto_snapshots_no_update BEFORE UPDATE ON replay_crypto_snapshots
      BEGIN SELECT RAISE(ABORT, 'frozen crypto snapshot is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS replay_crypto_snapshots_no_delete BEFORE DELETE ON replay_crypto_snapshots
      BEGIN SELECT RAISE(ABORT, 'frozen crypto snapshot is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS replay_crypto_contract_immutable BEFORE UPDATE ON replay_sessions
      WHEN OLD.market = 'crypto-perpetual' AND (NEW.market IS NOT OLD.market
        OR NEW.snapshot_json IS NOT OLD.snapshot_json OR NEW.snapshot_hash IS NOT OLD.snapshot_hash
        OR NEW.execution_model_version IS NOT OLD.execution_model_version
        OR NEW.cost_config_json IS NOT OLD.cost_config_json OR NEW.source_data_version IS NOT OLD.source_data_version
        OR NEW.observation_bars IS NOT OLD.observation_bars OR NEW.game_length IS NOT OLD.game_length)
      BEGIN SELECT RAISE(ABORT, 'frozen crypto session contract is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS replay_crypto_account_hash_required BEFORE UPDATE OF account_json ON replay_sessions
      WHEN OLD.market = 'crypto-perpetual' AND NEW.account_json IS NOT OLD.account_json AND NEW.account_state_hash IS OLD.account_state_hash
      BEGIN SELECT RAISE(ABORT, 'crypto state must update with its integrity hash'); END;
  `);
}

// This adapter owns no connection; only createDatabase installs it on its existing writer facade.
export function createCryptoPersistence({ db, readSession, rowToSession, readReview, readAction, insertEvent, reserveAttempt, scenarioIdentity, scoringConfig }) {
  const row = (id, includeDeleted = false) => db.prepare(`SELECT * FROM replay_sessions WHERE id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`).get(id);
  function transaction(operation) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function requireCrypto(current) {
    if (!current) fail("NOT_FOUND", "找不到行情演练会话", 404);
    if (current.market !== "crypto-perpetual") fail("INVALID_REQUEST", "该操作仅用于合约会话", 400);
  }
  function actionMatch(existing, eventType, request) {
    if (existing.eventType !== eventType || JSON.stringify(existing.payload.request) !== JSON.stringify(request)) fail("REPLAY_ACTION_CONFLICT", "actionId 已被不同请求使用");
  }
  function revision(current, expected) {
    if (current.revision !== expected) fail("REPLAY_REVISION_CONFLICT", "会话版本已变化，请重新读取后操作");
  }
  const readJournal = (id) => JSON.parse(db.prepare("SELECT content_json FROM replay_crypto_journals WHERE session_id = ?").get(id)?.content_json ?? '{"plan":{"mode":"none","manualExitPrice":null,"reason":""},"decisions":[],"postReview":null}');
  const withJournal = (s) => ({ ...s, cryptoJournal: readJournal(s.id) });
  function responseSession(sessionId, saved) {
    const current = readSession(sessionId); requireCrypto(current);
    return { ...current, ...saved };
  }
  function frozenResponse(s) {
    return { account: s.account, revision: s.revision, status: s.status, revealedFutureBars: s.revealedFutureBars,
      completionReason: s.completionReason, revealedAt: s.revealedAt, updatedAt: s.updatedAt, review: s.review, cryptoJournal: s.cryptoJournal };
  }
  function ledger(sessionId, actionId, rev, before, after, timestamp) {
    const buckets = (s) => ({ available: s?.account?.availableBalance ?? zero, reserved: s?.reservedBalance ?? zero, margin: s?.account?.position?.marginBalance ?? zero });
    const old = buckets(before), next = buckets(after), delta = (key) => money(new D(next[key]).minus(old[key]));
    const change = (key) => money(new D(after.totals[key]).minus(before?.totals[key] ?? 0));
    const initial = before ? zero : after.startingCash;
    const fees = change("tradingFees"), funding = change("fundingPayments"), realized = change("realizedPricePnl"), liquidation = change("liquidationAggregatePnl");
    const sum = new D(delta("available")).plus(delta("reserved")).plus(delta("margin"));
    if (!sum.eq(new D(initial).minus(fees).minus(funding).plus(realized).plus(liquidation))) fail("REPLAY_ACCOUNTING_CORRUPT", "账户桶与业务账本金额不一致", 500);
    db.prepare(`INSERT INTO replay_account_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sessionId, actionId, rev, after.elapsedMinutes, delta("available"), delta("reserved"), delta("margin"), initial,
      fees, funding, realized, liquidation, change("manualTopups"), JSON.stringify(next), timestamp);
  }
  const legacyWindows = new Map();
  function exposureUsage() {
    return db.prepare("SELECT * FROM replay_sessions WHERE market = 'crypto-perpetual'").all().map((row) => {
      const session = rowToSession(row), descriptor = session.snapshot;
      let window = descriptor.exposure;
      if (!window) {
        window = legacyWindows.get(descriptor.cryptoSnapshotId);
        if (!window) {
          const doc = db.prepare("SELECT document_json FROM replay_crypto_snapshots WHERE id = ?").get(descriptor.cryptoSnapshotId);
          if (!doc || cryptoHash(doc.document_json) !== descriptor.cryptoSnapshotId) fail("REPLAY_SNAPSHOT_CORRUPT", "旧会话暴露快照缺失或损坏，未重置首次", 500);
          window = JSON.parse(doc.document_json).scenario.window; legacyWindows.set(descriptor.cryptoSnapshotId, window);
        }
      }
      const exposure = cryptoExposure(descriptor.instrumentId, window);
      return { ...exposure, id: session.id, deleted: Boolean(row.deleted_at),
        knownThroughMs: session.revealedAt ? exposure.executionEndMs : exposure.replayStartMs + session.revealedFutureBars * 60000 };
    });
  }
  function insertInitial({ id, snapshot, state, sourceDataVersion, createdAt, snapshotDocument, sourceSessionId = null }) {
    if (snapshot.exposure && !sourceSessionId && cryptoExposureConflict(snapshot.exposure, exposureUsage())) fail("REPLAY_EXPOSURE_CONFLICT", "该时段已被另一练习或相关行情暴露，请重新选择未见场景", 409);
    if (snapshotDocument) {
      if (cryptoHash(snapshotDocument.json) !== snapshotDocument.id || snapshotDocument.id !== snapshot.cryptoSnapshotId) fail("REPLAY_SNAPSHOT_CORRUPT", "冻结场景校验失败", 500);
      db.prepare("INSERT OR IGNORE INTO replay_crypto_snapshots VALUES (?, ?, ?)").run(snapshotDocument.id, snapshotDocument.json, createdAt);
    }
    if (!db.prepare("SELECT id FROM replay_crypto_snapshots WHERE id = ?").get(snapshot.cryptoSnapshotId)) fail("REPLAY_SNAPSHOT_CORRUPT", "冻结场景缺失", 500);
    const identity = scenarioIdentity({ snapshot }), attempt = reserveAttempt(identity.fingerprint, createdAt);
    const snapshotJson = JSON.stringify(snapshot), stateJson = JSON.stringify(state);
    db.prepare(`INSERT INTO replay_sessions (id, source_data_version, game_length, observation_bars, revealed_future_bars,
      status, revision, snapshot_json, account_json, cost_config_json, training_config_json, scoring_config_json,
      scenario_fingerprint, scenario_fingerprint_version, attempt_number, attempt_kind, counts_toward_first_score,
      source_session_id, created_at, updated_at, market, execution_model_version, snapshot_hash, account_state_hash)
      VALUES (?, ?, ?, ?, 0, 'active', 0, ?, ?, ?, '{"mode":"free"}', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'crypto-perpetual', ?, ?, ?)`).run(
      id, sourceDataVersion, snapshot.totalMinutes, snapshot.backgroundMinutes, snapshotJson, stateJson,
      JSON.stringify(snapshot.config), JSON.stringify(scoringConfig()), identity.fingerprint, identity.version, attempt,
      sourceSessionId || attempt > 1 ? "retrain" : "first", sourceSessionId || attempt > 1 ? 0 : 1, sourceSessionId,
      createdAt, createdAt, snapshot.executionVersion, cryptoHash(snapshotJson), cryptoHash(stateJson));
  }
  return {
    getReplayCryptoExposureUsage: exposureUsage,
    getReplayCryptoJournal: readJournal,
    getFirstReplayCryptoSession(id) {
      const current = readSession(id); requireCrypto(current);
      // Comparison is the sole read path that includes a soft-deleted first.
      // Keep normal session/history reads filtered, and hydrate its frozen review.
      const first = db.prepare("SELECT * FROM replay_sessions WHERE market = 'crypto-perpetual' AND scenario_fingerprint = ? AND attempt_number = 1").get(current.scenarioFingerprint);
      return first ? { ...rowToSession(first), review: readReview(first.id) } : null;
    },
    getReplayCryptoSnapshot(id) {
      const result = db.prepare("SELECT document_json FROM replay_crypto_snapshots WHERE id = ?").get(id);
      if (!result || cryptoHash(result.document_json) !== id) fail("REPLAY_SNAPSHOT_CORRUPT", "冻结场景缺失或校验失败", 500);
      return result.document_json;
    },
    createCryptoReplaySession({ session, snapshotDocument, actionId, request }) {
      return transaction(() => {
        const previous = row(session.id, true);
        if (previous) {
          if (previous.deleted_at) fail("REPLAY_ACTION_CONFLICT", "该创建动作对应会话已删除");
          requireCrypto(rowToSession(previous)); const action = readAction(session.id, actionId);
          if (!action) fail("REPLAY_ACTION_CONFLICT", "创建标识已被占用");
          actionMatch(action, "crypto-created", request);
          return { session: responseSession(session.id, action.payload.response), idempotent: true, created: false };
        }
        insertInitial({ ...session, snapshotDocument });
        ledger(session.id, actionId, 0, null, session.state, session.createdAt);
        const created = withJournal(readSession(session.id));
        insertEvent({ sessionId: session.id, actionId, eventType: "crypto-created", sequence: 0,
          payload: { request, response: frozenResponse(created) }, createdAt: session.createdAt });
        return { session: created, created: true, idempotent: false };
      });
    },
    mutateCryptoReplaySession({ sessionId, actionId, expectedRevision, request, updatedAt, compute }) {
      return transaction(() => {
        const current = rowToSession(row(sessionId)); requireCrypto(current);
        const existing = readAction(sessionId, actionId);
        if (existing) {
          actionMatch(existing, "crypto-action", request);
          return { session: responseSession(sessionId, existing.payload.response), idempotent: true, outcome: existing.payload.outcome };
        }
        revision(current, expectedRevision);
        const result = compute(withJournal(readSession(sessionId)));
        const state = result.state, nextRevision = current.revision + 1;
        const traces = result.events ?? [];
        if (traces.some((trace, i) => trace.sequence !== current.account.eventSequence + i + 1)
          || state.eventSequence !== current.account.eventSequence + traces.length) fail("REPLAY_ACCOUNTING_CORRUPT", "执行轨迹序号不连续", 500);
        if (!state || state.elapsedMinutes < current.account.elapsedMinutes || state.elapsedMinutes > current.gameLength
          || state.versions.executionVersion !== current.executionModelVersion) fail("REPLAY_ACCOUNTING_CORRUPT", "执行状态或可见游标不一致", 500);
        if (result.blindReview) {
          if (current.status !== "completed" || current.revealedAt || readSession(sessionId).review.blindReview) fail("REPLAY_ACTION_CONFLICT", "盲评只可在完成后、揭晓前保存一次");
          db.prepare(`INSERT INTO replay_reviews (session_id, blind_json, blind_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
            .run(sessionId, JSON.stringify(result.blindReview), updatedAt, updatedAt, updatedAt);
        }
        if (result.reveal && (current.status !== "completed" || state.account.position || current.revealedAt || !readSession(sessionId).review.blindReview)) fail("REPLAY_ACTION_CONFLICT", "请先完成平仓和盲评再揭晓");
        const journal = readJournal(sessionId);
        if (result.trainingPlan) {
          if (current.status !== "active" || current.account.ending) fail("REPLAY_ACTION_CONFLICT", "只可在练习进行时修改退出计划");
          journal.plan = result.trainingPlan;
        }
        if (result.postReview) {
          if (!current.revealedAt || current.status !== "completed" || journal.postReview) fail("REPLAY_ACTION_CONFLICT", "请揭晓后保存事后复盘，已提交内容保留不改写");
          journal.postReview = result.postReview;
          db.prepare("UPDATE replay_reviews SET post_json = ?, post_updated_at = ?, updated_at = ? WHERE session_id = ?").run(JSON.stringify(result.postReview), updatedAt, updatedAt, sessionId);
        }
        if (result.decision) journal.decisions.push({ actionId, revision: nextRevision, cursorMinute: current.account.elapsedMinutes,
          ...result.decision, plan: structuredClone(journal.plan) });
        db.prepare("INSERT INTO replay_crypto_journals VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET content_json=excluded.content_json").run(sessionId, JSON.stringify(journal));
        const stateJson = JSON.stringify(state);
        const completion = state.status === "completed" ? (state.endReason === "user-finish" ? "early" : "natural") : null;
        const written = db.prepare(`UPDATE replay_sessions SET account_json = ?, account_state_hash = ?, revealed_future_bars = ?,
          revision = ?, status = ?, completion_reason = ?, revealed_at = ?, updated_at = ? WHERE id = ? AND revision = ?`).run(
          stateJson, cryptoHash(stateJson), state.elapsedMinutes, nextRevision, state.status, completion,
          result.reveal ? updatedAt : current.revealedAt, updatedAt, sessionId, current.revision);
        if (Number(written.changes) !== 1) fail("REPLAY_REVISION_CONFLICT", "会话提交版本已变化");
        for (const trace of result.events ?? []) db.prepare("INSERT INTO replay_execution_traces VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(sessionId, actionId, trace.sequence, nextRevision, trace.type, JSON.stringify(trace), updatedAt);
        ledger(sessionId, actionId, nextRevision, current.account, state, updatedAt);
        const session = withJournal(readSession(sessionId)), outcome = result.outcome ?? {};
        insertEvent({ sessionId, actionId, eventType: "crypto-action", sequence: state.elapsedMinutes,
          payload: { request, response: frozenResponse(session), outcome }, createdAt: updatedAt });
        return { session, outcome, idempotent: false };
      });
    },
    retrainCryptoReplaySession({ sourceSessionId, id, actionId, expectedRevision, request, createdAt, initialize }) {
      return transaction(() => {
        const source = rowToSession(row(sourceSessionId)); requireCrypto(source);
        const existing = readAction(sourceSessionId, actionId);
        if (existing) {
          actionMatch(existing, "crypto-retrained", request);
          return { session: responseSession(existing.payload.childId, existing.payload.response), idempotent: true, created: false };
        }
        revision(source, expectedRevision);
        if (!source.revealedAt || source.status !== "completed" || source.account.account.position) fail("REPLAY_ACTION_CONFLICT", "源会话须已结束并揭晓才可复练");
        const state = initialize(source);
        insertInitial({ id, snapshot: source.snapshot, state, sourceDataVersion: source.sourceDataVersion, createdAt, sourceSessionId });
        ledger(id, actionId, 0, null, state, createdAt);
        const created = withJournal(readSession(id));
        insertEvent({ sessionId: id, actionId, eventType: "crypto-created-from-retrain", sequence: 0,
          payload: { request: { sourceSessionId }, response: frozenResponse(created) }, createdAt });
        insertEvent({ sessionId: sourceSessionId, actionId, eventType: "crypto-retrained", sequence: source.revealedFutureBars,
          payload: { request, childId: id, response: frozenResponse(created) }, createdAt });
        return { session: created, created: true, idempotent: false };
      });
    },
    readCryptoReplayActions({ sessionId, revision }) {
      return db.prepare("SELECT v.payload_json, e.revision FROM replay_events v JOIN replay_account_entries e ON v.session_id = e.session_id AND v.action_id = e.action_id WHERE v.session_id = ? AND e.revision <= ? ORDER BY e.revision")
        .all(sessionId, revision).map(r => { const payload = JSON.parse(r.payload_json); return { revision: r.revision, request: payload.request, state: payload.response.account }; });
    },
    readCryptoReplayEntries({ sessionId, revision: throughRevision, after = -1, limit = 100 }) {
      return db.prepare("SELECT * FROM replay_account_entries WHERE session_id = ? AND revision <= ? AND revision > ? ORDER BY revision LIMIT ?")
        .all(sessionId, throughRevision, after, limit).map((r) => ({ actionId: r.action_id, revision: r.revision, cursorMinute: r.cursor_minute,
          availableDelta: r.available_delta, reservedDelta: r.reserved_delta, marginDelta: r.margin_delta, initialDelta: r.initial_delta,
          feesDelta: r.fees_delta, fundingDelta: r.funding_delta, realizedDelta: r.realized_delta, liquidationDelta: r.liquidation_delta,
          topupDelta: r.topup_delta, balances: JSON.parse(r.balances_json) }));
    },
    readCryptoReplayTraces({ sessionId, revision: throughRevision, after = 0, limit = 100 }) {
      return db.prepare("SELECT t.payload_json, t.revision, t.action_id, e.balances_json FROM replay_execution_traces t JOIN replay_account_entries e ON t.session_id = e.session_id AND t.action_id = e.action_id WHERE t.session_id = ? AND t.revision <= ? AND t.event_sequence > ? ORDER BY t.event_sequence LIMIT ?")
        .all(sessionId, throughRevision, after, limit).map((r) => ({ ...JSON.parse(r.payload_json), revision: r.revision, actionId: r.action_id, availableBalanceAfterAction: JSON.parse(r.balances_json).available }));
    },
  };
}
