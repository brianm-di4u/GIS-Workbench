// OD-2.23 (REQ-HOST-05): the profile mechanism and the Lite command list gate. Every command is in
// Full; a command is in Lite only when data/lite-commands.json lists it in a group with a reason;
// every Lite command is catalogued, implemented by a module the Lite build installs, and offered by
// the mobile shell; nothing that needs a desktop is in Lite; the Lite build refuses the rest by name.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import LITE from '../../app/src/data/lite-commands.json';
import { LITE_COMMANDS, LITE_GROUPS, profilesOf, buildProfile, inProfile } from '../../app/src/core/profile.js';
import { Commands } from '../../app/src/shell/commands.js';

const src = resolve('app/src');
const read = (rel) => readFileSync(join(src, rel), 'utf8');
const ids = LITE.groups.flatMap((g) => g.commands);

/** Full-only areas (the brief's "leave out" list and the desktop shell). Save, Open Project and
 * Relink Imagery joined Lite with the Lite project file (OD-2.40, REQ-GAP-86). */
const DESKTOP_ONLY = /^(stereo|3d|pc|sar|fmv|mie|sidecar|tri|ortho|align|model|lai|ai|rcp|hub|cnv|ext|prod|tpl|snap|chip|report|meta|dem|los|svc|det|vec|deck|patrol|triage|wb|auto|win|ws|dock|ribbon|ui|hud|glb|cat|pack|packs|tiles|vt|online|bg|link|ov|cmp|chg|img|bands|clip|profile|search|keys|input|display|theme|view|deco|panel|gfx|gps|sel|lay)\.|^msi\.(?!preset\.)|^file\.(saveas|saveoptions|newproject|recent|print|opendem|openpointcloud|openurl|geopdf|projectprops)$|^men\.(height|target|bracket|depth|medial|centre|log|tracking|targettable)$/;

/** The source files whose code the Lite build installs: mobile/features.js imports, and what mobile/* modules import. */
function liteSources() {
  const files = new Set();
  const add = (rel, follow) => {
    if (files.has(rel)) return;
    files.add(rel);
    if (!follow) return;
    for (const m of read(rel).matchAll(/^import [^;]*? from '(\.\.?\/[^']+\.js)';/gm)) {
      const r = relative(src, resolve(join(src, dirname(rel)), m[1])).replace(/\\/g, '/');
      add(r, r.startsWith('mobile/'));
    }
  };
  add('mobile/features.js', true);
  files.delete('mobile/features.js');
  return [...files];
}

