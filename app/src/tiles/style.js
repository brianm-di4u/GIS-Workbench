// Default vector-tile style (FC-07, REQ-FMT-32, S-46): a light topographic look for the two
// common schemas — Protomaps basemaps (earth, water, landuse, roads, buildings, places…) and
// OpenMapTiles as served by OpenFreeMap (water, landcover, transportation, building, place…) —
// and a generic fallback (a colour per layer name) for any other tile set. A paint is
// {order, fill?, stroke?, width?, dash?, radius?, label?, minzoom?}; features with the same paint
// are drawn as one path per tile, lowest `order` first.

export const BACKGROUND = '#f4f1ea';
const WATER = '#a9cbe8';
const PARK = '#cfe5c0';
const WOOD = '#bcd9ab';
const GRASS = '#ddebc9';
const SAND = '#f1e6c8';
const ICE = '#f7fbff';
const RESID = '#ebe6e0';
const INDUS = '#e6e0e8';
const BUILD = '#d8cfc6';
const BOUND = '#9b88c0';

const ROAD = {
  highway: ['#f3b862', 3.2, 60], motorway: ['#f3b862', 3.2, 60], trunk: ['#f7c97a', 2.8, 59],
  major_road: ['#fbe1a0', 2.4, 58], primary: ['#fbe1a0', 2.4, 58], secondary: ['#fff1c4', 2, 57],
  medium_road: ['#ffffff', 1.8, 56], tertiary: ['#ffffff', 1.8, 56], minor_road: ['#ffffff', 1.2, 55], minor: ['#ffffff', 1.2, 55],
  service: ['#ffffff', 0.8, 54], other: ['#ffffff', 0.8, 54], track: ['#d6c3a8', 0.8, 53], path: ['#c9b49a', 0.7, 53], footway: ['#c9b49a', 0.7, 53],
  rail: ['#9a9a9a', 1, 52], ferry: ['#6f9fd0', 0.8, 51],
};

const landCache = new Map();
const LAND = (kind) => {
  let v = landCache.get(kind);
  if (v === undefined) landCache.set(kind, (v = land(kind)));
  return v;
};
const land = (kind) =>
  /wood|forest|nature_reserve|national_park/.test(kind) ? WOOD
  : /park|garden|playground|pitch|golf|cemetery|recreation|grass|meadow|village_green|allotments|zoo|dog_park/.test(kind) ? PARK
  : /farm|orchard|vineyard|crop/.test(kind) ? '#eef0d4'
  : /sand|beach|desert|barren|bare_rock|scree/.test(kind) ? SAND
  : /glacier|ice|snow/.test(kind) ? ICE
  : /wetland|marsh|swamp|bog/.test(kind) ? '#d7e8de'
  : /industrial|railway|commercial|retail|military|construction|quarry/.test(kind) ? INDUS
  : /hospital|school|university|college|kindergarten/.test(kind) ? '#f1e3e1'
  : /water|basin|reservoir|lake/.test(kind) ? WATER
  : /residential|urban|suburb|neighbourhood|built/.test(kind) ? RESID
  : /scrub|heath|grassland/.test(kind) ? GRASS
  : null;

function hashColour(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  const hue = ((h >>> 0) % 360);
  return `hsl(${hue} 55% 45%)`;
}

const cache = new Map();
const paint = (key, p) => {
  let v = cache.get(key);
  if (!v) cache.set(key, (v = { key, ...p }));
  return v;
};

/**
 * Paint of one feature: layer name, properties, MVT type (1 point, 2 line, 3 polygon) and the
 * zoom drawn; null to skip it.
 */
