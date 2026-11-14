// REG-097: the catalogue-osm pack. Its catalogue is built from the iD tagging schema's built files
// with the English names put back, through the importer's converter; its inputs are pinned at one
// schema version, ISC, with the licence file among them.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { osmCatalogue, OSM_SCHEMA_VERSION } from '../../build/packs.mjs';
import { validateCatalog, fieldsFor } from '../../app/src/vector/schema.js';

const src = JSON.parse(readFileSync('build/packs-sources.json', 'utf8'));
const fixture = (n) => JSON.parse(readFileSync(`fixtures/catalogs/${n}`, 'utf8'));

describe('REG-097 catalogue-osm pack', () => {
  // The built presets.json leaves names to the translation files, as the real one does.
  const presets = Object.fromEntries(Object.entries(fixture('id-presets.json')).map(([id, { name, ...p }]) => [id, p]));
  // Closed, so its options are a coded domain whose titles en.json gives (an open combo is text).
  const fields = { ...fixture('id-fields.json'), cuisine: { ...fixture('id-fields.json').cuisine, customValues: false } };
  const en = {
    en: {
      presets: {
        presets: { 'amenity/cafe': { name: 'Café' }, 'highway/residential': { name: 'Residential Road' } },
        fields: { cuisine: { label: 'Cuisine (food)', options: { coffee_shop: 'Coffee Shop', bakery: { title: 'Bakery', description: 'Bread' } } } },
      },
    },
  };

  it('takes the English names, labels and option titles from en.json, and validates', () => {
    const cat = validateCatalog(osmCatalogue(presets, fields, en));
    expect([cat.id, cat.version]).toEqual(['osm-id-presets', OSM_SCHEMA_VERSION]);
    expect(cat.types.map((t) => [t.code, t.name])).toEqual([
      ['amenity/cafe', 'Café'],
      ['highway/residential', 'Residential Road'],
    ]);
    expect(cat.attributes.cuisine).toMatchObject({ label: 'Cuisine (food)', type: 'enum', domain: { coffee_shop: 'Coffee Shop', bakery: 'Bakery' } });
    // A type fixes its tags: New Layer from Schema fills amenity=cafe in.
    expect(fieldsFor(cat, 'amenity/cafe', 'amenity/cafe').find((f) => f.name === 'amenity')).toMatchObject({ fixed: 'cafe' });
  });

  it('names a preset that en.json leaves out after its id, as the importer does', () => {
    const cat = osmCatalogue(presets, fields, { en: { presets: {} } });
    expect(cat.types.find((t) => t.code === 'highway/residential').name).toBe('Residential');
  });

  it('pins every input at the same schema version, ISC, with the licence file', () => {
    const ids = ['osm-id-presets', 'osm-id-fields', 'osm-id-en', 'osm-id-licence'];
    for (const id of ids) {
      const s = src.downloads.find((d) => d.id === id);
      expect(s, id).toBeTruthy();
      expect(s.url.startsWith(`https://cdn.jsdelivr.net/npm/@openstreetmap/id-tagging-schema@${OSM_SCHEMA_VERSION}/`)).toBe(true);
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.licence).toMatch(/^ISC \(Copyright \(c\) iD Contributors\)/);
    }
    expect(src.downloads.find((d) => d.id === 'osm-id-licence').url.endsWith('/LICENSE.md')).toBe(true);
  });
});
