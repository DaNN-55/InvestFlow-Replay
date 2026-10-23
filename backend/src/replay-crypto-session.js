import { DEFAULT_CRYPTO_DATA_ROOT, SAMPLE_MANIFEST_SHA, RULE_SHA, RULE_FILE, sampleAssetDescriptor, checkedCryptoBytes, createCryptoAssetChecker, unavailableCryptoSummary } from './replay-crypto-data.js';
import { previewCryptoOrder, deriveCryptoReview } from './replay-crypto-insights.js';
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import Decimal from "decimal.js";
import { createCryptoOrderReplay, CRYPTO_ORDER_EXECUTION_VERSION } from "./replay-crypto-order-execution.js";
import { createCryptoScenarioView, MINUTE_MS } from "./replay-crypto-scenario.js";
import { createOkxHistoryPoolSource, cryptoExposure } from "./replay-crypto-pool.js";
import { cryptoHash, cryptoPersistenceError } from "./replay-crypto-persistence.js";
const D = Decimal.clone({ precision: 96 });
const MARKET = "crypto-perpetual";
const fail = (code, message, status = 400) => { throw cryptoPersistenceError(code, message, status); };
const canonical = (v) => JSON.stringify(v, function (_key, value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value;
});
function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail("INVALID_REQUEST", "请求包含不支持的字段");
}
function decimal(value) {
  if (Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== "string" || !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || value.replace(/[-.]/g, "").length > 32) fail("INVALID_REQUEST", "金额、价格和张数须为十进制字符串");
  return new D(value).toFixed();
}
function action(body) {
  if (typeof body.actionId !== "string" || !body.actionId.trim() || body.actionId.length > 128
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) fail("INVALID_REQUEST", "请提供 actionId 和有效 expectedRevision");
  return { actionId: body.actionId.trim(), expectedRevision: body.expectedRevision };
}
function protective(value) {
  fields(value, ["stopLoss", "takeProfit"]); const result = {};
  for (const key of ["stopLoss", "takeProfit"]) if (value[key] != null) {
    fields(value[key], ["price", "reference"]); result[key] = { price: decimal(value[key].price), reference: value[key].reference ?? "last" };
  }
  return result;
}
function normalizeCommand(input) {
  const schemas = { "market-open": ["side", "contracts", "protection"], "limit-open": ["side", "contracts", "limitPrice", "protection"],
    "market-close": ["contracts"], "limit-close": ["contracts", "limitPrice"], "amend-limit": ["orderId", "limitPrice"], "amend-quantity": ["orderId", "remainingContracts"], "amend-order": ["orderId", "limitPrice", "remainingContracts"], "cancel-order": ["orderId"], "cancel-all-orders": [],
    "set-protection": ["stopLoss", "takeProfit"], "cancel-protection": ["leg"], "add-margin": ["amount"], "advance": ["minutes"], "finish": [], "set-plan": ["mode", "manualExitPrice", "reason"] };
  const allowed = schemas[input?.type]; if (!allowed) fail("INVALID_REQUEST", "不支持该合约动作");
  fields(input, ["type", ...allowed]);
  if (input.type === "set-plan") {
    if (!["none", "manual"].includes(input.mode) || typeof input.reason !== "string" || input.reason.length > 2000) fail("INVALID_REQUEST", "请填写手动计划或未设退出价及原因");
    const price = input.mode === "manual" ? decimal(input.manualExitPrice) : null;
    if (price != null && !new D(price).gt(0)) fail("INVALID_REQUEST", "手动退出价须为正数");
    return { type: "set-plan", mode: input.mode, manualExitPrice: price, reason: input.reason.trim() };
  } const command = { type: input.type };
  for (const key of allowed) if (input[key] != null) command[key] = input[key];
  for (const key of ["contracts", "remainingContracts", "limitPrice", "amount"]) if (command[key] != null) command[key] = decimal(command[key]);
  if (command.protection) command.protection = protective(command.protection);
  if (command.type === "set-protection") Object.assign(command, protective({ stopLoss: input.stopLoss, takeProfit: input.takeProfit }));
  if (command.type === "advance") {
    if (![1, 5, 15].includes(command.minutes)) fail("INVALID_REQUEST", "合约推进只支持 1、5、15 分钟");
    command.stopOnEvent = true;
  }
  return command;
}
function domain(operation) {
  try { return operation(); } catch (error) { if (!error.status) { error.status = 400; error.code = "INVALID_CRYPTO_COMMAND"; } throw error; }
}