export function paintFor(layer, props, type, zoom) {
  const kind = String(props.kind ?? props.class ?? props.pmap_kind ?? props.type ?? '');
  const sub = String(props.kind_detail ?? props.subclass ?? '');
  switch (layer) {
    // ---- Protomaps basemap layers ----
    case 'earth':
      return type === 3 ? paint('earth', { order: 1, fill: BACKGROUND }) : null;
    case 'water':
      if (type === 3) return paint('water', { order: 20, fill: WATER });
      if (type === 2) return paint('water-l', { order: 21, stroke: WATER, width: kind === 'river' ? 1.6 : 0.8 });
      return null;
    case 'waterway':
      return type === 2 ? paint(`ww-${kind === 'river'}`, { order: 21, stroke: WATER, width: kind === 'river' ? 1.6 : 0.7 }) : null;
    case 'landcover':
    case 'landuse':
    case 'natural':
    case 'park': {
      if (type !== 3) return null;
      const c = layer === 'park' ? PARK : LAND(`${kind} ${sub}`);
      return c ? paint(`lu-${c}`, { order: layer === 'landcover' ? 5 : 10, fill: c }) : null;
    }
    case 'physical_line':
      return type === 2 ? paint('phys-l', { order: 21, stroke: /river|stream|canal|drain|ditch/.test(kind) ? WATER : '#b8a68f', width: kind === 'river' ? 1.4 : 0.6 }) : null;
    case 'buildings':
    case 'building':
      return type === 3 && zoom >= 13 ? paint('bld', { order: 40, fill: BUILD, stroke: zoom >= 15 ? '#c4b8ad' : null, width: 0.5 }) : null;
    case 'roads':
    case 'transportation':
    case 'transit': {
      if (type !== 2) return null;
      const key = layer === 'transit' && !ROAD[kind] ? 'rail' : kind in ROAD ? kind : /rail/.test(kind) ? 'rail' : /path|foot|cycle|bridle|steps/.test(kind) ? 'path' : 'minor_road';
      const [c, w, o] = ROAD[key];
      const scale = Math.max(0.45, Math.min(1.6, (zoom - 8) / 6));
      return paint(`road-${key}-${scale.toFixed(2)}`, { order: o, stroke: c, casing: key === 'rail' || key === 'path' || key === 'ferry' ? null : '#c9b9a5', width: w * scale, // Dashes only close in: dashing thousands of footpaths costs Skia most of a tile's drawing time.
        dash: zoom >= 15 && (key === 'rail' || key === 'path' || key === 'ferry') ? [3, 2] : null });
    }
    case 'aeroway':
      return type === 3 ? paint('aero', { order: 12, fill: '#e3dfe8' }) : type === 2 ? paint('aero-l', { order: 50, stroke: '#cfc7da', width: 2 }) : null;
    case 'boundaries':
    case 'boundary': {
      if (type !== 2) return null;
      const lvl = Number(props.kind_detail ?? props.admin_level ?? (kind === 'country' ? 2 : 4));
      return paint(`bnd-${lvl <= 2}`, { order: 70, stroke: BOUND, width: lvl <= 2 ? 1.4 : 0.8, dash: lvl <= 2 ? null : [4, 3] });
    }
    case 'places':
    case 'place':
      if (type !== 1) return null;
      return paint(`place-${kind}`, { order: 90, label: true, font: /country|state|region/.test(kind) ? '600 12px sans-serif' : /city|locality/.test(kind) ? '600 11px sans-serif' : '10px sans-serif', radius: 0 });
    case 'pois':
    case 'poi':
      return type === 1 && zoom >= 15 ? paint('poi', { order: 85, fill: '#b0644f', radius: 1.8 }) : null;
    case 'physical_point':
    case 'mountain_peak':
      return type === 1 ? paint('peak', { order: 86, fill: '#7a5b3c', radius: 1.8 }) : null;
    case 'water_name':
    case 'transportation_name':
    case 'housenumber':
    case 'aerodrome_label':
      return null;
    default: {
      // Any other schema: a colour per layer.
      const c = hashColour(layer);
      if (type === 3) return paint(`gen-p-${layer}`, { order: 30, fill: c, fillAlpha: 0.3, stroke: c, width: 0.8 });
      if (type === 2) return paint(`gen-l-${layer}`, { order: 60, stroke: c, width: 1.2 });
      if (type === 1) return paint(`gen-pt-${layer}`, { order: 80, fill: c, radius: 2.5, stroke: '#ffffff', width: 0.8 });
      return null;
    }
  }
}

/**
 * Whether any feature of a layer can be drawn at this zoom: label-only and close-in layers are
 * skipped without decoding their features (most of a dense OpenMapTiles tile is house numbers,
 * POIs and road names).
 */
export function layerVisible(layer, zoom) {
  switch (layer) {
    case 'water_name':
    case 'transportation_name':
    case 'housenumber':
    case 'aerodrome_label':
      return false;
    case 'pois':
    case 'poi':
      return zoom >= 15;
    case 'buildings':
    case 'building':
      return zoom >= 13;
    default:
      return true;
  }
}

/** Is this tile set one of the known basemap schemas (so the background is land colour)? */
export function knownSchema(layerNames) {
  const s = new Set(layerNames);
  return ['earth', 'water', 'roads', 'transportation', 'landcover', 'building', 'buildings'].some((n) => s.has(n));
}
