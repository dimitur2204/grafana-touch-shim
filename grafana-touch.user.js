// ==UserScript==
// @name         Grafana touch shim
// @namespace    grafana-touch-shim
// @version      0.2.1
// @description  Long-press for tooltips and hold-and-tap to zoom on Grafana time series panels.
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// Grafana's time series panels are drawn by uPlot, whose overlay element
// (.u-over) only understands mouse events. This shim turns touch gestures
// into those mouse events:
//
//   one-finger swipe               -> untouched, the page scrolls as usual
//   two fingers at once            -> untouched, the page pinch-zooms as usual
//   long-press (300 ms), drag      -> mouseenter + mousemove: crosshair/tooltip
//                                     follows the finger and stays after lifting
//   while holding, tap a second    -> mousedown at the crosshair: marks the start
//     finger anywhere                 of a time range
//   keep dragging the first finger -> mousemove: uPlot draws the selection
//   lift the first finger          -> mouseup: zoom to the selection
//   tap the second finger again    -> cancel the selection, back to hover
//
// One finger does all the positioning; the second finger is only a button, so
// its position and jitter never matter.
//
// The same file works as a Tampermonkey/Userscripts userscript and as a
// <script> injected by a reverse proxy (see proxy/).
(function () {
  'use strict';
  // @match covers every site so it works on any Grafana host; do nothing
  // unless this page is Grafana.
  if (!document.body.classList.contains('app-grafana')) return;
  // Marked on the DOM, not window: a userscript and a proxy-injected copy run
  // in different JS contexts but share the document.
  if (document.documentElement.dataset.grafanaTouchShim) return;
  document.documentElement.dataset.grafanaTouchShim = '1';

  const LONG_PRESS_MS = 300;
  const MOVE_TOLERANCE = 10; // px a finger may drift before the press counts as a scroll
  const TOUCH_EVENTS = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];

  // Keep long-press from selecting text or opening the iOS callout on charts.
  const style = document.createElement('style');
  style.textContent = '.u-over{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}';
  document.head.appendChild(style);

  // The gesture in progress, or null when no finger is down on a chart.
  // mode: 'pending' (waiting for long-press) | 'hover' | 'select' | 'browser' | 'done'
  let g = null;
  // Overlay whose tooltip is still showing after the finger lifted.
  let lingering = null;

  // Position of the last synthetic event, for movementX/Y. uPlot ignores
  // mousemove during a drag when both are 0 (its guard against Chrome's
  // spurious mousemoves), and synthetic events default to 0.
  let lastX = 0;
  let lastY = 0;

  function fire(over, type, x, y, buttons) {
    const movementX = x - lastX;
    const movementY = y - lastY;
    lastX = x;
    lastY = y;
    over.dispatchEvent(new MouseEvent(type, {
      movementX: movementX,
      movementY: movementY,
      bubbles: type !== 'mouseenter' && type !== 'mouseleave',
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: buttons,
    }));
  }

  function findTouch(list, id) {
    return Array.prototype.find.call(list, (t) => t.identifier === id) || null;
  }

  function buzz() {
    if (navigator.vibrate) navigator.vibrate(15); // Android only; iOS ignores it
  }

  function hideLingering() {
    if (lingering) fire(lingering, 'mouseleave', 0, 0, 0);
    lingering = null;
  }

  function startHover() {
    g.mode = 'hover';
    fire(g.over, 'mouseenter', g.x, g.y, 0);
    fire(g.over, 'mousemove', g.x, g.y, 0);
  }

  // Mark the start of the range at the crosshair. The y of every drag event is
  // pinned to this point so uPlot sees a purely horizontal (time) selection.
  function startSelect() {
    g.mode = 'select';
    g.markX = g.x;
    g.markY = g.y;
    fire(g.over, 'mousedown', g.markX, g.markY, 1);
    buzz();
  }

  // Shrink the selection back to the mark, then release: uPlot only zooms on
  // a selection with a width, and it sizes the selection on mousemove.
  function cancelSelect() {
    if (g.x !== g.markX) fire(g.over, 'mousemove', g.markX, g.markY, 1);
    fire(g.over, 'mouseup', g.markX, g.markY, 0);
    g.mode = 'hover';
    fire(g.over, 'mousemove', g.x, g.y, 0);
    buzz();
  }

  // Entry point: a finger lands on a chart overlay.
  function onOverTouchStart(e) {
    if (g) return; // later fingers are handled by the document listeners
    const over = e.currentTarget;
    if (lingering !== over) hideLingering();
    const t = e.changedTouches[0];
    g = { over: over, id: t.identifier, x: t.clientX, y: t.clientY, x0: t.clientX, y0: t.clientY, mode: 'pending' };
    // Two fingers landing together are a pinch: leave it to the browser.
    if (e.touches.length > 1) g.mode = 'browser';
    else g.timer = setTimeout(startHover, LONG_PRESS_MS);
    // Follow the rest of the gesture on the document, since the second finger
    // may land outside the overlay.
    for (const type of TOUCH_EVENTS) {
      document.addEventListener(type, onDocTouch, { capture: true, passive: false });
    }
  }

  function onDocTouch(e) {
    if (e.type === 'touchstart') {
      if (g.mode === 'pending') {
        clearTimeout(g.timer);
        g.mode = 'browser'; // second finger before the long-press: a pinch
      } else if (g.mode === 'hover') {
        e.preventDefault();
        startSelect();
      } else if (g.mode === 'select') {
        e.preventDefault();
        cancelSelect();
      }
      return;
    }

    if (e.type === 'touchmove') {
      const t = findTouch(e.touches, g.id);
      if (g.mode === 'pending') {
        if (!t) return;
        g.x = t.clientX;
        g.y = t.clientY;
        if (Math.hypot(g.x - g.x0, g.y - g.y0) > MOVE_TOLERANCE) {
          clearTimeout(g.timer);
          g.mode = 'browser'; // a normal swipe
        }
      } else if (g.mode === 'hover' || g.mode === 'select') {
        e.preventDefault();
        if (!t) return; // only the second finger moved: ignore it
        g.x = t.clientX;
        g.y = t.clientY;
        if (g.mode === 'hover') fire(g.over, 'mousemove', g.x, g.y, 0);
        else fire(g.over, 'mousemove', g.x, g.markY, 1);
      } else if (g.mode === 'done') {
        e.preventDefault();
      }
      return;
    }

    // touchend / touchcancel. Only the first finger lifting ends the gesture;
    // the second finger coming up is just the end of a tap.
    const firstLifted = findTouch(e.changedTouches, g.id) !== null;
    if (firstLifted) {
      if (g.mode === 'select') {
        // A cancelled touch (e.g. an incoming call) must not zoom.
        if (e.type === 'touchcancel' && g.x !== g.markX) fire(g.over, 'mousemove', g.markX, g.markY, 1);
        fire(g.over, 'mouseup', e.type === 'touchcancel' ? g.markX : g.x, g.markY, 0);
        g.mode = 'done';
        g.suppressClick = true;
      } else if (g.mode === 'hover') {
        lingering = g.over;
        g.mode = 'done';
        g.suppressClick = true;
      } else if (g.mode === 'pending') {
        clearTimeout(g.timer);
        g.mode = 'done'; // a plain tap: let the browser turn it into a click
      }
    }
    // Stop the browser's compatibility mouse events and click, which would
    // otherwise pin Grafana's tooltip or start another drag.
    if ((g.suppressClick || g.mode === 'hover' || g.mode === 'select') && e.cancelable) e.preventDefault();

    if (e.touches.length === 0) {
      clearTimeout(g.timer);
      for (const type of TOUCH_EVENTS) {
        document.removeEventListener(type, onDocTouch, { capture: true });
      }
      g = null;
    }
  }

  // Android opens a context menu on long-press; not wanted mid-gesture.
  function onContextMenu(e) {
    if (g) e.preventDefault();
  }

  // Touching anywhere outside the chart hides a lingering tooltip.
  document.addEventListener('touchstart', (e) => {
    if (lingering && !lingering.contains(e.target)) hideLingering();
  }, { capture: true, passive: true });

  // Panels mount and remount as you scroll and switch dashboards, so attach
  // to every new overlay. Scans are batched to at most one per frame.
  const attached = new WeakSet();
  function scan() {
    for (const over of document.querySelectorAll('.u-over')) {
      if (attached.has(over)) continue;
      attached.add(over);
      over.addEventListener('touchstart', onOverTouchStart, { passive: false });
      over.addEventListener('contextmenu', onContextMenu);
    }
  }
  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan();
    });
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
