// GIS Workbench's own monochrome icon set (REQ-SEC-09: no reference-product icons).
// Every glyph is drawn on a 16-unit grid with currentColor, so all themes work. Ribbon
// large buttons render the same glyph at 32 px. Unknown names fall back to a labelled tile.

const S = 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"';
const F = 'fill="currentColor"';

const P = {
  // files and edit
  new: `<path ${S} d="M4 1.5h5l3 3v10H4z"/><path ${S} d="M9 1.5v3h3"/>`,
  open: `<path ${S} d="M1.5 4.5h4l1 1h6v7.5h-11z"/><path ${S} d="M1.5 7h13l-2 6"/>`,
  save: `<path ${S} d="M2.5 2.5h9l2 2v9h-11z"/><path ${S} d="M5 2.5v3.5h5V2.5M5 13.5v-4h6v4"/>`,
  saveas: `<path ${S} d="M2.5 2.5h7l2 2v4M2.5 2.5v11h5"/><path ${S} d="M10 14l4-4-1.5-1.5-4 4V14z"/>`,
  undo: `<path ${S} d="M5 3L2 6l3 3"/><path ${S} d="M2 6h7a4 4 0 010 8H6"/>`,
  redo: `<path ${S} d="M11 3l3 3-3 3"/><path ${S} d="M14 6H7a4 4 0 000 8h3"/>`,
  copy: `<rect ${S} x="5" y="5" width="9" height="9" rx="1"/><path ${S} d="M3 11V3h8"/>`,
  paste: `<rect ${S} x="3" y="3" width="10" height="11.5" rx="1"/><path ${S} d="M6 2h4v2.5H6z"/>`,
  cut: `<circle ${S} cx="4.5" cy="12" r="2"/><circle ${S} cx="11.5" cy="12" r="2"/><path ${S} d="M5.8 10.5L11 2M10.2 10.5L5 2"/>`,
  delete: `<path ${S} d="M3 4.5h10M6 4.5V2.5h4v2M4.5 4.5l.8 9.5h5.4l.8-9.5"/>`,
  help: `<circle ${S} cx="8" cy="8" r="6.5"/><path ${S} d="M6.2 6.2a1.9 1.9 0 113 1.6c-.8.5-1.2.9-1.2 1.8"/><circle ${F} cx="8" cy="11.8" r=".8"/>`,
  info: `<circle ${S} cx="8" cy="8" r="6.5"/><path ${S} d="M8 7v4.5"/><circle ${F} cx="8" cy="4.8" r=".8"/>`,
  gear: `<circle ${S} cx="8" cy="8" r="2.2"/><path ${S} d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>`,
  close: `<path ${S} d="M4 4l8 8M12 4l-8 8"/>`,
  check: `<path ${S} d="M3 8.5l3 3 7-7"/>`,
  search: `<circle ${S} cx="7" cy="7" r="4.5"/><path ${S} d="M10.3 10.3L14 14"/>`,
  list: `<path ${S} d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle ${F} cx="2.7" cy="4" r=".9"/><circle ${F} cx="2.7" cy="8" r=".9"/><circle ${F} cx="2.7" cy="12" r=".9"/>`,
  table: `<rect ${S} x="1.5" y="2.5" width="13" height="11"/><path ${S} d="M1.5 6h13M1.5 9.5h13M6 2.5v11"/>`,
  // navigation
  glove: `<path ${S} d="M5 9V4.2a1 1 0 012 0V8M7 7.5V3a1 1 0 012 0v4.5M9 7.5V3.8a1 1 0 012 0V9M11 8.5V6a1 1 0 012 0v3.5c0 3-2 5-4.5 5S5 13 3.8 11.2L2.5 9.3a1 1 0 011.6-1.1L5 9"/>`,
  recenter: `<circle ${S} cx="8" cy="8" r="5.5"/><path ${S} d="M8 1v3M8 12v3M1 8h3M12 8h3"/><circle ${F} cx="8" cy="8" r="1.2"/>`,
  roam: `<path ${S} d="M8 1.5v13M1.5 8h13"/><path ${S} d="M6 3.5L8 1.5l2 2M6 12.5l2 2 2-2M3.5 6L1.5 8l2 2M12.5 6l2 2-2 2"/>`,
  jump: `<path ${S} d="M8 14.5s-4.5-4.6-4.5-8a4.5 4.5 0 019 0c0 3.4-4.5 8-4.5 8z"/><circle ${S} cx="8" cy="6.5" r="1.6"/>`,
  zoombox: `<rect ${S} x="1.5" y="1.5" width="9" height="9" stroke-dasharray="2 1.5"/><path ${S} d="M9.5 9.5l5 5"/>`,
  zoomin: `<circle ${S} cx="7" cy="7" r="5"/><path ${S} d="M4.8 7h4.4M7 4.8v4.4M10.6 10.6L14.5 14.5"/>`,
  zoomout: `<circle ${S} cx="7" cy="7" r="5"/><path ${S} d="M4.8 7h4.4M10.6 10.6L14.5 14.5"/>`,
  whole: `<rect ${S} x="2" y="2" width="12" height="12"/><path ${S} d="M5 5h6v6H5z"/><path ${S} d="M2 2l3 3M14 2l-3 3M2 14l3-3M14 14l-3-3"/>`,
  onetoone: `<path ${S} d="M3.5 4.5l1.5-1v9M10.5 4.5l1.5-1v9"/><circle ${F} cx="8" cy="6.5" r=".8"/><circle ${F} cx="8" cy="10" r=".8"/>`,
  magnifier: `<circle ${S} cx="6.5" cy="6.5" r="4.5"/><path ${S} d="M10 10l4.5 4.5"/><path ${S} d="M4.5 6.5h4"/>`,
  rotate: `<path ${S} d="M13 8a5 5 0 11-1.5-3.6"/><path ${S} d="M12 1.5v3h-3"/>`,
  north: `<path ${S} d="M8 1.5l3.5 11L8 10.5l-3.5 2z"/><path ${S} d="M6.5 15V13l3 2v-2"/>`,
  sun: `<circle ${S} cx="8" cy="8" r="3"/><path ${S} d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3"/>`,
  link: `<path ${S} d="M6.5 9.5l3-3"/><path ${S} d="M7 4.5l1-1a2.8 2.8 0 014 4l-1 1M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1"/>`,
  unlink: `<path ${S} d="M7 4.5l1-1a2.8 2.8 0 014 4l-1 1M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1M2 2l2 2M14 14l-2-2"/>`,
  overview: `<rect ${S} x="1.5" y="2.5" width="13" height="11"/><rect ${S} x="8.5" y="8" width="4.5" height="3.5"/>`,
  bookmark: `<path ${S} d="M4 1.5h8v13l-4-3-4 3z"/>`,
  // panes and windows
  layout: `<rect ${S} x="1.5" y="1.5" width="13" height="13"/><path ${S} d="M8 1.5v13M1.5 8h13"/>`,
  window: `<rect ${S} x="1.5" y="2" width="13" height="12" rx="1"/><path ${S} d="M1.5 5h13"/>`,
  tabs: `<path ${S} d="M1.5 14V5h4V3h4v2h5v9z"/>`,
  layers: `<path ${S} d="M8 1.5l6.5 3.5L8 8.5 1.5 5z"/><path ${S} d="M1.5 8L8 11.5 14.5 8M1.5 11L8 14.5 14.5 11"/>`,
  toolbox: `<rect ${S} x="1.5" y="5" width="13" height="8.5" rx="1"/><path ${S} d="M5.5 5V3h5v2M1.5 8.5h13"/>`,
  dock: `<rect ${S} x="1.5" y="1.5" width="13" height="13"/><path ${S} d="M5.5 1.5v13"/>`,
  fullscreen: `<path ${S} d="M1.5 5.5v-4h4M10.5 1.5h4v4M14.5 10.5v4h-4M5.5 14.5h-4v-4"/>`,
  theme: `<circle ${S} cx="8" cy="8" r="6.5"/><path ${F} d="M8 1.5a6.5 6.5 0 010 13z"/>`,
  // drawing and graphics
  point: `<circle ${S} cx="8" cy="8" r="3"/><path ${S} d="M8 2v2.5M8 11.5V14M2 8h2.5M11.5 8H14"/>`,
  line: `<path ${S} d="M2.5 13.5l11-11"/><circle ${F} cx="2.5" cy="13.5" r="1.2"/><circle ${F} cx="13.5" cy="2.5" r="1.2"/>`,
  polyline: `<path ${S} d="M1.5 12l4-6 4 4 5-7.5"/>`,
  polygon: `<path ${S} d="M3 3.5l8-1.5 3.5 6-4 6H4L1.5 9z"/>`,
  rect: `<rect ${S} x="2" y="3.5" width="12" height="9"/>`,
  ellipse: `<ellipse ${S} cx="8" cy="8" rx="6.5" ry="4.5"/>`,
  circle: `<circle ${S} cx="8" cy="8" r="6"/>`,
  arrow: `<path ${S} d="M2.5 13.5l10-10M7 3.5h5.5V9"/>`,
  text: `<path ${S} d="M3 3.5h10M8 3.5v10M6 13.5h4"/>`,
  callout: `<path ${S} d="M2 2.5h12v7H8l-3 4v-4H2z"/>`,
  marker: `<circle ${S} cx="8" cy="8" r="4.5"/><path ${S} d="M8 1v4M8 11v4M1 8h4M11 8h4"/>`,
  pen: `<path ${S} d="M2.5 13.5l1-3.5 8-8 2.5 2.5-8 8z"/><path ${S} d="M10 3.5L12.5 6"/>`,
  highlight: `<path ${S} d="M3 13.5h10"/><path ${S} d="M5 11l1-3 5-5 2 2-5 5z"/>`,
  eraser: `<path ${S} d="M6 13.5h8M2.5 10l6-6.5 5 5-4.5 5H6z"/>`,
  pin: `<path ${S} d="M8 14.5v-5"/><circle ${S} cx="8" cy="5.5" r="3.5"/>`,
  label: `<path ${S} d="M1.5 4.5h8l5 3.5-5 3.5h-8z"/><circle ${F} cx="4.5" cy="8" r="1"/>`,
  symbol: `<path ${S} d="M8 1.5l6.5 6.5L8 14.5 1.5 8z"/><path ${S} d="M5.5 8h5"/>`,
  // mensuration
  ruler: `<path ${S} d="M1.5 11l9.5-9.5 3.5 3.5L5 14.5z"/><path ${S} d="M4.5 8l1.5 1.5M6.5 6l1 1M8.5 4l1.5 1.5"/>`,
  bearing: `<circle ${S} cx="4" cy="12" r="1.5"/><path ${S} d="M4 12l9-9M4 12V3"/><path ${S} d="M4 7a5 5 0 013.5 1.5"/>`,
  area: `<path ${S} d="M2.5 4l9-2 3 8-6 4.5-6.5-3z"/><path ${S} d="M5 6l6 6M8 4l4 6" stroke-width=".7"/>`,
  height: `<path ${S} d="M8 1.5v13M5 4l3-2.5L11 4M5 12l3 2.5 3-2.5M2 14.5h12"/>`,
  shadow: `<path ${S} d="M4 2v10"/><path ${F} d="M4 12l9 2.5V12z" opacity=".6"/><path ${S} d="M2 14.5h12"/>`,
  target: `<circle ${S} cx="8" cy="8" r="6.5"/><circle ${S} cx="8" cy="8" r="3.5"/><circle ${F} cx="8" cy="8" r="1"/>`,
  los: `<path ${S} d="M1.5 12l3-4 3 2 3-5 4 3"/><path ${S} d="M2 6l12 2" stroke-dasharray="1.5 1.2"/>`,
  log: `<rect ${S} x="2" y="1.5" width="12" height="13" rx="1"/><path ${S} d="M4.5 5h7M4.5 8h7M4.5 11h4"/>`,
  sigma: `<path ${S} d="M12 3H4l4.5 5L4 13h8"/>`,
  // geospatial
  globe: `<circle ${S} cx="8" cy="8" r="6.5"/><path ${S} d="M1.5 8h13M8 1.5c-3 3.5-3 9.5 0 13M8 1.5c3 3.5 3 9.5 0 13"/>`,
  grid: `<path ${S} d="M1.5 5.5h13M1.5 10.5h13M5.5 1.5v13M10.5 1.5v13"/>`,
  model: `<path ${S} d="M8 1.5l6 3.5v6L8 14.5 2 11V5z"/><path ${S} d="M2 5l6 3.5L14 5M8 8.5v6"/>`,
  align: `<rect ${S} x="1.5" y="1.5" width="8" height="8"/><rect ${S} x="6.5" y="6.5" width="8" height="8" stroke-dasharray="2 1.5"/>`,
  terrain: `<path ${S} d="M1 13.5l4.5-7 3 4 2-2.5 4.5 5.5z"/>`,
  ortho: `<path ${S} d="M3 13.5L5.5 4h7.5L10.5 13.5z"/><path ${S} d="M8 1v3"/>`,
  // products
  chip: `<rect ${S} x="1.5" y="2.5" width="13" height="11"/><path ${S} d="M1.5 5h13M1.5 11h13"/><circle ${F} cx="11.5" cy="8" r="1"/>`,
  template: `<rect ${S} x="2" y="1.5" width="12" height="13"/><path ${S} d="M4 4h8v4H4zM4 10.5h8M4 12.5h5"/>`,
  pdf: `<path ${S} d="M3.5 1.5h6l3 3v10h-9z"/><path ${S} d="M5.5 8h1.2a1 1 0 010 2H5.5V7M9 7v3M9 7h1.5M9 8.5h1"/>`,
  kmz: `<path ${S} d="M8 14.5s-4.5-4.6-4.5-8a4.5 4.5 0 019 0c0 3.4-4.5 8-4.5 8z"/><path ${S} d="M6 5l1.3 3L8.5 5.5 9.8 8 11 5" stroke-width="1"/>`,
  report: `<path ${S} d="M3.5 1.5h6l3 3v10h-9z"/><path ${S} d="M5.5 7.5h5M5.5 10h5M5.5 12.5h3"/>`,
  marking: `<rect ${S} x="1.5" y="3" width="13" height="10"/><path ${S} d="M1.5 5.5h13M1.5 10.5h13"/>`,
  print: `<path ${S} d="M4 6V1.5h8V6M4 12H2V6h12v6h-2"/><rect ${S} x="4" y="9.5" width="8" height="5"/>`,
  image: `<rect ${S} x="1.5" y="2.5" width="13" height="11"/><path ${S} d="M1.5 11l4-4 3 3 2-2 4 4"/><circle ${S} cx="11" cy="5.5" r="1.2"/>`,
  // enhance
  contrast: `<circle ${S} cx="8" cy="8" r="6.5"/><path ${F} d="M8 1.5v13a6.5 6.5 0 010-13z"/>`,
  brightness: `<circle ${S} cx="8" cy="8" r="2.5"/><path ${S} d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>`,
  histogram: `<path ${S} d="M1.5 14.5h13"/><path ${F} d="M2.5 14V11h1.6v3zM4.8 14V6h1.6v8zM7.1 14V3h1.6v11zM9.4 14V7h1.6v7zM11.7 14v-2.5h1.6V14z"/>`,
  curve: `<path ${S} d="M1.5 14.5h13M1.5 14.5V1.5"/><path ${S} d="M2.5 13.5C7 13 9 3 13.5 2.5"/>`,
  lut: `<rect ${S} x="1.5" y="5" width="13" height="6"/><path ${F} d="M1.5 5h3.2v6H1.5z" opacity=".25"/><path ${F} d="M4.7 5h3.2v6H4.7z" opacity=".5"/><path ${F} d="M7.9 5h3.2v6H7.9z" opacity=".75"/>`,
  sharpen: `<path ${S} d="M8 1.5L14.5 14.5h-13z"/>`,
  smooth: `<path ${S} d="M1.5 10c2-4 4-4 6.5 0s4.5 4 6.5 0"/>`,
  filter: `<path ${S} d="M1.5 2.5h13L9.5 8.5v5l-3 1.5v-6.5z"/>`,
  invert: `<rect ${S} x="1.5" y="1.5" width="13" height="13"/><path ${F} d="M1.5 14.5l13-13v13z"/>`,
  bands: `<rect ${S} x="1.5" y="1.5" width="4" height="13"/><rect ${S} x="6" y="1.5" width="4" height="13"/><rect ${S} x="10.5" y="1.5" width="4" height="13"/>`,
  pixels: `<path ${S} d="M1.5 1.5h13v13h-13zM1.5 6h13M1.5 10.5h13M6 1.5v13M10.5 1.5v13"/>`,
  reset: `<path ${S} d="M3 8a5 5 0 105-5H5"/><path ${S} d="M6 1L3.5 3 6 5.5"/>`,
  wand: `<path ${S} d="M2 14L10 6"/><path ${S} d="M11 1.5v2M11 7.5v2M7 5.5h2M13 5.5h2M8.5 3l1 1M12.5 7l1 1M13.5 3l-1 1"/>`,
  // compare
  swipe: `<rect ${S} x="1.5" y="2.5" width="13" height="11"/><path ${S} d="M8 1v14"/><path ${F} d="M1.5 2.5H8v11H1.5z" opacity=".3"/>`,
  porthole: `<rect ${S} x="1.5" y="2.5" width="13" height="11"/><circle ${S} cx="8" cy="8" r="3.5"/>`,
  flicker: `<rect ${S} x="1.5" y="2.5" width="9" height="8"/><rect ${S} x="5.5" y="5.5" width="9" height="8" stroke-dasharray="2 1.5"/>`,
  blend: `<circle ${S} cx="6" cy="8" r="4.5"/><circle ${S} cx="10" cy="8" r="4.5"/>`,
  record: `<circle ${S} cx="8" cy="8" r="6.5"/><circle ${F} cx="8" cy="8" r="3.5"/>`,
  play: `<path ${S} d="M4.5 2.5v11l9-5.5z"/>`,
  // add-ins
  ai: `<path ${S} d="M8 1.5l1.6 4.4L14 7.5l-4.4 1.6L8 13.5l-1.6-4.4L2 7.5l4.4-1.6z"/><path ${S} d="M13 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" stroke-width="1"/>`,
  whiteboard: `<rect ${S} x="1.5" y="2" width="13" height="9.5" rx="1"/><path ${S} d="M5 14.5l3-3 3 3"/><path ${S} d="M4 8.5l2-3 2 2 3-3.5"/>`,
  send: `<path ${S} d="M1.5 7.5l13-6-4.5 13-2.5-5z"/><path ${S} d="M8 9l6.5-7.5"/>`,
  plug: `<path ${S} d="M5.5 1.5v3.5M10.5 1.5v3.5M3.5 5h9v3a4.5 4.5 0 01-9 0zM8 12.5v2"/>`,
  network: `<circle ${S} cx="8" cy="3" r="1.6"/><circle ${S} cx="3" cy="13" r="1.6"/><circle ${S} cx="13" cy="13" r="1.6"/><path ${S} d="M7.2 4.4L3.8 11.6M8.8 4.4l3.4 7.2M4.6 13h6.8"/>`,
  console: `<rect ${S} x="1.5" y="2.5" width="13" height="11" rx="1"/><path ${S} d="M4 6l2.5 2L4 10M8 10.5h4"/>`,
  pack: `<path ${S} d="M8 1.5l6.5 3v7L8 14.5l-6.5-3v-7z"/><path ${S} d="M1.5 4.5L8 8l6.5-3.5M8 8v6.5"/>`,
  job: `<circle ${S} cx="8" cy="8" r="6.5"/><path ${S} d="M8 4v4l3 2"/>`,
  feature: `<path ${S} d="M2 12l4-8 4 5 4-3"/><rect ${F} x="1" y="11" width="2.2" height="2.2"/><rect ${F} x="5" y="3" width="2.2" height="2.2"/><rect ${F} x="9" y="8" width="2.2" height="2.2"/><rect ${F} x="13" y="5" width="2.2" height="2.2"/>`,
  observation: `<path ${S} d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle ${S} cx="8" cy="8" r="2.2"/>`,
  select: `<path ${S} d="M3 2l9.5 5.5-4 1.2-1.7 4z"/>`,
  aoi: `<rect ${S} x="2" y="2" width="12" height="12" stroke-dasharray="2.2 1.6"/>`,
  stereo: `<circle ${S} cx="4.5" cy="9" r="3"/><circle ${S} cx="11.5" cy="9" r="3"/><path ${S} d="M7.5 9h1"/>`,
  cloud: `<circle ${F} cx="3" cy="11" r=".9"/><circle ${F} cx="6" cy="8" r=".9"/><circle ${F} cx="9" cy="10" r=".9"/><circle ${F} cx="12" cy="6" r=".9"/><circle ${F} cx="5" cy="4" r=".9"/><circle ${F} cx="10" cy="13" r=".9"/><circle ${F} cx="13" cy="10.5" r=".9"/>`,
  radar: `<path ${S} d="M8 8L13 3"/><circle ${S} cx="8" cy="8" r="6.5"/><circle ${S} cx="8" cy="8" r="3.5"/>`,
  video: `<rect ${S} x="1.5" y="3.5" width="9" height="9" rx="1"/><path ${S} d="M10.5 7l4-2.5v7l-4-2.5"/>`,
  caret: `<path ${S} d="M4.5 6.5L8 10l3.5-3.5"/>`,
  more: `<circle ${F} cx="3.5" cy="8" r="1.1"/><circle ${F} cx="8" cy="8" r="1.1"/><circle ${F} cx="12.5" cy="8" r="1.1"/>`,
  app: `<rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" opacity=".18"/><path ${S} d="M3 11.5l3-4 2.5 2.5L13 4.5"/><circle ${S} cx="12" cy="11.5" r="1.6"/>`,
};

export const ICON_NAMES = Object.keys(P);

/** Icon markup at a given pixel size. */
export function iconSvg(name, size = 16, title = '') {
  const body = P[name];
  const t = title ? `<title>${title.replace(/[<&]/g, '')}</title>` : '';
  if (!body) {
    const ch = (name || '?').charAt(0).toUpperCase().replace(/[<&]/g, '');
    return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">${t}<rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor"/><text x="8" y="11.5" font-size="9" text-anchor="middle" fill="currentColor" font-family="Segoe UI,Arial">${ch}</text></svg>`;
  }
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">${t}${body}</svg>`;
}

export function icon(name, size = 16) {
  const span = document.createElement('span');
  span.className = 'ico-wrap';
  span.innerHTML = iconSvg(name, size); // generated by us, not from user data
  return span;
}
