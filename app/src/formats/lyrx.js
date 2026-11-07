// ArcGIS Pro layer files (.lyrx, CIM JSON; REQ-GAP-64): the symbology of feature layers read into
// the app's vector styles as far as they map — simple, unique-value (one field) and class-breaks
// renderers; solid fills and strokes, vector, simple and character markers (their colour and
// size), dashes, layer transparency and one label field. Everything else is refused by name in
// the result's `refused` list, so the caller can say exactly what was not applied. The CIM is
// Esri's published Cartographic Information Model (github.com/Esri/cim-spec, Apache-2.0).
// DOM-free.

import { gwError, N_, en } from '../i18n/index.js';

/** A refusal as a message (shown with tr(); `reason` and `what` keep its English text for logs and tests). */
const M = (src, params = null) => ({ src, params });
const item = (what, msg) => ({ what: en(what.src, what.params), reason: en(msg.src, msg.params), whatMsg: what, msg });
const W = { symbol: M(N_('symbol')), def: M(N_('default symbol')), renderer: M(N_('renderer')), unique: M(N_('unique values')), breaks: M(N_('class breaks')), labels: M(N_('labels')), layer: M(N_('layer')) };
const cls = (label) => M(N_('class {label}'), { label: String(label ?? '') });

const PT_PX = 96 / 72; // CIM sizes are points

const hex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
const rgbaHex = (r, g, b, a = 1) => `#${hex(r)}${hex(g)}${hex(b)}${a >= 1 ? '' : hex(a * 255)}`;

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}

/** A CIM colour → '#rrggbb' or '#rrggbbaa' (alpha × `opacity`), or null with the reason. */
export function cimColour(c, opacity = 1) {
  const no = (msg) => ({ colour: null, reason: en(msg.src, msg.params), msg });
  if (!c) return no(M(N_('no colour')));
  const v = Array.isArray(c.values) ? c.values.map(Number) : null;
  if (!v || v.some((x) => !Number.isFinite(x))) return no(M(N_('colour without values')));
  const alpha = (a) => (Number.isFinite(a) ? a / 100 : 1) * opacity;
  switch (c.type) {
    case 'CIMRGBColor':
      return { colour: rgbaHex(v[0], v[1], v[2], alpha(v[3])) };
    case 'CIMHSVColor': {
      const [r, g, b] = hsvToRgb(v[0], v[1] / 100, v[2] / 100);
      return { colour: rgbaHex(r, g, b, alpha(v[3])) };
    }
    case 'CIMCMYKColor': {
      const k = 1 - v[3] / 100;
      return { colour: rgbaHex(255 * (1 - v[0] / 100) * k, 255 * (1 - v[1] / 100) * k, 255 * (1 - v[2] / 100) * k, alpha(v[4])) };
    }
    case 'CIMGrayColor':
      return { colour: rgbaHex(v[0], v[0], v[0], alpha(v[1])) };
    default:
      return no(M(N_('colour model {type}'), { type: String(c.type) }));
  }
}

const symbolOf = (ref) => (ref?.type === 'CIMSymbolReference' ? ref.symbol : ref);

/**
 * One CIM symbol → {style, refused: [names]}. Symbol layers are drawn first-on-top in CIM, so the
 * first enabled stroke and fill are the visible ones; further layers are reported.
 */
