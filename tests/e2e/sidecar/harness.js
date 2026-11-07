// Playwright `sidecar` project (SDP-2.1 §7.5): a test sidecar started by the setup project with a
// test pairing token, its state shared through a JSON file. Every other project runs with no
// sidecar (PT-13). Env: GWB_SIDECAR_EXE (default: the release build in the cargo target dir),
// GWB_SIDECAR_MODULES (default: the dev bundle on D:), TE_DIST / GWB_DIST (the build to test).
// Linux (P16, run in WSL or on Linux): the musl build and the Linux bundle under ~/gwb, the corpus
// through /mnt/c (GWB_CORPUS), Playwright's own Chromium (no channel, see playwright.config.js).

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { DIST_DIR as BUILD_DIR } from '../helpers.js';
import { createServer } from 'node:https';

export const LINUX = process.platform === 'linux';
export const STATE = resolve('test-results', 'sidecar-state.json');
const HOME = process.env.HOME ?? '';
const TARGET = process.env.GWB_SIDECAR_TARGET ?? (LINUX ? join(HOME, 'gwb/target/x86_64-unknown-linux-musl') : join(homedir(), 'AppData', 'Local', 'qlab', 'ct21-sidecar'));
export const EXE = process.env.GWB_SIDECAR_EXE ?? join(TARGET, 'release', LINUX ? 'gwb-sidecar' : 'gwb-sidecar.exe');
export const MODULES = process.env.GWB_SIDECAR_MODULES ?? (LINUX ? join(HOME, 'gwb/bundle/modules') : 'D:/gwb-sidecar-deps/bundle/modules');
/** Where the test sidecar keeps its data (Linux: the native disk, not /mnt/c (slow) or /tmp (RAM)). */
export const DATA_ROOT = process.env.GWB_SIDECAR_DATA ?? (LINUX ? join(HOME, 'gwb/e2e') : resolve('test-results'));
export const DIST_DIR = process.env.GWB_DIST_DIR ? resolve(process.env.GWB_DIST_DIR) : BUILD_DIR; // else GW_DIST (helpers.js)
export const HOSTED_PORT = 8443;
export const HOSTED = `https://127.0.0.1:${HOSTED_PORT}`;
export const CORPUS = process.env.GWB_CORPUS ?? (LINUX ? '/mnt/c/GIS Workbench/TE-corpus' : 'C:/GIS Workbench/TE-corpus');

