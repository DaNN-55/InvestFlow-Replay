const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
const running = new Set();
const elementAnimations = new WeakMap();
const snapshots = new WeakMap();

function cancelMotion() {
  for (const animation of running) animation.cancel();
}
preference.addEventListener('change', cancelMotion);
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelMotion(); });

function animate(element, frames, duration, name) {
  elementAnimations.get(element)?.cancel();
  if (preference.matches || document.hidden || !element.isConnected || !element.getClientRects().length) return;
  const animation = element.animate(frames, { duration, easing: 'cubic-bezier(.23,1,.32,1)' });
  animation.id = name;
  elementAnimations.set(element, animation);
  running.add(animation);
  const cleanup = () => { running.delete(animation); };
  animation.finished.then(cleanup, cleanup);
  return animation;
}

function enter(element, kind = 'fade') {
  const frames = kind === 'phase'
    ? [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }]
    : [{ opacity: 0 }, { opacity: 1 }];
  const duration = { phase: 170, detail: 120, surface: 160 }[kind] ?? 150;
  animate(element, frames, duration, `ql-motion-${kind}`);
}

export function fadeMotionElement(element) { enter(element, 'surface'); }

function highlight(element) {
  const styles = getComputedStyle(element);
  animate(element, [
    { backgroundColor: styles.getPropertyValue('--ql-color-primary-soft') },
    { backgroundColor: styles.backgroundColor },
  ], 650, 'ql-motion-feedback');
}

function dispose(element) {
  elementAnimations.get(element)?.cancel();
  snapshots.delete(element);
}

// Mount-only entry for newly opened surfaces, never live quote values.
export const vMotionEnter = {
  mounted(element, { value }) { if (value !== false) enter(element, value); },
  beforeUnmount: dispose,
};

// A scoped state change preserves the actual form nodes, focus and selection.
export const vMotionChange = {
  mounted(element, { value }) { snapshots.set(element, value); },
  updated(element, { value }) {
    const previous = snapshots.get(element);
    snapshots.set(element, value);
    if (previous?.scope === value.scope && previous.key !== value.key && value.key) {
      if (value.kind === 'feedback') highlight(element);
      else enter(element, value.kind);
    }
  },
  beforeUnmount: dispose,
};

// The initial/restored list and changing tabs establish a baseline. Only a new
// event in the same scope highlights its row; existing rows never move.
export const vMotionList = {
  mounted(element, { value }) { snapshots.set(element, { scope: value.scope, keys: new Set(value.keys) }); },
  updated(element, { value }) {
    const previous = snapshots.get(element);
    const keys = new Set(value.keys);
    snapshots.set(element, { scope: value.scope, keys });
    if (previous?.scope !== value.scope) return;
    if (value.keys.every(key => previous.keys.has(key))) return;
    for (const row of element.querySelectorAll('[data-motion-key]')) {
      if (!previous.keys.has(row.dataset.motionKey) && keys.has(row.dataset.motionKey)) highlight(row);
    }
  },
  beforeUnmount(element) {
    element.querySelectorAll('[data-motion-key]').forEach(dispose);
    dispose(element);
  },
};

const disclosures = new WeakMap();