describe('the Lite command list (data/lite-commands.json)', () => {
  it('is a list of groups, each with an id, a title, a reason and commands', () => {
    expect(LITE.format).toBe('gw-lite-commands/1');
    expect(LITE.groups.length).toBeGreaterThan(3);
    for (const g of LITE.groups) {
      expect(g.id, JSON.stringify(g)).toMatch(/^[a-z]+$/);
      expect(g.title.length, g.id).toBeGreaterThan(3);
      expect(g.reason.length, `${g.id}: a reason in words`).toBeGreaterThanOrEqual(40);
      expect(g.commands.length, g.id).toBeGreaterThan(0);
    }
    expect(new Set(LITE.groups.map((g) => g.id)).size).toBe(LITE.groups.length);
  });

  it('names each command once', () => {
    expect(new Set(ids).size, ids.filter((x, i) => ids.indexOf(x) !== i).join(', ')).toBe(ids.length);
    expect(LITE_COMMANDS.size).toBe(ids.length);
    expect(LITE_GROUPS).toBe(LITE.groups);
  });

  it('names only catalogued commands', () => {
    const C = new Commands({});
    expect(ids.filter((id) => !C.get(id))).toEqual([]);
  });

  it('leaves out everything that needs a desktop (photogrammetry, stereo, 3D, LiDAR, SAR, video, sidecar, heavy AI, products, editing)', () => {
    expect(ids.filter((id) => DESKTOP_ONLY.test(id))).toEqual([]);
  });

  it('every Lite command is implemented by a module the Lite build installs', () => {
    const files = liteSources();
    expect(files).toContain('features/field-lazy.js');
    expect(files).toContain('tools/tools.js');
    expect(files.some((f) => /features\/index\.js$|shell\/(desktop|ribbon|multiport|docks)\.js$|shell2\//.test(f)), files.join(' ')).toBe(false);
    const text = files.map((f) => read(f)).join('\n');
    const missing = ids.filter((id) => {
      const prefix = id.slice(0, id.lastIndexOf('.') + 1);
      // A literal id, or one built from a template (`draw.${shape}`, `msi.preset.${k}`).
      return !text.includes(`'${id}'`) && !text.includes(`"${id}"`) && !text.includes(`\`${prefix}\${`);
    });
    expect(missing).toEqual([]);
  }, 30000);

  it('every command the mobile shell offers is a Lite command, and every Lite command is offered', () => {
    const shell = read('mobile/shell.js');
    const block = /export const SHEETS = \{([\s\S]*?)\n\};[\s\S]*?const FAB = \[([^\]]*)\]/.exec(shell);
    const offered = new Set([...`${block[1]}${block[2]}`.matchAll(/'([a-z0-9]+\.[a-z0-9.]+)'/g)].map((m) => m[1]));
    for (const m of shell.matchAll(/cmdButton\('([a-z0-9.]+)'/g)) offered.add(m[1]);
    for (const m of shell.matchAll(/commands\.run\('([a-z0-9.]+)'/g)) offered.add(m[1]);
    expect([...offered].filter((id) => !LITE_COMMANDS.has(id))).toEqual([]);
    expect(ids.filter((id) => !offered.has(id))).toEqual([]);
  });
});

describe('the profile mechanism (core/profile.js, shell/commands.js)', () => {
  it('tags every command: Full only by default, Full and Lite when listed', () => {
    const C = new Commands({});
    for (const c of C.list()) expect(c.profiles, c.id).toEqual(LITE_COMMANDS.has(c.id) ? ['full', 'lite'] : ['full']);
    expect(profilesOf('stereo.open')).toEqual(['full']);
    expect(profilesOf('men.rangebearing')).toEqual(['full', 'lite']);
  });

  it('a command added later (define) is Full only unless listed', () => {
    const C = new Commands({});
    C.define({ id: 'x.new', label: 'New thing', run: () => 1 });
    expect(C.get('x.new').profiles).toEqual(['full']);
    C.define({ id: 'men.area', label: 'Area', run: () => 1 });
    expect(C.get('men.area').profiles).toEqual(['full', 'lite']);
  });

  it('reads the build profile from the manifest', () => {
    expect(buildProfile({ manifest: { build: { profile: 'lite' } } })).toBe('lite');
    expect(buildProfile({ manifest: { build: { profile: 'standard' } } })).toBe('full');
    expect(buildProfile({ manifest: { build: { profile: 'airgap' } } })).toBe('full');
    expect(buildProfile(undefined)).toBe('full');
    expect(inProfile('stereo.open', 'full')).toBe(true);
    expect(inProfile('stereo.open', 'lite')).toBe(false);
  });

  it('the Lite build refuses a Full-only command by name and greys it out; Full runs everything', async () => {
    const toasts = [];
    const lite = new Commands({ gw: { manifest: { build: { profile: 'lite' } } }, toast: (m, o) => toasts.push([m, o?.kind]) });
    let ran = 0;
    lite.implement('stereo.open', { run: () => ran++ });
    lite.implement('men.area', { run: () => ran++ });
    expect(lite.profile).toBe('lite');
    expect(lite.inBuild('stereo.open')).toBe(false);
    expect(lite.enabled('stereo.open')).toBe(false);
    expect(lite.liteGap('stereo.open')).toMatch(/Full edition only/);
    expect(lite.liteGap('men.area')).toBe(null);
    await lite.run('stereo.open');
    await lite.run('men.area');
    expect(ran).toBe(1);
    expect(toasts[0][0]).toMatch(/Stereo Panel is in the Full edition only/);
    const full = new Commands({ gw: { manifest: { build: { profile: 'standard' } } } });
    full.implement('stereo.open', { run: () => ran++ });
    expect(full.liteGap('stereo.open')).toBe(null);
    await full.run('stereo.open');
    expect(ran).toBe(2);
  });
});

describe('the Lite size gate (build/gates.mjs)', async () => {
  const { liteSizeGate, LIMITS } = await import('../../build/gates.mjs');
  it('fails over 5.5 MB, warns within 5 % of it, and passes below', () => {
    expect(LIMITS.liteFail).toBe(5.5 * 1024 * 1024);
    expect(liteSizeGate({ total: 4e6 })).toEqual({ errors: [], warnings: [] });
    expect(liteSizeGate({ total: LIMITS.liteFail * 0.97 }).warnings.length).toBe(1);
    expect(liteSizeGate({ total: LIMITS.liteFail + 1 }).errors[0]).toMatch(/over its 5\.5 MB limit/);
    expect(liteSizeGate({ total: 0 }).errors.length).toBe(1);
  });
});