/** Start a headless sidecar; `keep` reuses an existing data folder (its files and outputs) and `token`. */
export async function startSidecar({ dataDir, port = 47821, extra = [], keep = false, token = randomBytes(32).toString('hex'), exe = EXE } = {}) {
  if (!keep) rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const portFile = join(dataDir, 'port.txt');
  rmSync(portFile, { force: true });
  const args = ['--headless', '--data-dir', dataDir, '--modules-dir', MODULES, '--app-dir', DIST_DIR, '--port', String(port), '--port-file', portFile, '--allow-origin', HOSTED, '--test-pair', `null=${token}`, ...extra];
  const child = spawn(exe, args, { env: { ...process.env, GWB_SIDECAR_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true, windowsHide: true });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(portFile)) throw new Error(`the test sidecar did not start: ${err}`);
  // Wait for the caps (GDAL is asked once at start).
  const base = `http://127.0.0.1:${readFileSync(portFile, 'utf8').trim()}`;
  for (let i = 0; i < 100; i++) {
    const c = await fetch(`${base}/v1/caps`, { headers: { Origin: 'null', Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => null);
    if (c?.tools?.length) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  child.unref();
  return { pid: child.pid, token, base, dataDir, port: Number(readFileSync(portFile, 'utf8').trim()) };
}

export function stopSidecar(pid) {
  try {
    // Linux: the sidecar was spawned detached, so it leads its own process group.
    if (LINUX) process.kill(-pid, 'SIGKILL');
    else execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

export function state() {
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

export function saveState(s) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

/** Approve every pending pairing request through the sidecar window's API (as a user would). */
export async function approvePending(s, { expectCode } = {}) {
  const key = readFileSync(join(s.dataDir, 'ui.key'), 'utf8').trim();
  const lh = `http://localhost:${s.port}`;
  // A launch link, then the window's session secret (what the browser window does).
  const launch = await rawPost(s.port, '/ui/api/launch', { 'X-Gwb-Key': key });
  const code = new URL(launch.url).searchParams.get('launch');
  const sess = await rawPost(s.port, '/ui/api/session', { Origin: lh, 'Content-Type': 'application/json' }, JSON.stringify({ launch: code }));
  const st = await rawGet(s.port, '/ui/api/state', { 'X-Gwb-Admin': sess.secret });
  const out = [];
  for (const p of st.pending) {
    if (expectCode && p.code !== expectCode) throw new Error(`the sidecar shows ${p.code}, the app ${expectCode}`);
    await rawPost(s.port, '/ui/api/decide', { Origin: lh, 'Content-Type': 'application/json', 'X-Gwb-Admin': sess.secret }, JSON.stringify({ id: p.id, approve: true }));
    out.push(p);
  }
  return out;
}

/** The sidecar window's secret, as a user opening the window gets it. */
async function windowSession(s) {
  const key = readFileSync(join(s.dataDir, 'ui.key'), 'utf8').trim();
  const lh = `http://localhost:${s.port}`;
  const launch = await rawPost(s.port, '/ui/api/launch', { 'X-Gwb-Key': key });
  const code = new URL(launch.url).searchParams.get('launch');
  const sess = await rawPost(s.port, '/ui/api/session', { Origin: lh, 'Content-Type': 'application/json' }, JSON.stringify({ launch: code }));
  return { lh, secret: sess.secret };
}

/** A call of the sidecar window's API, with its secret, as the window makes it. */
export async function windowPost(s, path, body) {
  const { lh, secret } = await windowSession(s);
  return rawPost(s.port, path, { Origin: lh, 'Content-Type': 'application/json', 'X-Gwb-Admin': secret }, JSON.stringify(body));
}

/** What the sidecar window shows. */
export async function windowState(s) {
  const { secret } = await windowSession(s);
  return rawGet(s.port, '/ui/api/state', { 'X-Gwb-Admin': secret });
}

/** Approve or refuse a CSM plug-in in the sidecar window (REQ-GAP-25). */
export async function csmDecide(s, sha256, approve) {
  const { lh, secret } = await windowSession(s);
  return rawPost(s.port, '/ui/api/csm/decide', { Origin: lh, 'Content-Type': 'application/json', 'X-Gwb-Admin': secret }, JSON.stringify({ sha256, approve }));
}

/** A one-time link that opens the sidecar window. */
export async function windowUrl(s) {
  return (await rawPost(s.port, '/ui/api/launch', { 'X-Gwb-Key': readFileSync(join(s.dataDir, 'ui.key'), 'utf8').trim() })).url;
}

// Node's fetch forbids setting Host/Origin freely; the window API needs Host localhost:<port>.
import { request as httpRequest } from 'node:http';
function raw(port, method, path, headers = {}, body = null) {
  return new Promise((res, rej) => {
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers: { Host: `localhost:${port}`, ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : { 'Content-Length': 0 }) } }, (resp) => {
      let t = '';
      resp.on('data', (d) => (t += d));
      resp.on('end', () => {
        try {
          const j = JSON.parse(t);
          if (resp.statusCode >= 400) rej(new Error(`${path}: ${resp.statusCode} ${t}`));
          else res(j);
        } catch {
          rej(new Error(`${path}: ${resp.statusCode} ${t}`));
        }
      });
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}
const rawPost = (port, path, headers, body) => raw(port, 'POST', path, headers, body);
const rawGet = (port, path, headers) => raw(port, 'GET', path, headers);

/** A self-signed https server for PT-15 (hosted https), serving the dist files. */
export async function httpsServer(dir, port = HOSTED_PORT) {
  const certDir = resolve('test-results', 'sidecar-cert');
  mkdirSync(certDir, { recursive: true });
  const key = join(certDir, 'key.pem');
  const crt = join(certDir, 'cert.pem');
  if (!existsSync(crt)) {
    const openssl = ['C:/Program Files/Git/usr/bin/openssl.exe', 'openssl'].find((p) => p === 'openssl' || existsSync(p));
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '30', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  }
  const srv = createServer({ key: readFileSync(key), cert: readFileSync(crt) }, (req, res) => {
    const name = (req.url.split('?')[0].replace(/^\//, '') || 'gis-workbench.html').replace(/\.\./g, '');
    const p = join(dir, name);
    if (!existsSync(p)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(readFileSync(p));
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { url: `${HOSTED}/`, close: () => new Promise((r) => srv.close(r)) };
}

/** TCP connections of processes by name that are not loopback (REQ-SDC-14 network capture). */
export function outboundConnections(names = ['gwb-sidecar', 'gdal_translate', 'gdalinfo', 'ogr2ogr', 'ogrinfo', 'pdal', 'ffmpeg', 'ffprobe', 'python']) {
  if (LINUX) {
    // ss lists the sockets of this user's processes: `ESTAB 0 0 10.0.0.2:5000 1.2.3.4:443 users:(("ffmpeg",pid=9,fd=3))`.
    const out = execFileSync('ss', ['-tnpH', 'state', 'all'], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter(Boolean)
      .filter((l) => names.some((n) => l.includes(`(("${n}`) || l.includes(`(("${n.slice(0, 15)}`)))
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => !/^(127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|\[::\]|\*):/.test(f[4] ?? ''))
      .map((f) => `${f[5] ?? ''} ${f[4]} ${f[0]}`);
  }
  const ps = `$n=@(${names.map((n) => `'${n}'`).join(',')}); Get-NetTCPConnection -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $n -contains $p.ProcessName) { '{0} {1} {2}:{3} {4}' -f $p.ProcessName, $_.OwningProcess, $_.RemoteAddress, $_.RemotePort, $_.State } }`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((l) => !/ (127\.0\.0\.1|0\.0\.0\.0|::1|::):\d+ /.test(l));
}
