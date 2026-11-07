// REQ-GAP-52/53: the open feature-catalogue format (gw-catalog/1): validation of a user's file,
// subtypes, conditional attribute rules and contingent domains, and the shipped subset still valid.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateCatalog, fieldsFor, ruleIssues, contingentDomain, checkAttrs, nullOf, DEFAULT_CATALOG, registerCatalog, getCatalog, subtypeOf, CATALOG_FORMAT } from '../../app/src/vector/schema.js';

/** A small catalogue in the shape the NAS / GGDM conversion produces (fixtures/fx24/extai). */
const SAMPLE = JSON.parse(readFileSync('fixtures/fx24/extai/mini-ggdm.gwcatalog.json', 'utf8'));

describe('REQ-GAP-52 catalogue validation', () => {
  it('accepts the sample and the shipped TDS 7.1 subset', () => {
    const c = validateCatalog(SAMPLE);
    expect(c.types).toHaveLength(2);
    expect(c.rules).toHaveLength(1);
    expect(c.types[1].subtypes.map((s) => s.code)).toEqual(['AQ040', 'AQ041']);
    const d = validateCatalog(DEFAULT_CATALOG);
    expect(d.types.length).toBe(DEFAULT_CATALOG.types.length);
  });

  it('refuses bad files, naming the problem', () => {
    const bad = (mut, re) => {
      const c = JSON.parse(JSON.stringify(SAMPLE));
      mut(c);
      let err;
      try {
        validateCatalog(c);
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe('E_CATALOG_INVALID');
      expect(err.message).toMatch(re);
    };
    bad((c) => (c.format = 'gw-catalog/9'), /not a feature catalogue/);
    bad((c) => (c.id = 'has space'), /catalogue id/);
    bad((c) => delete c.name, /no name/);
    bad((c) => (c.types = []), /no feature types/);
    bad((c) => c.types[0].attributes.push('NOPE'), /unknown attribute NOPE/);
    bad((c) => (c.attributes.HGT.range = [5, 1]), /bad range/);
    bad((c) => (c.attributes.FFN = { type: 'enum' }), /enumeration without a domain/);
    bad((c) => (c.types[0].rules[0].then.domain.BUI = [77]), /77 is not a code of BUI/);
    bad((c) => (c.types[0].rules[0].when = { field: 'X', op: '=' }), /unknown attribute X/);
    bad((c) => (c.types[0].rules[0].when.op = '=~'), /unknown operator/);
    bad((c) => (c.types[1].subtypes[0].domains.LOC = [99]), /outside its domain/);
    bad((c) => (c.rules[0].classes = ['ZZ999']), /not in the catalogue/);
    bad((c) => c.types.push({ ...c.types[0] }), /appears twice/);
    bad((c) => (c.attributes.__proto__ = { type: 'text' }) && Object.defineProperty(c.attributes, '__proto__', { value: { type: 'text' }, enumerable: true }), /not allowed/);
  });
});

describe('REQ-GAP-53 subtypes, conditional rules and contingent domains', () => {
  const cat = registerCatalog(validateCatalog(SAMPLE));

  it('a subtype adds attributes, narrows domains and fixes values', () => {
    expect(getCatalog('test-ggdm-mini')).toBe(cat);
    const road = fieldsFor(cat, 'AQ040', 'AQ040');
    expect(road.map((f) => f.name)).toEqual(['F_CODE', 'RLE', 'LOC', 'BRR']);
    expect(Object.keys(road.find((f) => f.name === 'LOC').domain).sort()).toEqual(['-999999', '17', '25']);
    const foot = fieldsFor(cat, 'AQ040', 'AQ041');
    expect(foot.find((f) => f.name === 'RLE').fixed).toBe(1);
    expect(Object.keys(foot.find((f) => f.name === 'RLE').domain)).toEqual(['1']);
    expect(subtypeOf(cat, 'AQ040', 'AQ041').name).toBe('Footbridge');
    expect(() => fieldsFor(cat, 'AQ040', 'AQ999')).toThrow(/no subtype AQ999/);
    const sch = { code: 'AQ040', subtype: 'AQ041' };
    expect(ruleIssues(cat, sch, foot, { RLE: 2 }).map((i) => i.code)).toEqual(['E_SUBTYPE_FIXED']);
    expect(ruleIssues(cat, sch, foot, { RLE: 1 })).toEqual([]);
  });

  it('a contingent domain narrows a coded attribute when the condition holds', () => {
    const fs = fieldsFor(cat, 'AL013');
    const sch = { code: 'AL013' };
    const nul = String(nullOf(cat, fs.find((f) => f.name === 'BUI')));
    expect(Object.keys(contingentDomain(cat, sch, fs, 'BUI', { FFN: 850 })).sort()).toEqual([nul, '1', '2'].sort());
    expect(Object.keys(contingentDomain(cat, sch, fs, 'BUI', { FFN: 860 })).sort()).toEqual([nul, '3', '4'].sort());
    expect(Object.keys(contingentDomain(cat, sch, fs, 'BUI', { FFN: 2 })).length).toBe(7);
    const iss = ruleIssues(cat, sch, fs, { FFN: 850, BUI: 3 });
    expect(iss).toHaveLength(1);
    expect(iss[0]).toMatchObject({ field: 'BUI', code: 'E_RULE_DOMAIN', rule: 'edu-use' });
    expect(iss[0].message).toMatch(/3 is not allowed here \(education buildings are schools or universities\)\. Allowed: 1 School; 2 University/);
  });

  it('require, forbid and contingent range rules', () => {
    const fs = fieldsFor(cat, 'AL013');
    const sch = { code: 'AL013' };
    expect(ruleIssues(cat, sch, fs, { FFN: 931, ZI005_FNA: 'noInformation' }).map((i) => i.code)).toEqual(['E_RULE_REQUIRED']);
    expect(ruleIssues(cat, sch, fs, { FFN: 931, ZI005_FNA: 'St Mary' })).toEqual([]);
    expect(ruleIssues(cat, sch, fs, { FFN: 850, BUI: 2, HGT: 1 }).map((i) => i.code)).toEqual(['E_RULE_RANGE']);
    expect(ruleIssues(cat, sch, fs, { FFN: 850, BUI: 2, HGT: 20 })).toEqual([]);
    const br = fieldsFor(cat, 'AQ040');
    expect(ruleIssues(cat, { code: 'AQ040' }, br, { LOC: 23, RLE: 1 }).map((i) => i.code)).toEqual(['E_RULE_FORBIDDEN']);
    expect(ruleIssues(cat, { code: 'AQ040' }, br, { LOC: 23, RLE: '-999999' })).toEqual([]);
  });

  it('checkAttrs reports value and rule issues together, once per field and code', () => {
    const fs = fieldsFor(cat, 'AL013');
    const out = checkAttrs(cat, fs, { FFN: 850, BUI: 5, HGT: 2000 }, { code: 'AL013' });
    expect(out.map((o) => `${o.field}:${o.code}`).sort()).toEqual(['BUI:E_RULE_DOMAIN', 'HGT:E_ATTR_RANGE']);
    // Without a schema (a plain layer) no rules run.
    expect(checkAttrs(cat, fs, { FFN: 850, BUI: 5 }).map((o) => o.code)).toEqual([]);
  });
});