export function symbolStyle(ref, { opacity = 1 } = {}) {
  const sym = symbolOf(ref);
  const refused = [];
  const style = {};
  if (!sym) return { style, refused: [M(N_('no symbol'))], kind: null };
  const kind = { CIMPolygonSymbol: 'polygon', CIMLineSymbol: 'line', CIMPointSymbol: 'point' }[sym.type] ?? null;
  if (!kind) return { style, refused: [M(N_('symbol type {type}'), { type: String(sym.type) })], kind: null };
  const layers = (sym.symbolLayers ?? []).filter((l) => l.enable !== false);
  let stroke = null;
  let fill = null;
  let marker = null;
  for (const l of layers) {
    if (l.type === 'CIMSolidStroke') {
      if (stroke) refused.push(M(N_('extra stroke layer')));
      else stroke = l;
    } else if (l.type === 'CIMSolidFill') {
      if (fill) refused.push(M(N_('extra fill layer')));
      else fill = l;
    } else if (['CIMVectorMarker', 'CIMSimpleMarker', 'CIMCharacterMarker'].includes(l.type)) {
      if (marker) refused.push(M(N_('extra marker layer')));
      else marker = l;
    } else refused.push(M(N_('symbol layer {type}'), { type: String(l.type) }));
  }
  if (kind === 'point') {
    if (!marker) refused.push(M(N_('point symbol without a vector, simple or character marker')));
    else {
      const size = Number(marker.size);
      if (Number.isFinite(size) && size > 0) style.radius = Math.max(1, (size * PT_PX) / 2);
      // The marker's colour: a character or simple marker's own, else its first graphic's fill and outline.
      let fc = null;
      let sc = null;
      let sw = null;
      if (marker.type === 'CIMCharacterMarker' || marker.type === 'CIMSimpleMarker') {
        const inner = marker.type === 'CIMCharacterMarker' ? symbolStyle(marker.symbol, { opacity }) : null;
        fc = inner?.style.fill ?? cimColour(marker.color ?? marker.fillColor, opacity).colour;
        sc = inner?.style.stroke ?? cimColour(marker.outlineColor, opacity).colour;
        if (marker.type === 'CIMCharacterMarker') refused.push(M(N_('character marker glyph (drawn as a circle)')));
      } else {
        const g = marker.markerGraphics?.[0];
        const inner = g ? symbolStyle(g.symbol, { opacity }) : null;
        fc = inner?.style.fill ?? null;
        sc = inner?.style.outline ?? inner?.style.stroke ?? null;
        sw = inner?.style.width ?? null;
        if ((marker.markerGraphics?.length ?? 0) > 1) refused.push(M(N_('marker graphics after the first')));
        refused.push(M(N_('marker shape (drawn as a circle)')));
      }
      style.stroke = fc ?? sc ?? '#000000';
      if (sc && fc) style.outline = sc;
      if (sw) style.width = sw;
    }
    if (stroke || fill) refused.push(M(N_('stroke or fill on a point symbol')));
  } else {
    if (stroke) {
      const c = cimColour(stroke.color, opacity);
      if (c.colour) style[kind === 'polygon' ? 'outline' : 'stroke'] = c.colour;
      else refused.push(c.msg);
      const w = Number(stroke.width);
      if (Number.isFinite(w)) style.width = Math.max(0, w * PT_PX);
      const dashes = (stroke.effects ?? []).find((e) => e.type === 'CIMGeometricEffectDashes');
      for (const e of stroke.effects ?? []) if (e.type !== 'CIMGeometricEffectDashes') refused.push(M(N_('stroke effect {type}'), { type: String(e.type) }));
      if (dashes?.dashTemplate?.length) style.dash = dashes.dashTemplate.map((d) => Number(d) * PT_PX).filter((d) => Number.isFinite(d) && d >= 0);
    }
    for (const e of sym.effects ?? []) refused.push(M(N_('symbol effect {type}'), { type: String(e.type) }));
    if (kind === 'polygon') {
      if (fill) {
        const c = cimColour(fill.color, opacity);
        if (c.colour) style.fill = c.colour;
        else refused.push(c.msg);
      } else style.fill = '#00000000';
      if (!stroke) style.outline = '#00000000';
      // The app's polygons take their outline from `outline`, and fall back to `stroke`.
      if (style.outline) style.stroke = style.outline;
    } else if (kind === 'line') {
      if (fill) refused.push(M(N_('fill on a line symbol')));
      if (!stroke) refused.push(M(N_('line symbol without a solid stroke')));
    }
  }
  return { style, refused, kind };
}

