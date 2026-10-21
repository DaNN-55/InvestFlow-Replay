// Pure reconstruction of objective training-condition events.
//
// This module deliberately does not inspect reviews, drafts, or corrections.
// It only uses frozen bars, submitted orders, and persisted execution facts.

const BAR_ORDER_MODELS = new Set(["bar-orders-v1", "bar-orders-v2"]);

const asNumber = (value, fallback = null) => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const parseJson = (value, fallback = null) => {
  if (value == null || typeof value === "object") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const firstFinite = (...values) => values.find((value) => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return false;
  return Number.isFinite(Number(value));
}) ?? null;

const closeTimeValue = (value) => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const numeric = asNumber(value);
  if (numeric != null) return numeric;
  const match = String(value).match(/(?:T|\s)(\d{1,2}):(\d{2})(?::\d{2})?/);
  return match ? Number(match[1]) * 100 + Number(match[2]) : null;
};

function normalizeOrder(record, index) {
  const input = record ?? {};
  const state = parseJson(input.state ?? input.execution_json, {}) ?? {};
  const decision = parseJson(input.decision ?? input.decision_json ?? state.decision, {}) ?? {};
  const id = String(input.id ?? input.orderId ?? input.order_id ?? `order-${index + 1}`);
  const fills = [];

  const addFill = (fill) => {
    if (!fill) return;
    const sequence = asNumber(fill.sequence ?? fill.fillSequence);
    const quantity = asNumber(fill.quantity ?? fill.filledQuantity, 0);
    if (sequence == null || quantity <= 0) return;
    fills.push({
      sequence,
      quantity,
      side: String(fill.side ?? input.side ?? "").toLowerCase(),
      price: firstFinite(fill.price, fill.referencePrice, fill.reference_price),
    });
  };

  for (const fill of input.fills ?? input.executions ?? []) addFill(fill);
  if (String(input.status ?? "").toLowerCase() === "filled") addFill(input);
  if (input.fill) addFill(input.fill);

  return {
    id,
    side: String(input.side ?? state.side ?? "").toLowerCase(),
    decision,
    submittedSequence: firstFinite(input.submittedSequence, input.submitted_sequence),
    scheduledSequence: firstFinite(input.scheduledSequence, input.scheduled_sequence),
    orderType: String(input.orderType ?? state.orderType ?? "market").toLowerCase(),
    sourceOrderId: input.sourceOrderId ?? input.source_order_id ?? state.sourceOrderId ?? null,
    state,
    fills,
    triggeredSequence: firstFinite(input.triggeredSequence, state.triggeredSequence),
    triggerPrice: firstFinite(input.triggerPrice, state.triggerPrice),
    stopPrice: firstFinite(input.stopPrice, state.stopPrice),
  };
}

function buildOrders(inputOrders, session) {
  const source = Array.isArray(inputOrders)
    ? inputOrders
    : Array.isArray(session?.orders)
      ? session.orders
      : [
          ...(session?.pendingOrders ?? []),
          ...(session?.executions ?? []),
        ];
  const byId = new Map();
  source.forEach((record, index) => {
    const order = normalizeOrder(record, index);
    const previous = byId.get(order.id);
    if (!previous) {
      byId.set(order.id, order);
      return;
    }
    if (previous.submittedSequence == null) previous.submittedSequence = order.submittedSequence;
    if (!previous.decision || Object.keys(previous.decision).length === 0) previous.decision = order.decision;
    if (!previous.sourceOrderId) previous.sourceOrderId = order.sourceOrderId;
    previous.fills.push(...order.fills);
    if (previous.triggeredSequence == null) previous.triggeredSequence = order.triggeredSequence;
    if (previous.triggerPrice == null) previous.triggerPrice = order.triggerPrice;
    if (previous.stopPrice == null) previous.stopPrice = order.stopPrice;
    if (previous.orderType === "market" && order.orderType !== "market") previous.orderType = order.orderType;
  });

  // A hydrated session normally exposes executions separately from its order
  // rows. Attach those fills without allowing a later execution row to replace
  // the order's frozen decision or state.
  for (const execution of session?.executions ?? []) {
    const id = String(execution.orderId ?? execution.order_id ?? "");
    const order = byId.get(id);
    if (!order) {
      const created = normalizeOrder(execution, byId.size);
      byId.set(created.id, created);
    } else {
      const before = order.fills.length;
      normalizeOrder(execution, 0).fills.forEach((fill) => {
        if (!order.fills.some((existing) => existing.sequence === fill.sequence && existing.quantity === fill.quantity)) {
          order.fills.push(fill);
        }
      });
      if (before === order.fills.length && order.fills.length === 0 && execution.status === "filled") {
        order.fills.push(...normalizeOrder(execution, 0).fills);
      }
    }
  }
  for (const order of byId.values()) {
    order.fills.sort((left, right) => left.sequence - right.sequence);
  }
  return [...byId.values()];
}

