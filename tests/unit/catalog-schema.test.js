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

describe('#249 rules and subtypes on an attribute that names its column (decision #243)', () => {
  // Road and Bridge both write the column status, each with its own definition.
  const cat = validateCatalog({
    format: 'gw-catalog/1', id: 't249', name: 'T249', nulls: { text: '', enum: '', number: null },
    attributes: { status: { type: 'enum', domain: { open: 'Open', closed: 'Closed' } }, status_Bridge: { type: 'enum', field: 'status', domain: { raised: 'Raised', lowered: 'Lowered', closed: 'Closed' } }, kind: { type: 'enum', domain: { x: 'X', y: 'Y' } }, note: { type: 'text' } },
    types: [
      { code: 'Road', name: 'Road', geometry: ['LineString'], attributes: ['status'] },
      { code: 'Bridge', name: 'Bridge', geometry: ['LineString'], attributes: ['kind', 'status_Bridge', 'note'],
        subtypeField: 'status_Bridge', subtypes: [{ code: 'lowered', name: 'Lowered', fixed: { status_Bridge: 'lowered' } }],
        rules: [{ id: 'closed-note', when: { field: 'status_Bridge', value: 'closed' }, then: { require: ['note'] } }, { id: 'x-raised', when: { field: 'kind', value: 'x' }, then: { domain: { status_Bridge: ['raised'] } } }] },
    ],
  });
  const fs = fieldsFor(cat, 'Bridge');
  const schema = { code: 'Bridge' };
  it('applies a rule on the attribute to its column', () => {
    expect(fs.map((f) => f.name)).toEqual(['kind', 'status', 'note']);
    // The condition reads the status column; the requirement and the contingent domain name it.
    expect(ruleIssues(cat, schema, fs, { status: 'closed', note: '' }).map((o) => `${o.field}:${o.code}`)).toEqual(['note:E_RULE_REQUIRED']);
    expect(ruleIssues(cat, schema, fs, { status: 'closed', note: 'shut for works' })).toEqual([]);
    expect(ruleIssues(cat, schema, fs, { kind: 'x', status: 'lowered' }).map((o) => `${o.field}:${o.code}`)).toEqual(['status:E_RULE_DOMAIN']);
    expect(Object.keys(contingentDomain(cat, schema, fs, 'status', { kind: 'x' }))).toEqual(['raised']);
    expect(Object.keys(contingentDomain(cat, schema, fs, 'status', { kind: 'y' }))).toEqual(['raised', 'lowered', 'closed']);
  });
  it('fixes a subtype value on the column', () => {
    const f = fieldsFor(cat, 'Bridge', 'lowered').find((x) => x.name === 'status');
    expect(f.fixed).toBe('lowered');
    expect(ruleIssues(cat, { code: 'Bridge', subtype: 'lowered' }, fieldsFor(cat, 'Bridge', 'lowered'), { status: 'raised' }).map((o) => `${o.field}:${o.code}`)).toEqual(['status:E_SUBTYPE_FIXED']);
  });
});

describe('#249 a rule on one type\'s own key leaves another type\'s column of the same name alone', () => {
  const cat = validateCatalog({
    format: 'gw-catalog/1', id: 't249b', name: 'T249b', nulls: { text: '', enum: '', number: null },
    attributes: { status: { type: 'enum', domain: { open: 'Open', closed: 'Closed' } }, status_Bridge: { type: 'enum', field: 'status', domain: { raised: 'Raised', closed: 'Closed' } }, kind: { type: 'enum', domain: { x: 'X' } }, note: { type: 'text' }, span_Bridge: { type: 'real', field: 'span' } },
    types: [
      { code: 'Road', name: 'Road', geometry: ['LineString'], attributes: ['kind', 'status', 'note'] },
      { code: 'Bridge', name: 'Bridge', geometry: ['LineString'], attributes: ['kind', 'status_Bridge', 'note', 'span_Bridge'] },
    ],
    // Catalogue rules, for every type: each names Bridge's own keys.
    rules: [{ id: 'g1', when: { field: 'kind', value: 'x' }, then: { domain: { status_Bridge: ['raised'] }, forbid: ['note'], range: { span_Bridge: [0, 100] } } }, { id: 'g2', when: { field: 'status_Bridge', value: 'closed' }, then: { require: ['note'] } },
      // And one naming Road's own status, which Bridge's status column is not.
      { id: 'g3', when: { field: 'kind', value: 'x' }, then: { domain: { status: ['open'] } } }],
  });
  it('applies them to Bridge, by column', () => {
    const fs = fieldsFor(cat, 'Bridge');
    const got = ruleIssues(cat, { code: 'Bridge' }, fs, { kind: 'x', status: 'closed', note: 'n', span: 250 }).map((o) => `${o.field}:${o.code}`).sort();
    expect(got).toEqual(['note:E_RULE_FORBIDDEN', 'span:E_RULE_RANGE', 'status:E_RULE_DOMAIN']);
    expect(Object.keys(contingentDomain(cat, { code: 'Bridge' }, fs, 'status', { kind: 'x' }))).toEqual(['raised']);
  });
  it('not to Road, whose status is its own attribute', () => {
    const fs = fieldsFor(cat, 'Road');
    expect(ruleIssues(cat, { code: 'Road' }, fs, { kind: 'x', status: 'open', note: '' })).toEqual([]);
    expect(ruleIssues(cat, { code: 'Road' }, fs, { status: 'closed', note: '' })).toEqual([]);
    expect(Object.keys(contingentDomain(cat, { code: 'Road' }, fs, 'status', { kind: 'x' }))).toEqual(['open']);
  });
  it('and a rule on Road\'s own status leaves Bridge\'s status column alone', () => {
    const fs = fieldsFor(cat, 'Bridge');
    expect(ruleIssues(cat, { code: 'Bridge' }, fs, { kind: 'x', status: 'raised', note: '' }).map((o) => `${o.field}:${o.code}`)).toEqual([]);
    expect(Object.keys(contingentDomain(cat, { code: 'Bridge' }, fs, 'status', { kind: 'x' }))).toEqual(['raised']);
  });
});
