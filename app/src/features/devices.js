// Input devices (REQ-UI-20, REQ-UI-21): one abstraction for mouse, keyboard, Gamepad and WebHID
// devices — six axes (x, y, z, rx, ry, rz in −1 … 1) with per-axis gains, routed to the active
// panel: 2D pan and zoom, stereo pan and Z (the floating cursor height), or 3D flight. A
// 3Dconnexion SpaceMouse is read through WebHID (translation/rotation reports), with the Gamepad
// API as the fallback. Serial stereo mice (REQ-UI-22) connect through Web Serial: the Stealth and
// TopoMouse protocols are not public, so the built-in protocol is a documented text line
// ("dx dy dz buttons", counts, one sample per line) that a small adapter or firmware can emit;
// further protocols plug into SERIAL_PROTOCOLS.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';

export const name = 'devices';

const DEAD = 0.12;
const VENDORS = [0x256f, 0x046d]; // 3Dconnexion, Logitech (older SpaceMouse)

/** Serial line protocols: parse(line) → {dx, dy, dz, buttons} in counts, or null. */
export const SERIAL_PROTOCOLS = {
  text: {
    name: 'Text: "dx dy dz buttons" per line',
    parse(line) {
      const f = line.trim().split(/[\s,;]+/).map(Number);
      if (f.length < 3 || !f.slice(0, 3).every(Number.isFinite)) return null;
      return { dx: f[0], dy: f[1], dz: f[2], buttons: Number.isFinite(f[3]) ? f[3] : 0 };
    },
  },
};