// Keep native details/summary semantics. Closing content is inert immediately;
// the native open attribute is released when its visual exit finishes.
export const vMotionDisclosure = {
  mounted(element, { value = 'long' }) {
    const summary = element.querySelector(':scope > summary');
    const content = () => Array.from(element.children).filter(child => child !== summary);
    const state = { open: element.open, generation: 0, animations: [] };
    element.classList.add('ql-motion-disclosure');
    element.dataset.motionOpen = String(state.open);
    const setOpen = open => {
      state.open = open;
      const generation = ++state.generation;
      const bodies = content();
      element.dataset.motionOpen = String(open);
      summary.setAttribute('aria-expanded', String(open));
      const startHeight = element.getBoundingClientRect().height;
      if (open) element.open = true;
      const mode = value === 'auto' ? (bodies.length === 1 && bodies[0].scrollHeight <= 240 ? 'short' : 'long') : value;
      bodies.forEach(body => {
        body.inert = !open;
        if (!open && body.contains(document.activeElement)) summary.focus();
      });
      if (mode === 'short') {
        const styles = getComputedStyle(element);
        const summaryStyles = getComputedStyle(summary);
        const closedHeight = summary.getBoundingClientRect().bottom - element.getBoundingClientRect().top + parseFloat(summaryStyles.marginBottom) + parseFloat(styles.paddingBottom) + parseFloat(styles.borderBottomWidth);
        const fullHeight = element.scrollHeight + parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
        element.style.overflow = 'hidden';
        state.animations = [animate(element, [{ height: `${startHeight}px` }, { height: `${open ? fullHeight : closedHeight}px` }], open ? 200 : 160, 'ql-motion-disclosure-short')].filter(Boolean);
      } else state.animations = bodies.map(body => {
        const styles = getComputedStyle(body);
        const frames = mode === 'popover'
            ? [{ opacity: open ? 0 : styles.opacity, transform: open ? 'translateY(-4px)' : styles.transform }, { opacity: open ? 1 : 0, transform: open ? 'none' : 'translateY(-4px)' }]
            : [{ opacity: open ? 0 : styles.opacity }, { opacity: open ? 1 : 0 }];
        return animate(body, frames, mode === 'popover' ? (open ? 160 : 150) : (open ? 130 : 120), `ql-motion-disclosure-${mode}`);
      }).filter(Boolean);
      const finish = () => {
        if (state.generation !== generation) return;
        element.open = open;
        element.style.removeProperty('overflow');
        state.animations = [];
      };
      if (!state.animations.length) finish();
      else Promise.allSettled(state.animations.map(animation => animation.finished)).then(finish);
    };
    const click = event => {
      if (event.defaultPrevented || event.target.closest('summary') !== summary || event.target.closest('button,a,input,select,label')) return;
      event.preventDefault();
      setOpen(!state.open);
    };
    const toggle = () => {
      if (element.open === state.open || (state.animations.length && element.open)) return;
      state.generation++;
      state.animations.forEach(animation => animation.cancel());
      state.open = element.open;
      element.dataset.motionOpen = String(state.open);
      summary.setAttribute('aria-expanded', String(state.open));
      element.style.removeProperty('overflow');
      content().forEach(body => { body.inert = !state.open; });
    };
    element.addEventListener('click', click);
    element.addEventListener('toggle', toggle);
    disclosures.set(element, () => {
      state.generation++;
      state.animations.forEach(animation => animation.cancel());
      element.removeEventListener('click', click);
      element.removeEventListener('toggle', toggle);
    });
  },
  beforeUnmount(element) { disclosures.get(element)?.(); disclosures.delete(element); },
};

const tabIndicators = new WeakMap();
export const vMotionTabs = {
  mounted(element) {
    const indicator = document.createElement('span');
    indicator.className = 'ql-motion-tab-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    element.classList.add('ql-motion-tabs');
    element.append(indicator);
    const measure = () => {
      const active = element.querySelector('[data-motion-active="true"]');
      if (!active || !element.getClientRects().length) return;
      const host = element.getBoundingClientRect(), target = active.getBoundingClientRect();
      indicator.style.width = `${target.width}px`;
      indicator.style.transform = `translate(${target.left - host.left + element.scrollLeft}px, ${target.bottom - host.top + element.scrollTop - 2}px)`;
    };
    measure();
    const frame = requestAnimationFrame(() => { indicator.dataset.ready = 'true'; });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.querySelectorAll(':scope > button').forEach(button => observer.observe(button));
    tabIndicators.set(element, { measure, cleanup() { cancelAnimationFrame(frame); observer.disconnect(); indicator.remove(); } });
  },
  updated(element, { value, oldValue }) { if (value !== oldValue) tabIndicators.get(element)?.measure(); },
  beforeUnmount(element) { tabIndicators.get(element)?.cleanup(); tabIndicators.delete(element); },
};
