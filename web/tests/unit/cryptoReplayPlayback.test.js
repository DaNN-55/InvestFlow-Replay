import assert from "node:assert/strict";
import test from "node:test";
import { createCryptoReplayPlayback } from "../../src/utils/cryptoReplayPlayback.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function setup(t, advance = async () => true) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const context = { session: { id: "A", status: "active", ending: false }, traces: [], speed: 1, active: true, blocked: false };
  const calls = [], changes = [];
  const playback = createCryptoReplayPlayback({ readContext: () => context,
    advanceMinute: async () => { calls.push(context.session.id); return advance(context); },
    changed: value => changes.push(value),
  });
  t.after(() => playback.dispose());
  const tick = async ms => { t.mock.timers.tick(ms); await flush(); };
  return { playback, context, calls, changes, tick };
}

test("waits 900/speed after each settled minute and never overlaps requests", async t => {
  const request = deferred();
  const { playback, calls, tick } = setup(t, () => request.promise);
  playback.toggle(); await tick(899); assert.equal(calls.length, 0);
  await tick(1); assert.equal(calls.length, 1);
  await tick(9000); assert.equal(calls.length, 1);
  request.resolve(true); await flush();
  await tick(899); assert.equal(calls.length, 1);
  await tick(1); assert.equal(calls.length, 2);
});

test("waiting speed changes replace the timer while in-flight speed changes affect only the next wait", async t => {
  const request = deferred();
  const { playback, context, calls, tick } = setup(t, () => request.promise);
  playback.toggle(); await tick(800);
  context.speed = 4; playback.reconcile();
  await tick(224); assert.equal(calls.length, 0);
  await tick(1); assert.equal(calls.length, 1);
  context.speed = 2; playback.reconcile();
  await tick(5000); assert.equal(calls.length, 1);
  request.resolve(true); await flush();
  await tick(449); assert.equal(calls.length, 1);
  await tick(1); assert.equal(calls.length, 2);
});

test("pausing an in-flight minute rejects restart until it drains and never resumes from its late result", async t => {
  const request = deferred();
  const { playback, calls, tick } = setup(t, () => request.promise);
  playback.toggle(); await tick(900);
  playback.pause();
  assert.deepEqual(playback.view, { playing: false, canStart: false });
  playback.toggle(); await tick(9000); assert.equal(calls.length, 1);
  request.resolve(true); await flush();
  assert.deepEqual(playback.view, { playing: false, canStart: true });
  await tick(9000); assert.equal(calls.length, 1);
  playback.toggle(); await tick(900); assert.equal(calls.length, 2);
});

test("own advance busy does not interrupt playback, but a blocked settled result pauses", async t => {
  const request = deferred();
  let attempts = 0;
  const { playback, context, calls, tick } = setup(t, ctx => {
    if (++attempts === 1) return request.promise;
    ctx.blocked = true; return true;
  });
  playback.toggle(); await tick(900);
  context.blocked = true; playback.reconcile(); assert.equal(playback.view.playing, true);
  context.blocked = false; playback.reconcile();
  request.resolve(true); await flush();
  await tick(900); assert.equal(calls.length, 2);
  assert.equal(playback.view.playing, false);
});

for (const type of ["order-filled", "order-rejected", "funding-settled", "protection-triggered", "protection-filled", "teaching-liquidation", "risk-triggered", "end-filled", "training-ended", "end-blocked"]) {
  test(`pauses only for a new ${type} trace`, async t => {
    const { playback, context, calls, tick } = setup(t, ctx => { ctx.traces = [...ctx.traces, { sequence: 2, type }]; return true; });
    context.traces = [{ sequence: 1, type }];
    playback.toggle(); assert.equal(playback.view.playing, true);
    await tick(900); assert.equal(playback.view.playing, false);
    await tick(9000); assert.equal(calls.length, 1);
    playback.toggle(); await tick(900); assert.equal(playback.view.playing, true);
  });
}

for (const outcome of ["false", "throw"]) test(`a ${outcome} advance pauses and releases its in-flight state`, async t => {
  const { playback, calls, tick } = setup(t, async () => { if (outcome === "throw") throw new Error("unexpected failure"); return false; });
  playback.toggle(); await tick(900);
  assert.deepEqual(playback.view, { playing: false, canStart: true });
  await tick(9000); assert.equal(calls.length, 1);
});

for (const change of ["session", "leave", "dispose"]) test(`${change} invalidates a late result without creating another timer`, async t => {
  const request = deferred();
  const { playback, context, calls, changes, tick } = setup(t, () => request.promise);
  playback.toggle(); await tick(900);
  if (change === "session") {
    context.session = { ...context.session, id: "B" }; playback.reconcile();
    context.session = { ...context.session, id: "A" }; playback.reconcile();
  } else if (change === "leave") {
    context.active = false; playback.reconcile(); context.active = true; playback.reconcile();
  } else playback.dispose();
  const published = changes.length;
  request.resolve(true); await flush(); await tick(9000);
  assert.equal(playback.view.playing, false); assert.equal(calls.length, 1);
  if (change === "dispose") { playback.toggle(); playback.reconcile(); assert.equal(changes.length, published); assert.equal(playback.view.canStart, false); }
});

test("pause clears a waiting timer and blocked/completed/ending contexts cannot start", async t => {
  const { playback, context, calls, tick } = setup(t);
  playback.toggle(); playback.pause(); await tick(9000); assert.equal(calls.length, 0);
  for (const update of [{ blocked: true }, { active: false }, { session: null },
    { session: { id: "A", status: "completed" } }, { session: { id: "A", status: "active", ending: true } }]) {
    Object.assign(context, { session: { id: "A", status: "active" }, active: true, blocked: false }, update);
    playback.reconcile(); playback.toggle(); assert.equal(playback.view.playing, false);
  }
});
