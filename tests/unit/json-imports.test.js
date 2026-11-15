// #262: every JSON module the app imports carries `with { type: 'json' }`, so Node (the converters and
// the unit tests) loads the same module the bundler does.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const files = execFileSync('git', ['ls-files', 'app/src'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(m?js)$/.test(f));
// Static imports and re-exports (`import … from`, `export … from`) and dynamic `import('…')` of a .json file.
const STATIC = /^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+\.json)['"]\s*([^;\n]*);?/gm;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+\.json)['"]\s*(,[^)]*)?\)/g;
const ATTRIBUTE = /\{\s*(?:with:\s*\{\s*)?type:\s*['"]json['"]/;
// Named imports a JSON module allows only through the bundler, kept so it can drop the rest of the file.
// fonts.js takes two small tables from ui-tokens.json (about 2 KB): a default import would put the whole
// file (about 64 KB) into the app script, and the app already loads it as the lazy data-tokens block.
const NAMED = new Set(['app/src/i18n/fonts.js: ../data/ui-tokens.json']);

const imports = files.flatMap((f) => {
  const text = readFileSync(f, 'utf8');
  return [
    ...[...text.matchAll(STATIC)].map((m) => ({ at: `${f}: ${m[1]}`, attr: m[2], named: /^\s*(?:import|export)\s*\{/.test(m[0]) })),
    ...[...text.matchAll(DYNAMIC)].map((m) => ({ at: `${f}: ${m[1]}`, attr: m[2] ?? '', named: false })),
  ];
});

describe('JSON imports', () => {
  it('all carry the json import attribute, but the named ones the bundler needs', () => {
    expect(imports.filter((i) => !NAMED.has(i.at) && !ATTRIBUTE.test(i.attr)).map((i) => i.at)).toEqual([]);
  });

  it('import a JSON module by its default export, but the listed exceptions', () => {
    expect(imports.filter((i) => i.named && !NAMED.has(i.at)).map((i) => i.at)).toEqual([]);
    // An exception that no longer exists is taken off the list.
    expect([...NAMED].filter((at) => !imports.some((i) => i.at === at))).toEqual([]);
  });

  it('reads every form, so a bare re-export or dynamic import would be caught', () => {
    const probe = "export { default as X } from './x.json';\nconst y = await import('./y.json');\nimport z from './z.json' with { type: 'json' };";
    const seen = [...probe.matchAll(STATIC), ...probe.matchAll(DYNAMIC)].map((m) => [m[1], ATTRIBUTE.test(m[2] ?? '')]);
    expect(seen).toEqual([['./x.json', false], ['./z.json', true], ['./y.json', false]]);
    expect(imports.length).toBeGreaterThan(0);
  });
});