function executionBars(session) {
  if (Array.isArray(session?.observationBars)) return session.observationBars;
  if (Array.isArray(session?.snapshot?.bars)) return session.snapshot.bars;
  if (Array.isArray(session?.bars)) return session.bars;
  return [];
}

function isCompleteDailyClose({ bars, sequence, interval, throughSequence }) {
  if (interval === "1d") return true;
  if (interval !== "hybrid") return false;
  const bar = bars[sequence - 1];
  if (!bar) return false;
  const next = bars[sequence];
  if (next) return String(next.tradeDate ?? "") !== String(bar.tradeDate ?? "");
  // A truncated replay can end in the middle of a trading day. The sequence
  // boundary alone is not evidence of a daily close.
  return (closeTimeValue(bar.tradeTime ?? bar.time) ?? 0) >= 1455;
}

function eventKey({ kind, orderId, sequence, ruleStartSequence }) {
  return `${kind}:${orderId}:${sequence}:${ruleStartSequence}`;
}

/**
 * Detect objective stop-touch and invalidation-at-close events.
 *
 * `orders` accepts replay order rows, normalized order objects, or the
 * `pendingOrders`/`executions` shape returned by the database reader.
 */
export function detectTrainingConditionEvents({
  session,
  orders: inputOrders,
  throughSequence: requestedThroughSequence,
  fromSequence: requestedFromSequence,
} = {}) {
  const bars = executionBars(session);
  const observationBars = asNumber(session?.observationBars, 0) ?? 0;
  const actualCompletion = firstFinite(
    session?.actualCompletion,
    session?.completionSequence,
    (observationBars + (
      asNumber(session?.revealedFutureBars)
      ?? (String(session?.status ?? "") === "completed" ? asNumber(session?.gameLength, 0) : 0)
    )),
  ) ?? bars.length;
  const throughSequence = Math.max(0, Math.min(
    bars.length,
    firstFinite(requestedThroughSequence, actualCompletion) ?? actualCompletion,
  ));
  const fromSequence = Math.max(
    observationBars + 1,
    firstFinite(requestedFromSequence, observationBars + 1) ?? observationBars + 1,
  );
  if (throughSequence < fromSequence || bars.length === 0) return [];

  const normalizedOrders = buildOrders(inputOrders, session);
  const fills = [];
  for (const order of normalizedOrders) {
    for (const fill of order.fills) {
      const side = fill.side || order.side;
      if (!["buy", "sell"].includes(side)) continue;
      fills.push({ ...fill, side, orderId: order.id });
    }
  }
  fills.sort((left, right) => left.sequence - right.sequence || left.orderId.localeCompare(right.orderId));
  const fillsBySequence = new Map();
  for (const fill of fills) {
    const values = fillsBySequence.get(fill.sequence) ?? [];
    values.push(fill);
    fillsBySequence.set(fill.sequence, values);
  }

  const positionBefore = new Map();
  const positionAfter = new Map();
  let position = 0;
  for (let sequence = 1; sequence <= throughSequence; sequence += 1) {
    positionBefore.set(sequence, position);
    for (const fill of fillsBySequence.get(sequence) ?? []) {
      position += fill.side === "buy" ? fill.quantity : -fill.quantity;
    }
    position = Math.max(0, position);
    positionAfter.set(sequence, position);
  }
  const positionAt = (sequence) => positionAfter.get(sequence) ?? position;
  const interval = String(session?.snapshot?.interval ?? session?.interval ?? "1d");
  const events = new Map();
  const addEvent = (event) => {
    if (event.sequence < fromSequence || event.sequence > throughSequence) return;
    events.set(event.key, event);
  };

  const buyOrders = normalizedOrders
    .filter((order) => order.side === "buy" && order.fills.some((fill) => fill.quantity > 0))
    .map((order) => ({
      order,
      firstFillSequence: Math.min(...order.fills.filter((fill) => fill.quantity > 0).map((fill) => fill.sequence)),
    }))
    .sort((left, right) =>
      (left.order.submittedSequence ?? left.firstFillSequence) - (right.order.submittedSequence ?? right.firstFillSequence)
      || left.firstFillSequence - right.firstFillSequence
      || left.order.id.localeCompare(right.order.id));
  const buyById = new Map(buyOrders.map(({ order }) => [order.id, order]));

  // In bar-orders mode the executor's persisted trigger is authoritative. A
  // stop that was never submitted or never triggered is not inferred from OHLC.
  for (const stop of normalizedOrders.filter((order) =>
    order.side === "sell" && order.orderType === "stop" && order.triggeredSequence != null,
  )) {
    const sequence = stop.triggeredSequence;
    // `readReplayOrders()` intentionally exposes a compact execution view and
    // older rows do not carry sourceOrderId. In that view the latest filled
    // buy before the trigger is the only eligible parent; an unfilled buy is
    // therefore never enough to manufacture an opportunity.
    const fallbackParent = buyOrders
      .filter(({ firstFillSequence }) => firstFillSequence <= sequence)
      .at(-1)?.order ?? null;
    const parent = stop.sourceOrderId
      ? buyById.get(String(stop.sourceOrderId))
      : fallbackParent;
    const parentFills = parent?.fills.filter((fill) => fill.quantity > 0) ?? [];
    const ruleStartSequence = parentFills.length
      ? Math.min(...parentFills.map((fill) => fill.sequence))
      : firstFinite(stop.submittedSequence, sequence);
    const hasPosition = (positionBefore.get(sequence) ?? 0) > 0 || (positionAfter.get(sequence) ?? 0) > 0;
    const parentFilled = parentFills.some((fill) => fill.sequence <= sequence);
    if (!hasPosition || !parentFilled) continue;
    const bar = bars[sequence - 1];
    const price = firstFinite(stop.triggerPrice, bar?.low, stop.stopPrice);
    const threshold = firstFinite(stop.stopPrice, stop.state?.stopPrice, stop.decision?.stopLossPrice);
    if (price == null || threshold == null) continue;
    const id = eventKey({ kind: "stop_touch", orderId: stop.id, sequence, ruleStartSequence });
    addEvent({
      key: id,
      kind: "stop_touch",
      orderId: stop.id,
      sequence,
      ruleStartSequence,
      basis: "touch",
      operator: "lte",
      threshold,
      price,
      source: "execution",
      automatic: true,
    });
  }

  // Legacy orders have no persisted protection order. Evaluate the latest
  // submitted plan that has actually filled, beginning on the next bar.
  if (!BAR_ORDER_MODELS.has(String(session?.executionModelVersion ?? ""))) {
    const touchedPlans = new Set();
    for (let sequence = observationBars + 1; sequence <= throughSequence; sequence += 1) {
      if (positionAt(sequence) <= 0) continue;
      const active = buyOrders
        .filter(({ firstFillSequence }) => firstFillSequence < sequence)
        .at(-1);
      if (!active) continue;
      const { order, firstFillSequence } = active;
      const stopThreshold = asNumber(order.decision?.stopLossPrice);
      if (stopThreshold != null && stopThreshold > 0 && !touchedPlans.has(`stop:${order.id}`)) {
        const bar = bars[sequence - 1];
        const low = asNumber(bar?.low);
        if (low != null && low <= stopThreshold) {
          const id = eventKey({ kind: "stop_touch", orderId: order.id, sequence, ruleStartSequence: firstFillSequence });
          addEvent({
            key: id,
            kind: "stop_touch",
            orderId: order.id,
            sequence,
            ruleStartSequence: firstFillSequence,
            basis: "touch",
            operator: "lte",
            threshold: stopThreshold,
            price: low,
            source: "frozen_decision",
            automatic: false,
          });
          touchedPlans.add(`stop:${order.id}`);
        }
      }
    }
  }

  // Invalidation conditions are evaluated on complete daily closes. This loop
  // deliberately selects the latest filled plan for each bar so an unfilled
  // replacement cannot overwrite an earlier active rule.
  const invalidatedPlans = new Set();
  for (let sequence = observationBars + 1; sequence <= throughSequence; sequence += 1) {
    if (positionAt(sequence) <= 0 || !isCompleteDailyClose({ bars, sequence, interval, throughSequence })) continue;
    const active = buyOrders.filter(({ firstFillSequence }) => firstFillSequence <= sequence).at(-1);
    if (!active) continue;
    const { order, firstFillSequence } = active;
    const rule = order.decision?.invalidationRule;
    if (rule?.basis !== "close") continue;
    const threshold = asNumber(rule?.threshold);
    const operator = rule?.operator === "gte" ? "gte" : rule?.operator === "lte" ? "lte" : null;
    if (threshold == null || threshold <= 0 || !operator || invalidatedPlans.has(`invalidation:${order.id}`)) continue;
    const price = asNumber(bars[sequence - 1]?.close);
    if (price == null) continue;
    const touched = operator === "lte" ? price <= threshold : price >= threshold;
    if (!touched) continue;
    const id = eventKey({ kind: "invalidation_close", orderId: order.id, sequence, ruleStartSequence: firstFillSequence });
    addEvent({
      key: id,
      kind: "invalidation_close",
      orderId: order.id,
      sequence,
      ruleStartSequence: firstFillSequence,
      basis: "day_close",
      operator,
      threshold,
      price,
      source: "frozen_decision",
      automatic: false,
    });
    invalidatedPlans.add(`invalidation:${order.id}`);
  }

  return [...events.values()].sort((left, right) => left.sequence - right.sequence || left.kind.localeCompare(right.kind) || left.orderId.localeCompare(right.orderId));
}

export default detectTrainingConditionEvents;