export function createFrozenOkxSource({ dataRoot = DEFAULT_CRYPTO_DATA_ROOT } = {}) {
  const check = createCryptoAssetChecker();
  function assets() {
    const descriptor = sampleAssetDescriptor(dataRoot);
    check(resolve(RULE_FILE, '..'), { file: RULE_FILE.split('/').at(-1), sha256: RULE_SHA });
    for (const ref of descriptor.refs) check(descriptor.root, ref);
    return descriptor;
  }
  return {
    summary() {
      try {
        const { manifest } = assets();
        return { mode: 'legacy-sample', ready: true, poolVersion: manifest.dataVersion, targetYears: [2024, 2025], admittedWindows: 2,
          instruments: Object.keys(manifest.instruments).map(instrumentId => ({ instrumentId, admittedWindows: 1, unseenWindows: null })),
          note: '两个冻结小样已核验，不代表完整历史池；同窗再次练习会列为复练。' };
      } catch (error) {
        if (!['REPLAY_SNAPSHOT_UNAVAILABLE', 'REPLAY_SNAPSHOT_CORRUPT'].includes(error.code)) throw error;
        return { ...unavailableCryptoSummary(), reasonCode: error.code };
      }
    },
    load(instrumentId) {
      const { root, manifest } = assets(), entry = manifest.instruments[instrumentId];
      if (!entry) fail('INVALID_REQUEST', '只支持 BTC/ETH USDT 永续');
      const ruleBytes = checkedCryptoBytes(resolve(RULE_FILE, '..'), { file: RULE_FILE.split('/').at(-1), sha256: RULE_SHA });
      const scenario = { instrumentId, window: manifest.window, fundingAudit: entry.fundingAudit };
      for (const kind of ['last', 'mark', 'funding']) scenario[kind] = JSON.parse(gunzipSync(checkedCryptoBytes(root, entry.files[kind])));
      return { rules: JSON.parse(ruleBytes), scenario, dataVersion: manifest.dataVersion, dataManifestSHA256: SAMPLE_MANIFEST_SHA };
    },
  };
}

