// docs/POLICY.md, "Tests and tools": a test or tool never listens on a wildcard or LAN address, and
// nothing opens a window on the desktop during a test run. A server on 0.0.0.0 raised a Windows
// firewall prompt on the admin's desktop; this reads every script under tests/, build/ and
// .pipeline/ so the rule doesn't depend on a reviewer noticing.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const SELF = 'tests/unit/test-hygiene.test.js';
const LOOPBACK = /^(['"`])(127\.0\.0\.1|localhost|::1)\1$/;
/** Tools whose listener takes its host from a parameter. Each must give that parameter a loopback default. */
const HOST_PARAMETER = new Set(['tests/tools/hls-server.mjs', 'tests/tools/mock-idp.mjs']);
/** capture-marketing.mjs takes screenshots for the website. A person runs it by hand, and it shows a window only when asked to. */
const HEADED_BY_HAND = new Set(['tests/tools/capture-marketing.mjs']);

/** The arguments of each `.listen(` call in a script, split at top-level commas. */
export function listenCalls(text) {
  const calls = [];
  for (const m of text.matchAll(/\.listen\(/g)) {
    const args = [];
    let depth = 0;
    let arg = '';
    for (let i = m.index + m[0].length; i < text.length; i++) {
      const c = text[i];
      if (c === ')' && depth === 0) break;
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c)) depth--;
      if (c === ',' && depth === 0) {
        args.push(arg.trim());
        arg = '';
      } else arg += c;
    }
    if (arg.trim()) args.push(arg.trim());
    calls.push(args);
  }
  return calls;
}

/** Why a script's listeners break the rule, or an empty list. */
export function listenProblems(text, hostParameter = false) {
  const out = [];
  if (/(['"`])(0\.0\.0\.0|::|\[::\])\1/.test(text)) out.push('names a wildcard address');
  for (const args of listenCalls(text)) {
    const host = args[1];
    if (host && LOOPBACK.test(host)) continue;
    if (host === 'host' && hostParameter && /\bhost = '127\.0\.0\.1'/.test(text)) continue;
    out.push(`listen(${args.join(', ')}) has no loopback host`);
  }
  return out;
}

/** Whether a script opens a browser window. */
export const headed = (text) => /\bheadless:\s*(?:false\b|!)|\bheaded:\s*true\b|--headed\b/.test(text);

const scripts = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'tests', 'build', '.pipeline', 'playwright.config.js', 'playwright.firefox.config.js', 'playwright.webkit.config.js'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.m?js$/.test(f) && f !== SELF && existsSync(f));
const read = (f) => readFileSync(f, 'latin1');

describe('the listener scan', () => {
  it('reads the host of a listen call, on one line or several', () => {
    expect(listenCalls("srv.listen(0, '127.0.0.1', r);")).toEqual([['0', "'127.0.0.1'", 'r']]);
    expect(listenCalls('http.createServer(f).listen(\n  port,\n  host,\n  () => done(a, b),\n);')).toEqual([['port', 'host', '() => done(a, b)']]);
    expect(listenCalls('srv.listen(port);')).toEqual([['port']]);
  });

  it('passes a loopback host and fails a missing, wildcard or unknown one', () => {
    expect(listenProblems("a.listen(0, '127.0.0.1', r); b.listen(0, 'localhost'); c.listen(0, '::1');")).toEqual([]);
    expect(listenProblems('srv.listen(8080);')).toEqual(['listen(8080) has no loopback host']);
    expect(listenProblems("srv.listen(0, '0.0.0.0');")).toEqual(['names a wildcard address', "listen(0, '0.0.0.0') has no loopback host"]);
    expect(listenProblems('srv.listen(0, addr);')).toEqual(['listen(0, addr) has no loopback host']);
  });

  it('passes a host parameter only in a listed tool that defaults it to loopback', () => {
    const tool = "export function start({ host = '127.0.0.1' } = {}) { srv.listen(0, host, r); }";
    expect(listenProblems(tool, true)).toEqual([]);
    expect(listenProblems(tool, false)).toEqual(['listen(0, host, r) has no loopback host']);
    expect(listenProblems('export function start({ host }) { srv.listen(0, host, r); }', true)).toEqual(['listen(0, host, r) has no loopback host']);
  });

  it('tells a headed launch from a headless one', () => {
    expect(headed('chromium.launch({ headless: false })')).toBe(true);
    expect(headed("chromium.launch({ headless: !args.includes('x') })")).toBe(true);
    expect(headed('npx playwright test --headed')).toBe(true);
    expect(headed("chromium.launch({ headless: true, channel: 'chrome' })")).toBe(false);
    expect(headed("chromium.launch({ channel: 'chrome' })")).toBe(false);
    expect(headed("app.commands.run('ts.trend', { headless: true }); const api = { headless: (src) => src };")).toBe(false);
  });
});

describe('tests and tools (docs/POLICY.md)', () => {
  it('finds the scripts', () => {
    expect(scripts.length).toBeGreaterThan(300);
    for (const f of [...HOST_PARAMETER, ...HEADED_BY_HAND]) expect(scripts, `${f} is listed here but is not a tracked script`).toContain(f);
  });

  it('every listener is on loopback', () => {
    const found = scripts.flatMap((f) => listenProblems(read(f), HOST_PARAMETER.has(f)).map((p) => `${f}: ${p}`));
    expect(found, "listen on loopback only: pass '127.0.0.1' as the host, as tests/e2e/helpers.js does").toEqual([]);
  });

  it('no script opens a browser window', () => {
    const found = scripts.filter((f) => headed(read(f)) && !HEADED_BY_HAND.has(f));
    expect(found, 'browsers run headless: take out the headed launch. Playwright is headless unless told otherwise').toEqual([]);
    expect([...HEADED_BY_HAND].filter((f) => !headed(read(f))), 'these no longer open a window: take them off HEADED_BY_HAND').toEqual([]);
  });
});
