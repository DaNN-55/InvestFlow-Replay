const STOP_EVENTS = new Set([
  'order-filled', 'order-rejected', 'funding-settled', 'protection-triggered',
  'protection-filled', 'teaching-liquidation', 'risk-triggered', 'end-filled',
  'training-ended', 'end-blocked',
]);

function transition(state, event) {
  if (state.phase === 'disposed') return state;
  switch (event) {
    case 'start':
      return state.phase === 'paused' ? { phase: 'waiting', generation: state.generation + 1 } : state;
    case 'advance':
      return { ...state, phase: 'advancing' };
    case 'settle':
      return { ...state, phase: state.phase === 'draining' ? 'paused' : 'waiting' };
    case 'pause':
      return { phase: ['advancing', 'draining'].includes(state.phase) ? 'draining' : 'paused', generation: state.generation + 1 };
    case 'stopped':
      return { phase: 'paused', generation: state.generation + 1 };
    case 'dispose':
      return { phase: 'disposed', generation: state.generation + 1 };
    default:
      throw new Error(`Unknown crypto playback event: ${event}`);
  }
}

export function createCryptoReplayPlayback({ readContext, advanceMinute, changed = () => {} }) {
  let state = { phase: 'paused', generation: 0 };
  let timer = null;
  const initial = readContext();
  let sessionId = initial.session?.id;
  let speed = initial.speed;
  const validSession = context => context.active && context.session?.id && context.session.status === 'active' && !context.session.ending;
  const canAdvance = context => validSession(context) && !context.blocked;
  const view = () => Object.freeze({ playing: ['waiting', 'advancing'].includes(state.phase),
    canStart: state.phase === 'paused' && Boolean(canAdvance(readContext())) });
  const publish = () => { if (state.phase !== 'disposed') changed(view()); };
  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function pause() {
    if (state.phase === 'disposed') return;
    clearTimer();
    state = transition(state, 'pause');
    publish();
  }
  function schedule() {
    clearTimer();
    if (state.phase !== 'waiting') return;
    const generation = state.generation;
    speed = readContext().speed;
    timer = setTimeout(() => tick(generation), 900 / speed);
  }
  async function tick(generation) {
    if (generation !== state.generation || state.phase !== 'waiting') return;
    timer = null;
    const before = readContext();
    if (!canAdvance(before) || before.session.id !== sessionId) { pause(); return; }
    const sequence = before.traces.at(-1)?.sequence ?? 0;
    const targetId = before.session.id;
    state = transition(state, 'advance');
    publish();
    let ok;
    try { ok = await advanceMinute(); } catch { ok = false; }
    if (state.phase === 'disposed') return;
    if (state.phase === 'draining') {
      state = transition(state, 'settle');
      publish();
      return;
    }
    if (generation !== state.generation) return;
    const after = readContext();
    const stopped = after.traces.some(event => event.sequence > sequence && STOP_EVENTS.has(event.type));
    if (!ok || !canAdvance(after) || after.session.id !== targetId || stopped) {
      state = transition(state, 'stopped');
      publish();
      return;
    }
    state = transition(state, 'settle');
    publish();
    schedule();
  }
  function toggle() {
    if (view().playing) { pause(); return; }
    if (!view().canStart) return;
    sessionId = readContext().session.id;
    state = transition(state, 'start');
    publish();
    schedule();
  }
  function reconcile() {
    if (state.phase === 'disposed') return;
    const context = readContext();
    const switched = context.session?.id !== sessionId;
    sessionId = context.session?.id;
    if (switched || !validSession(context) || (state.phase === 'waiting' && context.blocked)) { pause(); return; }
    // Busy during our own advance is expected. Its settled result decides whether another minute is safe.
    if (state.phase === 'waiting' && speed !== context.speed) schedule();
    publish();
  }
  function dispose() {
    clearTimer();
    state = transition(state, 'dispose');
  }
  return { get view() { return view(); }, toggle, pause, reconcile, dispose };
}