/** A label expression naming one field ($feature.NAME, [NAME], $feature["NAME"]) → the field, else null. */
export function labelField(expr) {
  const s = String(expr ?? '').trim();
  const m = /^\$feature\.([A-Za-z_][\w]*)$/.exec(s) ?? /^\$feature\[\s*["']([^"']+)["']\s*\]$/.exec(s) ?? /^\[([^\]]+)\]$/.exec(s);
  return m ? m[1] : null;
}

/**
 * One CIMFeatureLayer → {name, geometry, style, styleRules, label, refused: [{what, reason}],
 * mapped: [what]}. `styleRules` are the app's ordered rules ({filter: {field, op, value}, style});
 * the first match wins, as in features/attribution.js ruleStyle().
 */
export function featureLayerStyle(def) {
  const refused = [];
  const mapped = [];
  const opacity = 1 - Math.max(0, Math.min(100, Number(def.transparency) || 0)) / 100;
  const r = def.renderer;
  let style = {};
  let rules = [];
  let geometry = null;
  const sym = (ref, what) => {
    const s = symbolStyle(ref, { opacity });
    for (const x of s.refused) refused.push(item(what, x));
    geometry ??= s.kind;
    return s.style;
  };
  if (!r) refused.push(item(W.renderer, M(N_('the layer has no renderer'))));
  else if (r.type === 'CIMSimpleRenderer') {
    style = sym(r.symbol, W.symbol);
    mapped.push('simple renderer');
  } else if (r.type === 'CIMUniqueValueRenderer') {
    const fields = r.fields ?? [];
    if (fields.length !== 1) refused.push(item(W.unique, M(N_('{n, plural, one {# field} other {# fields}} (one field only)'), { n: fields.length })));
    else {
      const field = fields[0];
      style = r.useDefaultSymbol === false || !r.defaultSymbol ? { stroke: '#00000000', fill: '#00000000', outline: '#00000000' } : sym(r.defaultSymbol, W.def);
      for (const g of r.groups ?? []) {
        for (const c of g.classes ?? []) {
          if (c.visible === false) continue;
          const st = sym(c.symbol, cls(c.label));
          for (const v of c.values ?? []) {
            const fv = v.fieldValues ?? [];
            if (fv.length !== 1) refused.push(item(cls(c.label), M(N_('value of several fields'))));
            else rules.push({ filter: { field, op: '=', value: String(fv[0]) }, style: st, label: c.label ?? String(fv[0]) });
          }
        }
      }
      mapped.push(`unique values on ${field} (${rules.length})`);
    }
  } else if (r.type === 'CIMClassBreaksRenderer') {
    const field = r.field;
    if (!field) refused.push(item(W.breaks, M(N_('no field'))));
    else {
      if (r.normalizationType && r.normalizationType !== 'Nothing' && r.normalizationType !== 'esriNormalizeByNothing') refused.push(item(W.breaks, M(N_('normalisation {type} (breaks are applied to the raw field)'), { type: String(r.normalizationType) })));
      if (r.classBreakType && !['GraduatedColor', 'GraduatedSymbol'].includes(r.classBreakType)) refused.push(item(W.breaks, M(N_('type {type}'), { type: String(r.classBreakType) })));
      const def0 = r.useDefaultSymbol && r.defaultSymbol ? sym(r.defaultSymbol, W.def) : { stroke: '#00000000', fill: '#00000000', outline: '#00000000' };
      style = def0;
      const breaks = (r.breaks ?? []).slice().sort((a, b) => Number(a.upperBound) - Number(b.upperBound));
      if (Number.isFinite(Number(r.minimumBreak))) rules.push({ filter: { field, op: '<', value: Number(r.minimumBreak) }, style: def0, label: N_('below the minimum') });
      for (const b of breaks) {
        const ub = Number(b.upperBound);
        if (!Number.isFinite(ub)) {
          refused.push(item(cls(b.label), M(N_('no upper bound'))));
          continue;
        }
        rules.push({ filter: { field, op: '≤', value: ub }, style: sym(b.symbol, cls(b.label ?? ub)), label: b.label ?? String(ub) });
      }
      mapped.push(`class breaks on ${field} (${breaks.length})`);
    }
  } else refused.push(item(W.renderer, M(N_('renderer {type}'), { type: String(r.type) })));
  if (r?.visualVariables?.length) refused.push(item(W.renderer, M(N_('visual variables'))));
  if (r?.rotation || r?.visualVariables?.some?.((v) => /Rotation/.test(v.type))) refused.push(item(W.renderer, M(N_('rotation'))));
  // Labels: the first visible class whose expression names one field.
  const lcs = (def.labelClasses ?? []).filter((l) => l.visibility !== false);
  if (def.labelVisibility !== false && lcs.length) {
    const lc = lcs[0];
    const f = labelField(lc.expression);
    if (f) {
      style.labelField = f;
      const ts = symbolOf(lc.textSymbol);
      const h = Number(ts?.height);
      if (Number.isFinite(h) && h > 0) style.labelSize = Math.round(h * PT_PX);
      const inner = ts?.symbol ? symbolStyle(ts.symbol) : null;
      if (inner?.style.fill && inner.style.fill !== '#00000000') style.labelColour = inner.style.fill;
      mapped.push(`labels from ${f}`);
      if (lcs.length > 1) refused.push(item(W.labels, M(N_('label classes after the first'))));
      if (lc.whereClause) refused.push(item(W.labels, M(N_('label class SQL query'))));
    } else refused.push(item(W.labels, M(N_('expression {text}'), { text: String(lc.expression ?? '').slice(0, 80) })));
  }
  if (def.minScale || def.maxScale) refused.push(item(W.layer, M(N_('scale range'))));
  if (def.featureTable?.definitionExpression) refused.push(item(W.layer, M(N_('definition query {text}'), { text: String(def.featureTable.definitionExpression).slice(0, 80) })));
  if (def.featureReduction) refused.push(item(W.layer, M(N_('clustering or binning'))));
  if (def.featureEffects ?? def.effects?.length) refused.push(item(W.layer, M(N_('layer effects'))));
  return { name: String(def.name ?? ''), geometry, style, styleRules: rules, refused, mapped, visible: def.visibility !== false };
}

