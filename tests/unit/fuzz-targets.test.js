// REVIEW.md asks that a new parser of untrusted input has a fuzz target in crates/gw-fuzz, and a
// reviewer had to notice when one didn't. gw-parse and gw-codec are the crates whose modules read
// bytes a user supplies, so this holds the rule for them: each public module is named by a fuzz
// test. ENVI headers, the scene metadata readers and the MPEG-2 decoder had no target until this
// check was written. A module that reads no file format goes in NOT_A_PARSER with its reason.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

const CRATES = ['gw-parse', 'gw-codec'];
const NOT_A_PARSER = new Map([['gw-parse/bytes', 'the bounds-checked reader the parsers share, exercised by every target']]);

/** The public modules a crate's lib.rs declares. */
export const publicModules = (lib) => [...lib.matchAll(/^pub mod ([a-z0-9_]+)\s*;/gm)].map((m) => m[1]);

/** Whether Rust source uses a module of a crate, as `gw_parse::dted::…` or through `use gw_parse::{dted, …}`. */
export function usesModule(source, crate, mod) {
  const id = crate.replace(/-/g, '_');
  if (new RegExp(`\\b${id}::${mod}\\b`).test(source)) return true;
  return [...source.matchAll(new RegExp(`\\buse ${id}::\\{([^}]*)\\}`, 'g'))].some((m) => new RegExp(`(^|[\\s,{])${mod}\\b`).test(m[1]));
}

const fuzz = readdirSync('crates/gw-fuzz/tests')
  .filter((f) => f.endsWith('.rs'))
  .map((f) => readFileSync(`crates/gw-fuzz/tests/${f}`, 'utf8'))
  .join('\n');

describe('the module scan', () => {
  it('lists public modules, and not private or conditional lines it cannot read as one', () => {
    expect(publicModules('pub mod dted;\nmod hidden;\n#[cfg(feature = "j2k")]\npub mod j2k;\n// pub mod gone;\n')).toEqual(['dted', 'j2k']);
  });

  it('finds a module used by path or in a use list, and not one that only shares a prefix', () => {
    expect(usesModule('let _ = gw_parse::dted::parse_dted(b);', 'gw-parse', 'dted')).toBe(true);
    expect(usesModule('use gw_parse::{hfa, netcdf3};\nhfa::parse(b);', 'gw-parse', 'netcdf3')).toBe(true);
    expect(usesModule('gw_parse::pdfvec::scan(b);', 'gw-parse', 'pdf')).toBe(false);
    expect(usesModule('gw_codec::dted::x(b); // dted in another crate', 'gw-parse', 'dted')).toBe(false);
  });
});

describe('fuzz targets (REVIEW.md)', () => {
  it('every public module of gw-parse and gw-codec is named by a fuzz test', () => {
    const missing = [];
    let seen = 0;
    for (const crate of CRATES) {
      for (const mod of publicModules(readFileSync(`crates/${crate}/src/lib.rs`, 'utf8'))) {
        seen++;
        if (!NOT_A_PARSER.has(`${crate}/${mod}`) && !usesModule(fuzz, crate, mod)) missing.push(`${crate}/${mod}`);
      }
    }
    expect(seen).toBeGreaterThan(25);
    expect(missing, 'a parser with no fuzz target: add one to a test in crates/gw-fuzz/tests that feeds it mutated seeds and asserts it ran. See the envi target in fuzz.rs').toEqual([]);
  });

  it('every module excused from the rule still exists', () => {
    const all = new Set(CRATES.flatMap((c) => publicModules(readFileSync(`crates/${c}/src/lib.rs`, 'utf8')).map((m) => `${c}/${m}`)));
    expect([...NOT_A_PARSER.keys()].filter((k) => !all.has(k)), 'these modules are gone: take them off NOT_A_PARSER').toEqual([]);
  });
});
