// Touch gestures for the Lite image view (OD-2.23): one finger pans (or drives the active tool),
// two fingers pinch-zoom, rotate and pan together, a double tap zooms in, a long press gives the
// point readout and its actions. They sit in front of the shared image panel (shell/pane.js): a
// capture-phase listener on the view decides what each pointer is, and hands single taps and drags
// on to the panel unchanged, so every tool works as in Full. Mouse and pen go straight through.
//
// The maths are pure functions (unit-tested in tests/unit/mobile-gestures.test.js).

import { invertView, screenToImageDelta } from '../render/renderer.js';

/** Slop (px) before a touch counts as a drag; long press (ms); double-tap window (ms, px). */
export const SLOP = 10;
export const LONG_MS = 550;
export const DOUBLE_MS = 320;
export const DOUBLE_PX = 36;
/** Rotation starts only after the fingers turn this far (radians, 12°), so a pinch does not tilt the image. */
export const ROT_THRESHOLD = (12 * Math.PI) / 180;

const ZMIN = 1 / 4096;
const ZMAX = 32;

/** Wrap an angle to (−π, π]. */
export function wrapAngle(a) {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  if (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

/** {centroid, distance, angle} of two screen points. */
export function pairOf(a, b) {
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x) };
}

/**
 * The rotation a two-finger gesture applies: 0 until the fingers have turned by ROT_THRESHOLD,
 * then the turn less the threshold, so the image does not jump when rotation starts.
 */
export function gestureRotation(turn, engaged) {
  if (!engaged) return 0;
  return turn - Math.sign(turn) * ROT_THRESHOLD;
}

/**
 * The view after a two-finger gesture. `view0` is the view when the second finger came down;
 * `p0`/`p1` are {cx, cy, d, a} of the finger pair then and now (pane pixels); `w`, `h` the pane size.
 * The image point under the first centroid stays under the current centroid, the zoom scales by the
 * finger distance and the rotation follows the fingers' turn (gestureRotation). Pure.
 */
export function pinchView(view0, p0, p1, w, h, { rotate = true, engaged = false } = {}) {
  const k = p0.d > 0 ? p1.d / p0.d : 1;
  const zoom = Math.min(ZMAX, Math.max(ZMIN, view0.zoom * k));
  const turn = wrapAngle(p1.a - p0.a);
  const rot = rotate ? (view0.rot ?? 0) + gestureRotation(turn, engaged) : view0.rot ?? 0;
  const P = invertView(view0, w, h, p0.cx, p0.cy);
  const next = { ...view0, zoom, rot };
  const d = screenToImageDelta(next, p1.cx - w / 2, p1.cy - h / 2);
  return { ...next, cx: P.x - d.x, cy: P.y - d.y, mode: rotate && engaged ? 'free' : view0.mode };
}

/** Whether a second tap at (x, y, t) makes a double tap with the first {x, y, t}. */
export function isDoubleTap(first, x, y, t) {
  return !!first && t - first.t <= DOUBLE_MS && Math.hypot(x - first.x, y - first.y) <= DOUBLE_PX;
}

/**
 * Bind the gestures to a view element that holds image panels. `paneOf(target)` gives the panel of
 * an event target (or null); `onLongPress(pane, sx, sy)` and `onDoubleTap(pane, sx, sy)` are the
 * shell's actions; `toolActive()` says whether a tool takes the taps. Returns an unbind function.
 */