/** A whole .lyrx (CIMLayerDocument) → {version, layers: [featureLayerStyle], refused: [{name, type}] for non-feature layers}. */
export function readLyrx(text) {
  let doc;
  try {
    doc = typeof text === 'string' ? JSON.parse(text.replace(/^﻿/, '')) : text;
  } catch {
    throw gwError('the layer file is not JSON: it may be an older binary .lyr file, which is not read', null, 'E_LYRX_JSON');
  }
  if (doc?.type !== 'CIMLayerDocument' || !Array.isArray(doc.layerDefinitions)) throw gwError('the file is not an ArcGIS Pro layer file (CIMLayerDocument)', null, 'E_LYRX_TYPE');
  const layers = [];
  const refused = [];
  const walk = (defs) => {
    for (const d of defs) {
      if (d.type === 'CIMFeatureLayer' || d.type === 'CIMGeoFeatureLayer') layers.push(featureLayerStyle(d));
      else if (d.type !== 'CIMGroupLayer') refused.push({ name: String(d.name ?? ''), type: String(d.type ?? '?') });
    }
  };
  walk(doc.layerDefinitions);
  if (!layers.length) throw gwError('the layer file holds no feature layer ({types})', { types: refused.map((r) => r.type).join(', ') || 'empty' }, 'E_LYRX_NO_FEATURE_LAYER');
  return { version: doc.version ?? null, layers, refused };
}

/** The renderer's fields that the target layer does not have (so the rules would never match). */
export function missingFields(layerStyle, fieldNames) {
  const have = new Set(fieldNames.map((f) => String(f).toLowerCase()));
  const need = new Set([...layerStyle.styleRules.map((r) => r.filter.field), layerStyle.style.labelField].filter(Boolean));
  return [...need].filter((f) => !have.has(f.toLowerCase()));
}
