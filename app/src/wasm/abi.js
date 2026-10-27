// JS side of the GIS Workbench C ABI (Appendix D §3.1, REQ-RUST-03). DOM-free: used on the
// main thread (core) and in workers (core, parse). It owns memory views, copies and errors,
// and re-creates views after any call that may grow memory.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const STATUS = { 0: 'ok', 1: 'invalid input', 2: 'out of range', 3: 'limit exceeded', 4: 'not supported', 5: 'internal error' };

export class WasmError extends Error {
  constructor(code, message, fn) {
    super(message || STATUS[code] || `error ${code}`);
    this.code = code;
    this.fn = fn;
  }
}

/** A trapped instance (Rust panic or out-of-bounds) is a RuntimeError; callers re-instantiate. */
export function isTrap(e) {
  return e instanceof WebAssembly.RuntimeError;
}

export class Bundle {
  constructor(module, name) {
    this.module = module;
    this.name = name;
    this.instantiate();
  }

  instantiate() {
    this.instance = new WebAssembly.Instance(this.module, {});
    this.x = this.instance.exports;
    this.traps = (this.traps ?? -1) + 1;
  }

  get mem() {
    return this.x.memory.buffer;
  }

  /** Run fn; on a trap re-create the instance (losing its state) and rethrow (REQ-RUST-04). */
  guard(fn) {
    try {
      return fn();
    } catch (e) {
      if (isTrap(e)) {
        const err = new WasmError(5, `${this.name}: WebAssembly trap (${e.message}); the module was restarted`, 'trap');
        err.trapped = true;
        this.instantiate();
        throw err;
      }
      throw e;
    }
  }

  lastError() {
    const cap = 1024;
    const p = this.x.gw_alloc(cap);
    const n = this.x.gw_last_error(p, cap);
    const s = dec.decode(new Uint8Array(this.mem, p, Math.min(n, cap)));
    this.x.gw_free(p, cap);
    return s;
  }

  check(code, fn) {
    if (code !== 0) throw new WasmError(code, this.lastError(), fn);
  }

  /** Copy bytes in; returns [ptr, len]. Caller frees. */
  put(u8) {
    const len = u8.byteLength;
    const p = this.x.gw_alloc(len);
    if (!p && len) throw new WasmError(3, `${this.name}: out of memory allocating ${len} bytes`);
    new Uint8Array(this.mem, p, len).set(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength));
    return [p, len];
  }

  putF64(arr) {
    const a = arr instanceof Float64Array ? arr : Float64Array.from(arr);
    const p = this.x.gw_alloc(a.byteLength);
    new Float64Array(this.mem, p, a.length).set(a);
    return [p, a.byteLength];
  }

  putF32(arr) {
    const a = arr instanceof Float32Array ? arr : Float32Array.from(arr);
    const p = this.x.gw_alloc(a.byteLength);
    new Float32Array(this.mem, p, a.length).set(a);
    return [p, a.byteLength];
  }

  free(p, len) {
    this.x.gw_free(p, len);
  }

  outBytes() {
    return new Uint8Array(this.mem, this.x.gw_out_ptr(), this.x.gw_out_len()).slice();
  }

  outText() {
    return dec.decode(new Uint8Array(this.mem, this.x.gw_out_ptr(), this.x.gw_out_len()));
  }

  outJson() {
    return JSON.parse(this.outText());
  }

  /** Call fn(ptr, len, ...rest) with a UTF-8 string argument. */
  withStr(s, call) {
    const b = enc.encode(s);
    const [p, n] = this.put(b);
    try {
      return call(p, n);
    } finally {
      this.free(p, n);
    }
  }

  /** Call with a scratch f64 output of n values; returns a Float64Array copy. */
  outF64(n, call) {
    const p = this.x.gw_alloc(n * 8);
    try {
      const r = call(p);
      const v = new Float64Array(this.mem, p, n).slice();
      return { r, v };
    } finally {
      this.free(p, n * 8);
    }
  }
}