export function bindGestures(el, { paneOf, toolActive, onLongPress, onDoubleTap, onGesture = () => {} }) {
  const synthetic = new WeakSet();
  const touches = new Map(); // pointerId → {x, y, x0, y0, t0, target}
  let mode = 'idle'; // idle | press (one finger, undecided) | pan (passed to the panel) | held (tool tap buffered) | pinch | swallow
  let pane = null;
  let press = null; // the first pointerdown of a one-finger gesture
  let longTimer = 0;
  let lastTap = null;
  let pinch = null;
  let lastTouchEnd = 0;

  /** Pane pixels of an event (clientX/Y) or of a tracked touch (x/y in client pixels). */
  const local = (p, e) => {
    const r = p.el.getBoundingClientRect();
    return { x: (e.clientX ?? e.x) - r.left, y: (e.clientY ?? e.y) - r.top };
  };
  const forward = (type, src, target = src.target) => {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: src.pointerId, pointerType: 'touch', isPrimary: true, clientX: src.clientX, clientY: src.clientY, screenX: src.screenX, screenY: src.screenY, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, pressure: type === 'pointerup' ? 0 : 0.5 });
    synthetic.add(ev);
    (target?.isConnected ? target : pane?.el)?.dispatchEvent(ev);
  };
  const stop = (e) => {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  };
  const clearLong = () => {
    clearTimeout(longTimer);
    longTimer = 0;
  };

  function down(e) {
    if (synthetic.has(e) || e.pointerType !== 'touch') return;
    const p = paneOf(e.target);
    if (!p) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), target: e.target, ev: e });
    if (touches.size === 1) {
      pane = p;
      press = e;
      const tool = toolActive();
      mode = tool ? 'held' : 'pan';
      if (tool) stop(e); // the tap goes to the tool when it ends or moves (a pinch never reaches it)
      clearLong();
      const at = local(p, e);
      longTimer = setTimeout(() => {
        longTimer = 0;
        if (touches.size !== 1 || (mode !== 'pan' && mode !== 'held')) return;
        if (mode === 'pan') forward('pointercancel', press); // end the panel's pan
        mode = 'swallow';
        onLongPress(pane, at.x, at.y);
      }, LONG_MS);
      return;
    }
    // A second finger: a pinch. The first finger's pan ends; a buffered tool tap is dropped.
    stop(e);
    clearLong();
    if (touches.size === 2 && pane) {
      if (mode === 'pan') forward('pointercancel', press);
      const [a, b] = [...touches.values()];
      const { w, h } = pane.size();
      pinch = { view0: { ...pane.view }, p0: pairOf(local(pane, a), local(pane, b)), w, h, engaged: false };
      mode = 'pinch';
      onGesture('pinch');
    } else mode = 'swallow';
  }

  function move(e) {
    if (synthetic.has(e) || e.pointerType !== 'touch') return;
    const tp = touches.get(e.pointerId);
    if (!tp) return;
    tp.x = e.clientX;
    tp.y = e.clientY;
    const moved = Math.hypot(tp.x - tp.x0, tp.y - tp.y0) > SLOP;
    if (moved) clearLong();
    if (mode === 'pinch') {
      stop(e);
      if (touches.size < 2 || !pane) return;
      const [a, b] = [...touches.values()];
      const p1 = pairOf(local(pane, a), local(pane, b));
      if (!pinch.engaged && Math.abs(wrapAngle(p1.a - pinch.p0.a)) > ROT_THRESHOLD) pinch.engaged = true;
      const v = pinchView(pinch.view0, pinch.p0, p1, pinch.w, pinch.h, { engaged: pinch.engaged });
      if (Number.isFinite(v.cx) && Number.isFinite(v.cy) && Number.isFinite(v.zoom) && Number.isFinite(v.rot)) pane.setView(v);
      return;
    }
    if (mode === 'held') {
      stop(e);
      if (!moved) return;
      // A drag with a tool (box AOI, zoom box): the tool gets the press, then the moves.
      mode = 'pan';
      forward('pointerdown', press, tp.target);
      forward('pointermove', e, tp.target);
      return;
    }
    if (mode === 'swallow') stop(e);
  }

  function up(e) {
    if (synthetic.has(e) || e.pointerType !== 'touch') return;
    const tp = touches.get(e.pointerId);
    if (!tp) return;
    touches.delete(e.pointerId);
    clearLong();
    const now = performance.now();
    lastTouchEnd = now;
    if (mode === 'pinch' || mode === 'swallow') {
      stop(e);
      if (!touches.size) {
        if (mode === 'pinch') pane?._afterRoam?.();
        mode = 'idle';
        pinch = null;
        onGesture('end');
      } else mode = 'swallow'; // the other finger lifts later; it does not start a pan
      return;
    }
    const tap = e.type === 'pointerup' && Math.hypot(tp.x - tp.x0, tp.y - tp.y0) <= SLOP && now - tp.t0 < LONG_MS;
    const at = pane ? local(pane, e) : { x: 0, y: 0 };
    if (mode === 'held') {
      // A tool tap: the panel gets the press now, then this release.
      mode = 'idle';
      if (e.type !== 'pointerup') return stop(e);
      forward('pointerdown', press, tp.target);
      const dbl = tap && isDoubleTap(lastTap, at.x, at.y, now);
      lastTap = tap && !dbl ? { x: at.x, y: at.y, t: now } : null;
      if (dbl) queueMicrotask(() => pane?.app.tools.current?.onDblClick?.(pane, e));
      return; // this pointerup reaches the panel (the tool's onUp)
    }
    mode = 'idle';
    if (tap && pane) {
      if (isDoubleTap(lastTap, at.x, at.y, now)) {
        lastTap = null;
        onDoubleTap(pane, at.x, at.y);
      } else lastTap = { x: at.x, y: at.y, t: now };
    }
  }

  // A double tap also makes the browser send dblclick: the gesture layer handles it. Safari on iOS
  // takes the second tap for itself and sends only this dblclick, with no pointer events for it.
  function dblclick(e) {
    if (synthetic.has(e) || performance.now() - lastTouchEnd >= 600) return;
    stop(e);
    const p = lastTap && paneOf(e.target);
    if (!p) return;
    const at = local(p, e);
    if (!isDoubleTap(lastTap, at.x, at.y, performance.now())) return;
    lastTap = null;
    if (toolActive()) p.app.tools.current?.onDblClick?.(p, e);
    else onDoubleTap(p, at.x, at.y);
  }
  // A long press must not open the browser's context menu over the image.
  function contextmenu(e) {
    if (performance.now() - lastTouchEnd < 1200 || touches.size) stop(e);
  }

  const opts = { capture: true, passive: false };
  el.addEventListener('pointerdown', down, opts);
  el.addEventListener('pointermove', move, opts);
  el.addEventListener('pointerup', up, opts);
  el.addEventListener('pointercancel', up, opts);
  el.addEventListener('dblclick', dblclick, opts);
  el.addEventListener('contextmenu', contextmenu, opts);
  return () => {
    clearLong();
    el.removeEventListener('pointerdown', down, opts);
    el.removeEventListener('pointermove', move, opts);
    el.removeEventListener('pointerup', up, opts);
    el.removeEventListener('pointercancel', up, opts);
    el.removeEventListener('dblclick', dblclick, opts);
    el.removeEventListener('contextmenu', contextmenu, opts);
  };
}