export function createCryptoReplayService({ store, snapshotSource, now = () => new Date().toISOString() }) {
  snapshotSource ??= createOkxHistoryPoolSource({ legacySource: createFrozenOkxSource() });
  const documents = new Map(), runtimes = new Map(), analyses = new Map();
  function runtime(session) {
    if (session.market !== MARKET || session.executionModelVersion !== CRYPTO_ORDER_EXECUTION_VERSION || session.snapshot.executionVersion !== CRYPTO_ORDER_EXECUTION_VERSION)
      fail("REPLAY_VERSION_UNSUPPORTED", "不支持该会话冻结的执行版本，未自动升级", 409);
    const descriptor = session.snapshot, id = descriptor.cryptoSnapshotId;
    let document = documents.get(id);
    if (!document) {
      document = JSON.parse(store.getCryptoSnapshot(id));
      if (document.format !== "okx-crypto-session-snapshot-v1" || document.executionVersion !== descriptor.executionVersion
        || cryptoHash(canonical(document.rules)) !== document.ruleSHA256 || cryptoHash(canonical(document.scenario)) !== document.scenarioSHA256
        || document.scenarioSHA256 !== descriptor.scenarioSHA256 || document.ruleSHA256 !== descriptor.ruleSHA256
        || document.dataVersion !== session.sourceDataVersion || document.scenario.instrumentId !== descriptor.instrumentId) fail("REPLAY_SNAPSHOT_CORRUPT", "冻结文档与会话不匹配", 500);
      if (documents.size >= 4) { documents.clear(); runtimes.clear(); } documents.set(id, document);
    }
    const key = `${id}:${descriptor.config.slippageBps}`;
    let value = runtimes.get(key);
    if (!value) {
      value = { engine: domain(() => createCryptoOrderReplay({ rules: document.rules, scenario: document.scenario,
        dataVersion: document.dataVersion, slippageBps: descriptor.config.slippageBps })),
        view: createCryptoScenarioView(document.scenario), document };
      runtimes.set(key, value);
    }
    const s = session.account;
    if (s.elapsedMinutes !== session.revealedFutureBars || s.startingCash !== descriptor.config.startingCash || s.leverage !== descriptor.config.leverage
      || s.slippageBps !== String(descriptor.config.slippageBps) || s.status !== session.status
      || Object.keys(value.engine.versions).some((k) => s.versions[k] !== value.engine.versions[k])) fail("REPLAY_SNAPSHOT_CORRUPT", "执行版本、起始配置或服务端游标不一致", 500);
    return value;
  }
  function requireSession(id) {
    const s = store.getSession(id); if (!s) fail("NOT_FOUND", "找不到行情演练会话", 404);
    if (s.market !== MARKET) fail("INVALID_REQUEST", "该接口仅用于合约会话"); return s;
  }
  function present(session) {
    const { document } = runtime(session), state = session.account;
    const journal = session.cryptoJournal ?? store.getCryptoJournal(session.id);
    const index = (document.scenario.window.replayStartMs - document.scenario.window.backgroundStartMs) / MINUTE_MS + state.elapsedMinutes - 1;
    return { id: session.id, market: MARKET, instrumentId: session.snapshot.instrumentId, executionModelVersion: session.executionModelVersion,
      revision: session.revision, status: session.status, ending: state.ending, completionReason: session.completionReason,
      elapsedMinutes: state.elapsedMinutes, gameLength: session.gameLength, revealed: Boolean(session.revealedAt),
      account: state.account, reservedBalance: state.reservedBalance, orders: state.orders, protection: state.protection,
      risk: state.risk, totals: state.totals, summary: state.summary,
      trainingJournal: journal,
      config: session.snapshot.config,
      contract: { ctVal: document.rules.instruments[session.snapshot.instrumentId].spec.ctVal,
        ctMult: document.rules.instruments[session.snapshot.instrumentId].spec.ctMult,
        tickSz: document.rules.instruments[session.snapshot.instrumentId].spec.tickSz, lotSz: document.rules.instruments[session.snapshot.instrumentId].spec.lotSz,
        minSz: document.rules.instruments[session.snapshot.instrumentId].spec.minSz },
      ...(session.revealedAt && session.attemptInfo.kind === "retrain" ? { firstAttempt: firstAttempt(session.id) } : {}),
      currentPrices: { last: document.scenario.last[index].close, mark: document.scenario.mark[index].close },
      frozenRules: { ruleVersion: state.versions.ruleVersion, liquidationModelVersion: state.versions.liquidationModelVersion,
        makerRate: document.rules.feeBaseline.makerRate, takerRate: document.rules.feeBaseline.takerRate, slippageBps: state.slippageBps },
      attemptInfo: session.attemptInfo, blindReview: session.review?.blindReview ?? null,
      ...(session.revealedAt ? { reveal: { dataVersion: document.dataVersion, replayStartMs: document.scenario.window.replayStartMs, dataManifestSHA256: document.dataManifestSHA256 } } : {}),
      createdAt: session.createdAt, updatedAt: session.updatedAt };
  }
  function firstAttempt(id) {
    const source = store.getFirstCryptoSession(id);
    if (!source || !source.revealedAt || source.status !== "completed") return null;
    const state = source.account;
    return { id: source.id, config: source.snapshot.config, summary: state.summary, totals: state.totals, blindReview: source.review?.blindReview ?? null };
  }
  function wrap(result) { return { ...result, session: present(result.session) }; }
  function execute(id, body, command, extra = {}) {
    if (body.note != null && (typeof body.note !== "string" || body.note.length > 2000)) fail("INVALID_REQUEST", "操作理由最多 2000 字");
    const note = body.note?.trim() ?? "";
    const normalized = action(body), request = JSON.parse(canonical({ expectedRevision: normalized.expectedRevision, command, ...(note ? { note } : {}), ...extra }));
    return wrap(store.mutateCryptoSession({ sessionId: id, ...normalized, request, updatedAt: now(), compute(current) {
      const { engine } = runtime(current);
      if (command.type === "set-plan") return { state: current.account, events: [], trainingPlan: { mode: command.mode, manualExitPrice: command.manualExitPrice, reason: command.reason }, decision: { command, note: command.reason }, outcome: { saved: true } };
      if (extra.postReview) return { state: current.account, events: [], postReview: extra.postReview, outcome: { saved: true } };
      if (extra.blindReview) return { state: current.account, events: [], blindReview: extra.blindReview, outcome: { saved: true } };
      if (extra.reveal) return { state: current.account, events: [], reveal: true, outcome: { revealed: true } };
      let result = domain(() => engine.apply(current.account, command));
      if (command.type === "finish" && result.state.status === "active") {
        const next = domain(() => engine.apply(result.state, { type: "advance", minutes: 1, stopOnEvent: true }));
        result = { ...next, events: [...result.events, ...next.events] };
      }
      return { ...result, decision: command.type === "advance" ? null : { command, note }, outcome: { advancedMinutes: result.advancedMinutes, paused: result.paused, finished: result.state.status === "completed" } };
    } }));
  }
  function analysisFor(session) {
    const { document, engine } = runtime(session), key = `${session.id}:${session.revision}`;
    if (!analyses.has(key)) {
      const value = deriveCryptoReview({ engine, rules: document.rules, instrumentId: session.snapshot.instrumentId,
        config: session.snapshot.config, actions: store.readCryptoActions({ sessionId: session.id, revision: session.revision }), expectedState: session.account });
      if (analyses.size >= 8) analyses.clear(); analyses.set(key, value);
    }
    return structuredClone(analyses.get(key));
  }
  return {
    present,
    preview(id, body) {
      if (body?.command) {
        fields(body, ['expectedRevision', 'command']);
        const session = requireSession(id);
        if (body.expectedRevision !== session.revision) fail('REPLAY_REVISION_CONFLICT', '委托已变化，请重新预览', 409);
        const command = normalizeCommand(body.command);
        if (command.type !== 'amend-order') fail('INVALID_REQUEST', '此预览仅支持修改委托');
        const { engine } = runtime(session);
        let result, insufficient;
        try { result = engine.apply(session.account, command); }
        catch (error) {
          if (error.code === 'INSUFFICIENT_CASH' && error.amendmentPreview) insufficient = error.amendmentPreview;
          else domain(() => { throw error; });
        }
        const before = session.account.orders.find(o => o.id === command.orderId), after = insufficient?.order ?? result.state.orders.find(o => o.id === command.orderId);
        const summary = o => ({limitPrice:o.limitPrice, remainingContracts:o.remainingContracts, filledContracts:o.filledContracts, reservedBalance:o.reservedBalance});
        const reserveChange = new D(after.reservedBalance).minus(before.reservedBalance);
        const funds = { reserveChangeType:reserveChange.gt(0)?'increase':reserveChange.lt(0)?'release':'unchanged', reserveChangeAmount:reserveChange.abs().toFixed(8),
          affordable:!insufficient, shortfall:insufficient?.shortfall??'0.00000000',
          availableBalanceBefore:session.account.account.availableBalance, availableBalanceAfter:insufficient?.availableBalanceAfter??result.state.account.availableBalance };
        return { preview: { sessionId:id, revision:session.revision, command, before:summary(before), after:summary(after), funds } };
      }
      fields(body, ['expectedRevision', 'intent', 'orderType', 'sizingMode', 'amount', 'limitPrice', 'exitPrice', 'exitReference']);
      const session = requireSession(id);
      if (body.expectedRevision !== session.revision) fail('REPLAY_REVISION_CONFLICT', '会话已变化，请等待同步后重新预览', 409);
      const { document, engine } = runtime(session), visible = present(session);
      const preview = domain(() => previewCryptoOrder({ rules: document.rules, instrumentId: session.snapshot.instrumentId,
        state: session.account, prices: visible.currentPrices, engine, input: body }));
      return { preview: { ...preview, sessionId: id, revision: session.revision } };
    },
    analysis(id, query = {}) {
      fields(query, []); const session = requireSession(id);
      if (!session.revealedAt || session.status !== 'completed') fail('REPLAY_COMPARISON_NOT_READY', '完成并揭晓后可查看完整派生复盘', 409);
      const first = session.attemptInfo.kind === 'retrain' ? store.getFirstCryptoSession(id) : null;
      return { sessionId: id, revision: session.revision, analysis: analysisFor(session), first: first?.revealedAt && first.status === 'completed' ? analysisFor(first) : null };
    },
    poolSummary(query = {}) { fields(query, []); return snapshotSource.summary?.(store.getCryptoExposureUsage()) ?? { mode: "fixed-source", admittedWindows: null, instruments: [], note: "使用固定验证来源" }; },
    create(body) {
      fields(body, ["market", "actionId", "instrumentId", "startingCash", "leverage", "slippageBps"]);
      if (body.market !== MARKET || !["BTC-USDT-SWAP", "ETH-USDT-SWAP"].includes(body.instrumentId) || typeof body.actionId !== "string" || !body.actionId.trim() || body.actionId.length > 128) fail("INVALID_REQUEST", "请指定合约市场、BTC/ETH 和创建 actionId");
      const starting = decimal(body.startingCash ?? "10000");
      if (new D(starting).decimalPlaces() > 8) fail("INVALID_REQUEST", "起始 USDT 最多 8 位小数");
      const config = { startingCash: new D(starting).toFixed(8), leverage: decimal(body.leverage ?? "5"), slippageBps: body.slippageBps ?? 2 };
      if (![0, 2, 10].includes(config.slippageBps)) fail("INVALID_REQUEST", "只支持已冻结的 0/2/10 bps");
      const actionId = body.actionId.trim(), id = `crypto-${cryptoHash(actionId).slice(0, 32)}`;
      const request = JSON.parse(canonical({ instrumentId: body.instrumentId, config }));
      const existing = store.getSession(id);
      if (existing) return wrap(store.createCryptoSession({ session: { id }, actionId, request }));
      let source;
      try { source = snapshotSource.load(body.instrumentId, { usage: store.getCryptoExposureUsage() }); }
      catch (error) {
        // Only source acquisition is covered: no session/ledger transaction has
        // started. Errors during persistence or response rendering remain unknown.
        error.details = { ...error.details, actionOutcome: "not-committed" };
        throw error;
      }
      if (source.scenario?.instrumentId !== body.instrumentId) fail("REPLAY_SNAPSHOT_CORRUPT", "样本合约与请求不匹配", 500);
      const document = { format: "okx-crypto-session-snapshot-v1", executionVersion: CRYPTO_ORDER_EXECUTION_VERSION,
        dataVersion: source.dataVersion, dataManifestSHA256: source.dataManifestSHA256,
        rules: source.rules, scenario: source.scenario, ruleSHA256: cryptoHash(canonical(source.rules)), scenarioSHA256: cryptoHash(canonical(source.scenario)) };
      if (source.exposure && canonical(source.exposure) !== canonical(cryptoExposure(body.instrumentId, source.scenario.window))) fail("REPLAY_SNAPSHOT_CORRUPT", "场景暴露与实际窗口不一致", 500);
      const json = canonical(document), snapshotId = cryptoHash(json), engine = domain(() => createCryptoOrderReplay({ ...source, slippageBps: config.slippageBps }));
      const state = domain(() => engine.create(config));
      const snapshot = { market: MARKET, interval: "1m", instrumentId: body.instrumentId, cryptoSnapshotId: snapshotId,
        executionVersion: CRYPTO_ORDER_EXECUTION_VERSION, scenarioSHA256: document.scenarioSHA256, ruleSHA256: document.ruleSHA256,
        ...(source.exposure ? { exposure: source.exposure, poolVersion: source.poolVersion } : {}),
        config, backgroundMinutes: (source.scenario.window.replayStartMs - source.scenario.window.backgroundStartMs) / MINUTE_MS,
        totalMinutes: (source.scenario.window.executionEndMs - source.scenario.window.replayStartMs) / MINUTE_MS };
      return wrap(store.createCryptoSession({ session: { id, snapshot, state, sourceDataVersion: source.dataVersion, createdAt: now() }, snapshotDocument: { id: snapshotId, json }, actionId, request }));
    },
    get(id, query = {}) { fields(query, []); return { session: present(requireSession(id)) }; },
    command(id, body) { fields(body, ["actionId", "expectedRevision", "command", "note"]); return execute(id, body, normalizeCommand(body.command)); },
    submitOrder(id, body) {
      fields(body, ["actionId", "expectedRevision", "command", "note"]);
      if (!["market-open", "limit-open", "market-close", "limit-close"].includes(body.command?.type)) fail("INVALID_REQUEST", "orders 接口只接受合约开平委托");
      return execute(id, body, normalizeCommand(body.command));
    },
    advance(id, body) { fields(body, ["actionId", "expectedRevision", "minutes"]); return execute(id, body, normalizeCommand({ type: "advance", minutes: body.minutes ?? 1 })); },
    finish(id, body) { fields(body, ["actionId", "expectedRevision"]); return execute(id, body, { type: "finish" }); },
    saveBlindReview(id, body) {
      fields(body, ["actionId", "expectedRevision", "review"]); fields(body.review, ["thesis", "tradePlan"]);
      if ([body.review.thesis, body.review.tradePlan].some((v) => typeof v !== "string" || !v.trim() || v.length > 4000)) fail("INVALID_REQUEST", "请记录盲评判断及交易/不交易计划");
      return execute(id, body, { type: "blind-review" }, { blindReview: { thesis: body.review.thesis.trim(), tradePlan: body.review.tradePlan.trim() } });
    },
    savePostReview(id, body) {
      fields(body, ["actionId", "expectedRevision", "review"]); fields(body.review, ["observation", "executionLesson", "nextAttempt"]);
      const review = {};
      for (const key of ["observation", "executionLesson", "nextAttempt"]) {
        if (typeof body.review[key] !== "string" || !body.review[key].trim() || body.review[key].length > 4000) fail("INVALID_REQUEST", "请记录观察、执行偏差和下次行动");
        review[key] = body.review[key].trim();
      }
      return execute(id, body, { type: "post-review" }, { postReview: review });
    },
    reveal(id, body) { fields(body, ["actionId", "expectedRevision"]); return execute(id, body, { type: "reveal" }, { reveal: true }); },
    retrain(id, body) {
      fields(body, ["actionId", "expectedRevision"]); const normalized = action(body);
      return wrap(store.retrainCryptoSession({ sourceSessionId: id, id: `crypto-${cryptoHash(`${id}:${normalized.actionId}`).slice(0, 32)}`,
        ...normalized, request: { expectedRevision: normalized.expectedRevision }, createdAt: now(), initialize(source) {
          const { engine } = runtime(source); return engine.create(source.snapshot.config);
        } }));
    },
    market(id, query = {}) {
      fields(query, ["elapsedMinutes", "timeframeMinutes", "limit"]); const s = requireSession(id), value = runtime(s);
      const max = s.revealedAt ? s.gameLength : s.account.elapsedMinutes;
      const elapsed = query.elapsedMinutes == null ? max : Number(query.elapsedMinutes), timeframe = query.timeframeMinutes == null ? 5 : Number(query.timeframeMinutes);
      if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > max) fail("REPLAY_CURSOR_FORBIDDEN", "请求超出服务端已展示范围", 409);
      const limit = query.limit == null ? null : Number(query.limit);
      if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000)) fail("INVALID_REQUEST", "图表最多显示 2000 根已知 K 线");
      const view = domain(() => value.view.visibleAt({ elapsedMinutes: elapsed, timeframeMinutes: timeframe }));
      if (limit === null) return view;
      return { ...view, availableBars: view.candles.last.length, candles: Object.fromEntries(Object.entries(view.candles).map(([kind, bars]) => [kind, bars.slice(-limit)])) };
    },
    audit(id, kind, query = {}) {
      fields(query, ["after", "limit"]); const s = requireSession(id); runtime(s);
      const after = query.after == null ? (kind === "ledger" ? -1 : 0) : Number(query.after), limit = query.limit == null ? 100 : Number(query.limit);
      const max = kind === "ledger" ? s.revision : s.account.eventSequence;
      if (!Number.isSafeInteger(after) || after < (kind === "ledger" ? -1 : 0) || after > max || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail("REPLAY_CURSOR_FORBIDDEN", "账本或轨迹游标超出当前范围", 409);
      const items = (kind === "ledger" ? store.readCryptoEntries : store.readCryptoTraces)({ sessionId: id, revision: s.revision, after, limit });
      return { items, revision: s.revision, throughMinute: s.account.elapsedMinutes };
    },
  };
}
