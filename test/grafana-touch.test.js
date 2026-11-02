// Runs the shim against a fake Grafana time series panel and drives it with
// touch events. Run with `bun test`.
//
// The fake panel mimics what the shim relies on in uPlot as configured by
// Grafana's time series panel:
// - the cursor hovers the data point nearest in time (samples every SAMPLE px);
// - a single dot (.u-cursor-pt) is shown on the line nearest the cursor, and
//   only within PROX px of it (points.one + focus.prox 30);
// - drag-to-zoom: mousedown starts a selection, mousemove with zero movement
//   is ignored during a drag, mouseup zooms if the selection has a width.
import { expect, test } from 'bun:test';

const SHIM = process.env.SHIM ?? `${import.meta.dir}/../grafana-touch.user.js`;
const PROX = 30;
const SAMPLE = 10;
const PLOT = { top: 100, bottom: 400, left: 0, right: 300, height: 300, width: 300 };

// lines(x) returns the y of every line at data point x (null for no value).
async function load(lines = () => [], sample = SAMPLE) {
  const events = [];
  const zooms = [];
  const timers = new Map();
  let drag = null;

  const dot = {
    off: true, x: -10, y: -10,
    classList: { contains: (c) => c === 'u-off' && dot.off },
    getBoundingClientRect: () => (dot.off
      ? { left: 0, top: 0, width: 0, height: 0 }
      : { left: dot.x - 4, top: dot.y - 4, width: 8, height: 8 }),
  };
  const overHandlers = {};
  const over = {
    addEventListener: (type, fn) => { overHandlers[type] = fn; },
    getBoundingClientRect: () => PLOT,
    querySelectorAll: () => [dot],
    contains: (el) => el === over,
    dispatchEvent: (e) => {
      events.push(e);
      if (e.type === 'mousedown') drag = { from: e.clientX, to: e.clientX };
      if (e.type === 'mouseup' && drag) {
        if (drag.to !== drag.from) zooms.push({ from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) });
        drag = null;
      }
      if (e.type !== 'mousemove') return;
      if (drag) {
        if (e.movementX === 0 && e.movementY === 0) return; // uPlot's guard
        drag.to = e.clientX;
      }
      const sx = Math.round(e.clientX / sample) * sample;
      let best = null;
      for (const y of lines(sx)) {
        if (y !== null && (best === null || Math.abs(y - e.clientY) < Math.abs(best - e.clientY))) best = y;
      }
      dot.off = best === null || Math.abs(best - e.clientY) > PROX;
      dot.x = dot.off ? -10 : Math.round(sx); // drawn on whole pixels
      dot.y = dot.off ? -10 : best;
    },
  };

  const docHandlers = {};
  let nextTimer = 1;
  Object.assign(globalThis, {
    document: {
      body: { classList: { contains: (c) => c === 'app-grafana' } },
      documentElement: { dataset: {} },
      head: { appendChild() {} },
      createElement: () => ({}),
      querySelectorAll: () => [over],
      addEventListener: (type, fn) => { (docHandlers[type] ||= []).push(fn); },
      removeEventListener: (type, fn) => { docHandlers[type] = (docHandlers[type] || []).filter((f) => f !== fn); },
    },
    window: {},
    navigator: {},
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (f) => f(),
    MouseEvent: class { constructor(type, init) { Object.assign(this, init); this.type = type; } },
    setTimeout: (f) => { timers.set(nextTimer, f); return nextTimer++; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  await import(`${SHIM}?${Math.random()}`); // a fresh copy of the IIFE each time

  // Fingers on the screen, by id.
  const fingers = new Map();
  function dispatch(type, id, target) {
    const t = fingers.get(id);
    if (type === 'touchend' || type === 'touchcancel') fingers.delete(id);
    const e = {
      type, target, currentTarget: target, cancelable: true, prevented: false,
      preventDefault() { this.prevented = true; },
      changedTouches: [t], touches: [...fingers.values()],
    };
    // Capture listeners on the document run before the target's own.
    for (const fn of [...(docHandlers[type] || [])]) fn(e);
    if (target === over && overHandlers[type]) overHandlers[type](e);
    return e;
  }
  const touch = (id, x, y) => ({ identifier: id, clientX: x, clientY: y });

  return {
    events, zooms, dot,
    mouse: (type) => events.filter((e) => e.type === type),
    last: () => { const m = events.filter((e) => e.type === 'mousemove').at(-1); return m && { x: m.clientX, y: m.clientY }; },
    elapse: () => { const fs = [...timers.values()]; timers.clear(); fs.forEach((f) => f()); },
    down: (id, x, y, target = over) => { fingers.set(id, touch(id, x, y)); return dispatch('touchstart', id, target); },
    move: (id, x, y) => { fingers.set(id, touch(id, x, y)); return dispatch('touchmove', id, over); },
    up: (id) => dispatch('touchend', id, over),
    cancel: (id) => dispatch('touchcancel', id, over),
    elsewhere: {}, // a touch target outside the chart
  };
}

// Long-press with finger 1 at (x, y).
async function longPress(lines, x, y, sample) {
  const p = await load(lines, sample);
  p.down(1, x, y);
  p.elapse();
  return p;
}

// --- gestures ---------------------------------------------------------------

test('a plain tap is left to the browser', async () => {
  const p = await load(() => [150]);
  p.down(1, 100, 200);
  const end = p.up(1);
  expect(p.events).toEqual([]);
  expect(end.prevented).toBe(false);
});

test('a swipe scrolls: no hover, nothing prevented', async () => {
  const p = await load(() => [150]);
  p.down(1, 100, 300);
  const move = p.move(1, 100, 250);
  p.elapse(); // the long-press timer was cancelled by the swipe
  expect(p.events).toEqual([]);
  expect(move.prevented).toBe(false);
});

test('two fingers before the long-press are a pinch', async () => {
  const p = await load(() => [150]);
  p.down(1, 100, 300);
  p.down(2, 150, 300);
  p.elapse();
  expect(p.events).toEqual([]);
});

test('long-press shows the tooltip, which stays after lifting until a touch elsewhere', async () => {
  const p = await longPress(() => [150], 100, 300);
  expect(p.mouse('mouseenter')).toHaveLength(1);
  const move = p.move(1, 120, 300);
  expect(move.prevented).toBe(true); // no scrolling while hovering
  const end = p.up(1);
  expect(end.prevented).toBe(true); // no click, which would pin the tooltip
  expect(p.mouse('mouseleave')).toHaveLength(0);
  p.down(3, 10, 10, p.elsewhere);
  expect(p.mouse('mouseleave')).toHaveLength(1);
});

test('hold, tap a second finger, slide, lift: zooms to the range', async () => {
  const p = await longPress(() => [150], 100, 300);
  p.down(2, 200, 350, p.elsewhere);
  p.up(2);
  p.move(1, 160, 300);
  p.move(1, 220, 300);
  p.up(1);
  expect(p.zooms).toEqual([{ from: 100, to: 220 }]);
});

test('tapping the second finger again cancels the selection', async () => {
  const p = await longPress(() => [150], 100, 300);
  p.down(2, 200, 350, p.elsewhere);
  p.up(2);
  p.move(1, 220, 300);
  p.down(2, 200, 350, p.elsewhere); // cancel
  p.up(2);
  p.up(1);
  expect(p.zooms).toEqual([]);
});

test('an interrupted touch (touchcancel) does not zoom', async () => {
  const p = await longPress(() => [150], 100, 300);
  p.down(2, 200, 350, p.elsewhere);
  p.up(2);
  p.move(1, 220, 300);
  p.cancel(1);
  expect(p.zooms).toEqual([]);
});

// --- snapping to the top line -----------------------------------------------

test('single line, finger far below: snaps onto the line', async () => {
  const p = await longPress(() => [150], 100, 390);
  expect(p.last()).toEqual({ x: 100, y: 150 });
});

test('a line at the bottom edge is still found', async () => {
  const p = await longPress(() => [398], 100, 120);
  expect(p.last().y).toBe(398);
});

test('two lines: always the top one, even with the finger on the lower one', async () => {
  const p = await longPress(() => [180, 320], 100, 320);
  expect(p.last().y).toBe(180);
});

test('top line just out of reach of one probe, a nearer line under the next', async () => {
  // probes every 300/11 px; 133 is >30 px below the probe at 100, and 140 is
  // nearer than 133 to the next probe if the spacing is too wide
  const p = await longPress(() => [133, 140], 100, 390);
  expect(p.last().y).toBe(133);
});

test('follows whichever line is on top as lines cross', async () => {
  const p = await longPress((x) => [100 + x, 250], 50, 390); // rising line, flat line
  expect(p.last().y).toBe(150);
  p.move(1, 200, 390); // the rising line is now at 300, below the flat one
  expect(p.last().y).toBe(250);
});

test('sharp peak: the crosshair lands on the data point', async () => {
  const p = await longPress((x) => [x === 100 ? 110 : 350], 104, 390);
  expect(p.last()).toEqual({ x: 100, y: 110 });
});

test('top line has a gap here: the next line down is used', async () => {
  const p = await longPress((x) => [x === 100 ? null : 150, 300], 100, 390);
  expect(p.last().y).toBe(300);
});

test('no value at this time: follows the finger', async () => {
  const p = await longPress(() => [null], 100, 250);
  expect(p.last()).toEqual({ x: 100, y: 250 });
  const probes = p.mouse('mousemove').slice(0, -1);
  expect(probes.every((m) => m.clientY >= PLOT.top && m.clientY <= PLOT.bottom)).toBe(true);
});

// --- stress -----------------------------------------------------------------

function random(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

test.each([7, 1234, 99991])('dense spiky data (seed %i): always shown, always the top line', async (seed) => {
  // two lines sampled every 0.7 px with frequent one-sample spikes
  const rnd = random(seed);
  const cache = [new Map(), new Map()];
  const value = (i, x, base) => {
    const k = x.toFixed(3);
    if (!cache[i].has(k)) cache[i].set(k, rnd() < 0.15 ? 105 + rnd() * 60 : base + rnd() * 40);
    return cache[i].get(k);
  };
  const lines = (x) => [value(0, x, 200), value(1, x, 300)];
  const p = await longPress(lines, 150, 390, 0.7);
  let hidden = 0, offDot = 0, notTop = 0;
  for (let i = 0; i < 300; i++) {
    p.move(1, 5 + rnd() * 290, 100 + rnd() * 300);
    const at = p.last();
    if (p.dot.off) { hidden++; continue; }
    if (Math.abs(p.dot.y - at.y) > 0.5) offDot++;
    if (Math.abs(p.dot.y - Math.min(...lines(Math.round(at.x / 0.7) * 0.7))) > 0.5) notTop++;
  }
  expect({ hidden, offDot, notTop }).toEqual({ hidden: 0, offDot: 0, notTop: 0 });
});

test.each([3, 2024, 777777])('bunched lines like voltage phases (seed %i): always the top line', async (seed) => {
  const rnd = random(seed);
  let notTop = 0;
  for (let i = 0; i < 200; i++) {
    const base = 110 + rnd() * 270;
    const ys = [base, base + 1 + rnd() * 8, base + 2 + rnd() * 16];
    const p = await longPress(() => ys, 100, 100 + rnd() * 300);
    if (Math.abs(p.last().y - Math.min(...ys)) > 0.5) notTop++;
  }
  expect(notTop).toBe(0);
});