export function install(app) {
  const C = app.commands;
  const gains = () => ({ x: 1, y: 1, z: 1, rotate: 1, wheel: 1, keyboard: 1, ...(app.prefs.get('inputGains') ?? {}) });
  const dz = (v) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));
  const state = { last: null, source: null, hid: null, count: 0 };

  /** Apply one sample of axes (−1 … 1) for `dt` seconds to the active panel. */
  function feed(a, dt = 1 / 60, source = 'api') {
    const g = gains();
    const x = dz(a.x ?? 0) * g.x;
    const y = dz(a.y ?? 0) * g.y;
    const z = dz(a.z ?? 0) * g.z;
    const rz = dz(a.rz ?? 0) * g.rotate;
    const rx = dz(a.rx ?? 0) * g.rotate;
    state.last = { x, y, z, rx, rz, source };
    state.count++;
    const p = app.activePane();
    if (!p) return state.last;
    if (p.view3d) {
      const v = p.view3d;
      const sp = (v.flySpeed ?? 4) * 60 * dt * 4;
      v.fly(-y * sp, x * sp, -z * sp);
      if (rz || rx) v.look(-rz * 1.5 * dt, -rx * 1.5 * dt);
      return state.last;
    }
    if (p.stereo && z) {
      // Stereo: z moves the floating cursor in height (REQ-STR-08), pan as in 2D.
      p.stereo.stepZ?.(-z * 60 * dt);
    }
    if (x || y) {
      const pxPerSec = 600;
      const zoom = p.view.zoom;
      const c = Math.cos(p.view.rot);
      const s = Math.sin(p.view.rot);
      const dx = (x * pxPerSec * dt) / zoom;
      const dy = (y * pxPerSec * dt) / zoom;
      p.setView({ cx: p.view.cx + (c * dx + s * dy), cy: p.view.cy + (-s * dx + c * dy) });
    }
    if (z && !p.stereo) p.setView({ zoom: p.view.zoom * Math.exp(-z * 1.5 * dt) });
    return state.last;
  }

  // ---- Gamepad (fallback) ----
  let polling = false;
  let tPrev = 0;
  function poll(t) {
    const pads = navigator.getGamepads?.() ?? [];
    const gp = [...pads].find(Boolean);
    if (!gp) {
      polling = false;
      return;
    }
    const dt = tPrev ? Math.min(0.1, (t - tPrev) / 1000) : 1 / 60;
    tPrev = t;
    const ax = gp.axes;
    // Standard mapping: left stick pans, right stick vertical zooms (or Z), right stick horizontal rotates.
    const a = { x: ax[0] ?? 0, y: ax[1] ?? 0, z: ax[3] ?? 0, rz: ax[2] ?? 0 };
    if (Object.values(a).some((v) => Math.abs(v) >= DEAD)) feed(a, dt, `gamepad:${gp.id}`);
    requestAnimationFrame(poll);
  }
  function startPolling() {
    if (polling) return;
    polling = true;
    tPrev = 0;
    requestAnimationFrame(poll);
  }
  window.addEventListener('gamepadconnected', startPolling);

  // ---- WebHID SpaceMouse (REQ-UI-21) ----
  const axesHid = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
  /** Parse one HID input report: id 1 = translation (+ rotation on 12-byte reports), 2 = rotation, 3 = buttons. */
  function hidReport(reportId, dv) {
    const s16 = (o) => (dv.byteLength >= o + 2 ? dv.getInt16(o, true) / 350 : 0);
    if (reportId === 1) {
      axesHid.x = s16(0);
      axesHid.y = s16(2);
      axesHid.z = s16(4);
      if (dv.byteLength >= 12) {
        axesHid.rx = s16(6);
        axesHid.ry = s16(8);
        axesHid.rz = s16(10);
      }
    } else if (reportId === 2) {
      axesHid.rx = s16(0);
      axesHid.ry = s16(2);
      axesHid.rz = s16(4);
    } else if (reportId === 3) {
      const b = dv.getUint8(0);
      if (b & 1) C.run('nav.whole');
      if (b & 2) C.run('nav.onetoone');
      return { buttons: b };
    }
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    return feed({ x: clamp(axesHid.x), y: clamp(axesHid.y), z: clamp(axesHid.z), rx: clamp(axesHid.rx), rz: clamp(axesHid.rz) }, 1 / 60, 'spacemouse');
  }
  async function connectSpaceMouse() {
    if (!navigator.hid) throw new Error('WebHID is not available in this browser: use a Gamepad, or Chromium');
    const [dev] = await navigator.hid.requestDevice({ filters: VENDORS.map((vendorId) => ({ vendorId })) });
    if (!dev) return null;
    if (!dev.opened) await dev.open();
    dev.addEventListener('inputreport', (e) => hidReport(e.reportId, e.data));
    state.hid = { name: dev.productName, vendorId: dev.vendorId, productId: dev.productId };
    app.toast(`${dev.productName} connected (WebHID)`);
    return state.hid;
  }

  // ---- Web Serial stereo mice (REQ-UI-22) ----
  let lastButtons = 0;
  /** One line from a serial device: counts / `scale` become axes; button 1 puts the stereo cursor on the ground. */
  function serialLine(line, { protocol = 'text', scale = app.prefs.get('serialScale') ?? 100 } = {}) {
    const r = SERIAL_PROTOCOLS[protocol]?.parse(line);
    if (!r) return null;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    const s = Math.max(1e-6, scale);
    // Counts are already deltas: bypass the dead zone by scaling past it.
    const lift = (v) => (v === 0 ? 0 : Math.sign(v) * (DEAD + (1 - DEAD) * Math.min(1, Math.abs(v))));
    const out = feed({ x: lift(clamp(r.dx / s)), y: lift(clamp(r.dy / s)), z: lift(clamp(r.dz / s)) }, 1 / 60, `serial:${protocol}`);
    const pressed = r.buttons & ~lastButtons;
    lastButtons = r.buttons;
    if (pressed & 1 && app.activePane()?.stereo) C.run('stereo.place');
    return { ...out, buttons: r.buttons };
  }
  async function connectSerial({ baud = 9600, protocol = 'text' } = {}) {
    if (!navigator.serial) throw new Error('Web Serial is not available in this browser (Chromium on the desktop has it)');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: baud });
    state.serial = { baud, protocol, info: port.getInfo?.() ?? {} };
    app.toast(`Serial device connected at ${baud} baud (${SERIAL_PROTOCOLS[protocol].name})`);
    (async () => {
      const reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          serialLine(buf.slice(0, i), { protocol });
          buf = buf.slice(i + 1);
        }
        if (buf.length > 4096) buf = '';
      }
      state.serial = null;
    })().catch((e) => app.log('warn', `serial device: ${e.message}`));
    return state.serial;
  }

  app.input = { feed, hidReport, connectSpaceMouse, serialLine, connectSerial, startPolling, gains, state };

  C.implement('input.devices', {
    run: async () => {
      const g = gains();
      const num = (k, lbl) => h('input', { class: 'inp inp-num', type: 'number', step: '0.1', min: '0', max: '10', value: String(g[k]), 'aria-label': lbl, 'data-k': k });
      const inputs = [num('x', 'X gain'), num('y', 'Y gain'), num('z', 'Z gain'), num('rotate', 'Rotation gain'), num('wheel', 'Wheel gain'), num('keyboard', 'Keyboard gain')];
      const connect = h('button', { class: 'btn' }, 'Connect SpaceMouse (WebHID)…');
      connect.addEventListener('click', () => connectSpaceMouse().catch((e) => app.toast(e.message, { kind: 'error' })));
      const baud = h('select', { class: 'inp', 'aria-label': 'Baud rate' }, [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((b) => h('option', { value: String(b), selected: b === 9600 }, String(b))));
      const scale = h('input', { class: 'inp inp-num', type: 'number', min: '1', value: String(app.prefs.get('serialScale') ?? 100), 'aria-label': 'Counts for full deflection' });
      const serial = h('button', { class: 'btn', disabled: !navigator.serial }, 'Connect Serial Device (Web Serial)…');
      serial.addEventListener('click', () => {
        app.prefs.set('serialScale', Number(scale.value) || 100);
        connectSerial({ baud: Number(baud.value) }).catch((e) => app.toast(e.message, { kind: 'error' }));
      });
      const pads = [...(navigator.getGamepads?.() ?? [])].filter(Boolean).map((p) => p.id);
      const body = h('div', {}, field('X / Y / Z gains', h('div', { class: 'tb-row' }, inputs.slice(0, 3))), field('Rotation, wheel and keyboard gains', h('div', { class: 'tb-row' }, inputs.slice(3))), connect, field('Serial stereo mouse', h('div', { class: 'tb-row' }, baud, scale, serial), 'Text protocol, one "dx dy dz buttons" line per sample; Stealth and TopoMouse protocols are not public. Button 1 puts the stereo cursor on the ground.'), h('p', { class: 'hint' }, pads.length ? `Gamepads: ${pads.join(', ')}` : 'No gamepad seen yet: press a button on it to wake it.'));
      if ((await modal({ title: 'Input Devices', body, id: 'input-devices' })) !== 'OK') return;
      app.prefs.set('inputGains', Object.fromEntries(inputs.map((i) => [i.dataset.k, Number(i.value) || 0])));
    },
  });
}
