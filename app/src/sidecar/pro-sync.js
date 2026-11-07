// The page's end of ArcGIS Pro sync (REQ-GAP-65; lazy block js-sidecarnative). The add-in and this
// page cannot reach each other, so the sidecar holds one small piece of state between them, a view
// and a cursor in WGS 84. This class publishes this page's, follows the add-in's, and stops the
// loop two maps following each other would make. It is off until the analyst turns it on, stays off
// across reloads, and goes off for good when the sidecar stops answering. DOM-free, so it tests in
// Node; pro-sync-ui.js gives it a map.

/** Echo rule: the same numbers as sidecar/pro-addin/GwbProSync.Core/SyncLoop.cs. */
export const ECHO = { pixels: 0.5, scaleRatio: 0.005, degrees: 0.05, lifeMs: 2000 };
const METRES_PER_DEGREE = 111_320;
/** Cursor moves sent per second at most: the sidecar coalesces, this spares it the work. */
export const CURSOR_PER_SECOND = 30;
const RETRIES = 3;

export const sameView = (a, b) => {
  const east = (a.lon - b.lon) * METRES_PER_DEGREE * Math.cos((a.lat * Math.PI) / 180);
  const north = (a.lat - b.lat) * METRES_PER_DEGREE;
  return Math.hypot(east, north) <= ECHO.pixels * a.mpp && Math.abs(a.mpp / b.mpp - 1) <= ECHO.scaleRatio && Math.abs(a.rotation - b.rotation) <= ECHO.degrees;
};

/** Whether `seen`, this side's own view, is the move it was told to make `ago` ms before. */
export const isEcho = (applied, seen, ago) => !!applied && ago <= ECHO.lifeMs && sameView(applied, seen);

export class ProSyncHost {
  /**
   * `client`: the page's SidecarClient. `name`: this page, for the sidecar window. `applyView(v)`,
   * `showCursor(c)`: the map's side. `onChange()`: state changed. `wait(ms)`, `now()`: for tests.
   */
  constructor({ client, name, applyView, showCursor, onChange = () => {}, wait = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
    Object.assign(this, { client, name, applyView, showCursor, onChange, wait, now });
    this.on = false;
    this.session = null;
    this.direction = 'both';
    this.peer = false; // the add-in is there
    this.error = null; // why it went off by itself
    this.received = 0;
    this.sent = 0;
    this.seq = 0;
    this.applied = null; // {view, at}: the last view the add-in sent
    this.lastCursor = -Infinity;
    this.heldCursor = null;
    this.timer = null;
    this.ac = null;
    this.sending = false;
    this.waiting = null;
  }

  get canPublish() {
    return this.on && this.direction !== 'app_follows';
  }

  async start(direction = 'both') {
    if (this.on) return;
    this.error = null;
    const r = await this.client.request('POST', '/v1/sync/attach', { json: { client: this.name, direction } });
    Object.assign(this, { session: r.session, direction, on: true, peer: false, seq: 0, applied: null, ac: new AbortController() });
    this.onChange();
    this.loop = this.run(this.session, this.ac.signal);
  }

  /** Turn it off: what either side published goes. */
  async stop() {
    if (!this.on) return;
    const session = this.session;
    this.off();
    this.onChange();
    await this.client.request('DELETE', `/v1/sync/${session}`).catch(() => {});
  }

  off() {
    this.on = false;
    this.session = null;
    this.peer = false;
    this.ac?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.heldCursor = null;
  }

  lost(e) {
    this.off();
    this.error = e;
    this.onChange();
  }

  async run(session, signal) {
    let fails = 0;
    while (this.on && this.session === session) {
      try {
        const u = await this.client.request('GET', `/v1/sync/${session}/next?after=${this.seq}`, { signal });
        fails = 0;
        if (!this.on || this.session !== session) return;
        this.seq = u.seq;
        const changed = u.peer !== this.peer;
        this.peer = u.peer;
        if (u.view) {
          this.received++;
          this.applied = { view: u.view, at: this.now() };
          await this.applyView(u.view);
        }
        if (u.cursor) {
          this.received++;
          this.showCursor(u.cursor);
        }
        if (changed || u.view || u.cursor) this.onChange();
      } catch (e) {
        if (!this.on || this.session !== session) return;
        // Revoked, taken over or forgotten: off now. A connection error gets a few tries.
        if (e.status === 401 || e.status === 404 || ++fails >= RETRIES) return this.lost(e);
        await this.wait(500 * fails);
      }
    }
  }

  /**
   * One request at a time: two at once could land in the wrong order and leave the other map on the
   * older view. What arrives meanwhile waits, and only the newest of each kind goes.
   */
  async publish(body) {
    if (!this.canPublish) return false;
    if (this.sending) {
      this.waiting = { ...this.waiting, ...body };
      return true;
    }
    this.sending = true;
    let ok = false;
    try {
      for (let next = body; next && this.canPublish; next = this.waiting) {
        this.waiting = null;
        try {
          await this.client.request('POST', `/v1/sync/${this.session}/state`, { json: next });
          this.sent++;
          ok = true;
        } catch (e) {
          // Too many at once, or off in the meantime: the next one says the same thing, and fresher.
          ok = false;
          if (e.status === 401 || e.status === 404) this.lost(e);
        }
      }
    } finally {
      this.sending = false;
      this.waiting = null;
    }
    return ok;
  }

  /** The view here changed. A view the add-in just asked for is not sent back. */
  localView(view) {
    if (!view || !this.canPublish) return Promise.resolve(false);
    if (isEcho(this.applied?.view, view, this.now() - (this.applied?.at ?? -Infinity))) return Promise.resolve(false);
    return this.publish({ view });
  }

  /** The cursor here moved. At most CURSOR_PER_SECOND, and the last move always goes. */
  localCursor(cursor) {
    if (!this.canPublish) return;
    const gap = 1000 / CURSOR_PER_SECOND;
    const since = this.now() - this.lastCursor;
    if (since >= gap || !cursor.visible) {
      this.lastCursor = this.now();
      this.heldCursor = null;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.publish({ cursor });
      return;
    }
    this.heldCursor = cursor;
    this.timer ??= setTimeout(() => {
      this.timer = null;
      const c = this.heldCursor;
      this.heldCursor = null;
      if (!c || !this.canPublish) return;
      this.lastCursor = this.now();
      this.publish({ cursor: c });
    }, gap - since);
  }
}
