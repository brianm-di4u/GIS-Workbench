// Ribbon, QAT and Workspace menu structure as data (Appendix C §2–§7). Commands keep fixed
// positions at every width (REQ-UI-03). A command id resolves through the command registry;
// commands not built yet show their requirement and release (honest stubs, SDP R0.2).
//
// Item forms: 'cmd.id' | {cmd, size:'L'|'S', kind:'split'|'combo'|'toggle'|'gallery'|'input', label?}
//
// Labels are English sources marked with N_() and shown through tr() (the Ribbon) or localMenu()
// (the File and Workspace menus). Code that finds an entry by its label (m.label === 'Help')
// compares the English source, which never changes with the locale.

import { N_, tr } from '../i18n/index.js';

/** A copy of a menu from this file with its own labels in the UI language (command items keep theirs: menu.js shows the command's). */
export function localMenu(items) {
  if (!Array.isArray(items)) return items;
  return items.map((it) => {
    if (!it || typeof it !== 'object') return it;
    const out = { ...it };
    if (typeof it.label === 'string') out.label = tr(it.label);
    if (Array.isArray(it.items)) out.items = localMenu(it.items);
    return out;
  });
}

const L =(cmd, extra = {}) => ({ cmd, size: 'L', ...extra });
const S = (cmd, extra = {}) => ({ cmd, size: 'S', ...extra });

export const MAIN_TABS = [
  {
    id: 'home',
    label: N_('Home'),
    key: 'H',
    groups: [
      { label: N_('Pan'), items: [L('nav.glove'), S('nav.recenter'), S('nav.roam'), S('nav.jump'), { cmd: 'nav.jumpbox', kind: 'input', label: N_('Jump to Coordinate:') }] },
      { label: N_('Zoom'), items: [L('nav.zoombox'), S('nav.zoomin'), S('nav.zoomout'), S('nav.whole'), S('nav.onetoone'), S('nav.magnifier'), { cmd: 'view.interpolation', kind: 'combo', size: 'S' }] },
      { label: N_('Rotate'), items: [S('rot.zero'), S('rot.upisup'), S('rot.north'), S('rot.shadows'), S('rot.mouse'), { cmd: 'rot.angle', kind: 'input', label: N_('Angle') }] },
      { label: N_('Linked Panels'), launcher: 'link.manager', items: [L('link.all'), S('link.unlink'), S('link.cursors')] },
      { label: N_('Overviews'), items: [S('ov.open'), S('ov.pip')] },
      { label: N_('Bookmarks'), items: [S('bm.add'), S('bm.list')] },
    ],
  },
  {
    id: 'select',
    label: N_('Select'),
    key: 'S',
    groups: [
      { label: N_('Area of Interest'), items: [L('aoi.box'), S('aoi.polygon'), S('aoi.fromgraphic'), S('aoi.clear')] },
      { label: N_('Selection'), items: [L('sel.graphics'), S('sel.features'), S('sel.byattr'), S('sel.byloc'), S('sel.all')] },
    ],
  },
  {
    id: 'draw',
    label: N_('Draw'),
    key: 'D',
    groups: [
      { label: N_('Shapes'), kind: 'gallery', items: ['draw.point', 'draw.line', 'draw.polyline', 'draw.polygon', 'draw.rect', 'draw.ellipse', 'draw.circle', 'draw.arrow', 'draw.text', 'draw.callout', 'draw.marker'] },
      { label: N_('Labels'), items: [S('draw.autolabels'), S('draw.automap')] },
      { label: N_('Mensuration'), launcher: 'men.log', items: [L('men.point'), S('men.bracket'), S('men.rangebearing'), S('men.length'), S('men.area'), S('men.height', { kind: 'split' }), S('men.depth'), S('men.target'), S('men.medial'), S('men.centre'), S('men.log'), S('men.tracking', { kind: 'toggle' })] },
      { label: N_('Sequence'), items: [S('draw.sequence'), S('draw.count')] },
      { label: N_('Manage'), items: [S('gfx.props'), S('men.targettable'), S('gfx.legend'), S('gfx.save'), S('gfx.load')] },
      { label: N_('GPS'), items: [S('gps.route'), S('gps.waypoint'), S('gps.load'), S('gps.flightplan')] },
    ],
  },
  {
    id: 'geospatial',
    label: N_('Geospatial'),
    key: 'G',
    groups: [
      { label: N_('Align'), items: [L('align.glove'), S('align.auto'), S('align.ai'), S('align.quick'), S('align.poly')] },
      { label: N_('Sensor Model'), items: [L('model.active', { kind: 'split' }), S('model.info'), S('model.error'), S('model.gcp'), S('model.vendor'), S('model.csm'), S('model.ossim')] },
      { label: N_('Triangulation'), items: [S('tri.mip'), S('tri.tiepoints'), S('tri.adjust'), S('tri.frame'), S('tri.solutions'), S('tri.aero'), S('tri.resect'), S('tri.fiducials')] },
      { label: N_('Ortho'), items: [S('ortho.rectify'), S('ortho.true'), S('ortho.mosaic'), S('ortho.seam'), S('ortho.balance')] },
      { label: N_('Coordinates'), items: [L('geo.convert'), S('geo.grid', { kind: 'split' }), S('geo.datum'), S('geo.transform'), S('geo.locate')] },
      { label: N_('Online'), items: [S('online.add'), S('online.backgrounds'), S('svc.connect'), S('online.identify'), S('net.signin'), S('net.portal')] },
      { label: N_('Aviation'), items: [S('los.airports'), S('los.obstruction')] },
    ],
  },
  {
    id: 'products',
    label: N_('Products'),
    key: 'P',
    groups: [
      { label: N_('Chip'), items: [L('chip.view'), S('chip.preset'), S('chip.markers'), S('hud.quickchip'), S('deck.export'), S('deck.clear')] },
      { label: N_('Templates'), items: [L('tpl.apply', { kind: 'gallery' }), S('tpl.edit'), S('tpl.props')] },
      { label: N_('Snapshot'), items: [S('snap.pptx'), S('snap.pdf'), S('snap.geopdf'), S('file.geopdf'), S('snap.kmz')] },
      { label: N_('Send to'), items: [S('hub.psd'), S('hub.tiff16'), S('hub.pdf'), S('hub.svg'), S('hub.glb'), S('hub.usdz'), S('hub.dae'), S('hub.kmz3d'), S('hub.stl'), S('hub.ply'), S('hub.slpk'), S('hub.flt'), S('hub.relay')] },
      { label: N_('Reports'), items: [L('report.template', { kind: 'split' }), S('report.ai'), S('obs.toolbox'), S('obs.table'), S('obs.field'), S('obs.export'), S('prod.gif'), S('prod.mediapptx'), S('prod.pptxtemplate')] },
      { label: N_('Metadata'), items: [S('meta.edit'), S('meta.redact')] },
      { label: N_('Advanced'), items: [L('prod.finishing')] },
    ],
  },
  {
    id: 'view',
    label: N_('View'),
    key: 'V',
    groups: [
      { label: N_('Windows'), items: [L('win.new'), S('win.clone'), S('win.separate'), S('win.split', { kind: 'split' }), S('win.tabbed'), S('win.workspace', { kind: 'toggle' })] },
      { label: N_('Active Panel'), items: [S('panel.props'), S('panel.visibility'), S('panel.legend')] },
      { label: N_('Grids'), items: [S('grid.map', { kind: 'toggle' }), S('grid.grg'), S('grid.micro'), S('grid.props')] },
      { label: N_('Background'), items: [S('bg.map'), S('bg.online')] },
      { label: N_('Decorations'), items: [S('deco.north', { kind: 'toggle' }), S('deco.sun', { kind: 'toggle' }), S('deco.sensor', { kind: 'toggle' }), S('deco.scalebar', { kind: 'toggle' })] },
      { label: N_('3D'), items: [S('3d.open'), S('3d.sync'), S('3d.syncalways')] },
      { label: N_('Display'), items: [L('display.fullscreen'), S('display.theme', { kind: 'split' }), S('display.pixels'), S('input.devices'), S('ribbon.customize'), S('ui.palette'), S('ui.layout'), S('hud.pill', { kind: 'toggle' }), S('hud.radial')] },
    ],
  },
  {
    id: 'addins',
    label: N_('Add-Ins'),
    key: 'A',
    groups: [
      { label: N_('AI Assistant'), items: [L('ai.assistant'), S('ai.askselection'), S('ai.describe'), S('ai.proposals'), S('ai.smartselect', { kind: 'toggle' }), S('lai.square', { kind: 'toggle' })] },
      { label: N_('Local AI'), items: [L('lai.find'), S('lai.search'), S('lai.contrast'), S('lai.device'), S('lai.findscene'), S('lai.describe'), S('lai.changemask'), S('lai.landcover'), S('lai.models')] },
      { label: N_('Recipes'), items: [L('rcp.open'), S('rcp.airfield-triage'), S('rcp.building-extraction'), S('rcp.import')] },
      { label: N_('AI Setup'), items: [S('ai.connections'), S('ai.allowlist'), S('ai.prompthelper'), S('ai.mcp')] },
      { label: N_('Feedback'), items: [L('wb.toggle'), S('wb.review'), S('wb.import')] },
      { label: N_('Automation'), items: [S('auto.console'), S('auto.mcpserver')] },
      { label: N_('Packs'), items: [S('pack.load'), S('pack.list')] },
      { label: N_('Sidecar'), items: [L('sidecar.convertdialog'), S('sidecar.jobs'), S('sidecar.pick'), S('sidecar.view'), S('sidecar.batch'), S('sidecar.saveas'), S('sidecar.pansharpen'), S('sidecar.reproject'), S('sidecar.gdbcatalog'), S('sidecar.modelexport'), S('sidecar.sfm'), S('sidecar.relay'), S('sidecar.stereoviewer'), S('sidecar.prosync'), S('sidecar.status')] },
    ],
  },
];

/** Contextual sets (REQ-UI-03): shown only when the active layer needs them. */
export const CONTEXT_SETS = [
  {
    id: 'image',
    label: N_('Image Tools'),
    color: '--c-ctx-imageTools',
    when: (ctx) => ctx.activeLayer?.kind === 'image',
    tabs: [
      {
        id: 'visualize',
        label: N_('Visualize'),
        groups: [
          { label: N_('Orthorectify'), items: [L('img.orthofly')] },
          { label: N_('Terrain'), items: [L('dem.useterrain')] },
          { label: N_('Mosaic'), items: [S('img.vmosaic'), S('img.projection')] },
          { label: N_('Display'), items: [S('img.voids', { kind: 'toggle' }), S('img.footprint', { kind: 'toggle' }), S('img.segments')] },
          { label: N_('Motion Imagery'), items: [S('mie.play', { kind: 'toggle' }), S('mie.prev'), S('mie.next'), S('mie.chip')] },
        ],
      },
      {
        id: 'enhance',
        label: N_('Enhance'),
        groups: [
          { label: N_('Basic'), items: [{ cmd: 'enh.brightness', kind: 'slider' }, { cmd: 'enh.contrast', kind: 'slider' }, { cmd: 'enh.gamma', kind: 'slider' }, { cmd: 'enh.saturation', kind: 'slider' }, { cmd: 'enh.sharpness', kind: 'slider' }, S('enh.invert', { kind: 'toggle' })] },
          { label: N_('DRA'), launcher: 'enh.drasettings', items: [S('enh.drascope', { kind: 'combo' }), S('enh.dralock', { kind: 'toggle' })] },
          { label: N_('Stretch'), items: [S('enh.stretch', { kind: 'combo' }), S('enh.curve'), S('enh.lut', { kind: 'combo' }), S('enh.histogram')] },
          { label: N_('Filters'), items: [S('enh.sharpen'), S('enh.edge'), S('enh.smooth'), S('enh.median'), S('enh.morph'), S('enh.clahe')] },
          { label: N_('Processing Chain'), items: [L('enh.auto'), S('enh.reset'), S('enh.remove'), S('enh.chain')] },
          { label: N_('Pan Sharpen'), items: [S('enh.pansharpen', { kind: 'split' }), S('enh.pansharpenproduct')] },
        ],
      },
      { id: 'search', label: N_('Search'), groups: [{ label: N_('Find in Scene'), items: [L('search.find'), S('search.template')] }] },
      {
        id: 'analyze',
        label: N_('Analyze'),
        groups: [
          { label: N_('Bands'), items: [L('bands.select'), S('bands.preview'), S('bands.stats'), S('bands.snr')] },
          { label: N_('Clip Pixels'), items: [S('clip.threshold'), S('clip.void')] },
          { label: N_('Profile'), items: [S('profile.spectral'), S('profile.elevation')] },
          { label: N_('Pixel Values'), items: [L('display.pixels')] },
          { label: N_('Spectral'), items: [L('search.find'), S('msi.bandmath'), S('msi.index.ndvi'), S('msi.radiometric'), S('msi.stack'), S('msi.thermal'), S('msi.cluster'), S('msi.detect'), S('msi.pca'), S('msi.xport')] },
          { label: N_('SAR'), items: [S('sar.view', { kind: 'combo' }), S('sar.anamorphic', { kind: 'toggle' }), S('sar.ccd', { kind: 'split' })] },
        ],
      },
    ],
  },
  { id: 'spectral', label: N_('Spectral Tools'), color: '--c-ctx-featureTools', when: (ctx) => ctx.multiband, tabs: [{ id: 'spectral', label: N_('Spectral'), groups: [{ label: N_('Bands'), items: [L('bands.select'), S('bands.preview'), S('bands.snr'), S('profile.spectral')] }, { label: N_('Composites'), items: [S('msi.preset.natural'), S('msi.preset.cir'), S('msi.preset.swir'), S('msi.preset.agriculture'), S('msi.preset.rededge'), S('msi.preset.bathymetric')] }, { label: N_('Band Math'), items: [L('msi.bandmath'), S('msi.index.ndvi'), S('msi.index.ndwi'), S('msi.index.ndwi_gao'), S('msi.index.mndwi'), S('msi.index.ndbi'), S('msi.index.savi'), S('msi.index.nbr')] }, { label: N_('Radiometry'), items: [S('msi.radiometric'), S('msi.thermal'), S('msi.destripe')] }, { label: N_('Classify'), items: [L('search.find'), S('msi.threshold'), S('msi.cluster'), S('msi.majority'), S('msi.sieve'), S('msi.fill'), S('msi.vectors'), S('msi.accuracy')] }, { label: N_('Detect'), items: [S('msi.detect'), S('msi.pca'), S('msi.library'), S('msi.library.browse'), S('msi.change'), S('search.template')] }, { label: N_('Views'), items: [S('msi.xport')] }] }] },
  { id: 'video', label: N_('Video Tools'), color: '--c-ctx-imageTools', when: (ctx) => ctx.video, tabs: [{ id: 'video', label: N_('Video'), groups: [{ label: N_('Player'), items: [L('fmv.play', { kind: 'toggle' }), S('fmv.stepback'), S('fmv.stepfwd'), S('fmv.loop', { kind: 'toggle' }), S('fmv.close')] }, { label: N_('Metadata'), items: [L('fmv.klv'), S('fmv.basis'), S('fmv.hud', { kind: 'toggle' }), S('fmv.csv')] }, { label: N_('Analyze'), items: [L('fmv.capture'), S('fmv.event'), S('fmv.measure', { kind: 'toggle' }), S('fmv.export')] }, { label: N_('Panes'), items: [S('fmv.link', { kind: 'toggle' })] }] }] },
  { id: 'sar', label: N_('SAR Tools'), color: '--c-ctx-imageTools', when: (ctx) => ctx.sar, tabs: [{ id: 'sar', label: N_('SAR'), groups: [{ label: N_('View'), items: [L('sar.metadata'), S('sar.view', { kind: 'combo' }), S('sar.remap', { kind: 'combo' }), S('sar.speckle')] }, { label: N_('Phase History'), items: [S('sar.cphd'), S('sar.cphdsubset')] }, { label: N_('Geometry'), items: [S('sar.anamorphic', { kind: 'toggle' }), S('sar.ground', { kind: 'toggle' }), S('sar.shadows'), S('sar.northup'), S('sar.overlay', { kind: 'toggle' })] }, { label: N_('Change'), items: [S('sar.acd'), S('sar.ccd'), S('sar.pairs')] }, { label: N_('Advanced'), items: [S('sar.subap'), S('sar.csi'), S('sar.pauli'), S('sar.polsar')] }, { label: N_('Stereo'), items: [S('sar.stereopairs'), S('sar.stereodsm'), S('sar.stereoreport')] }] }] },
  { id: 'layer', label: N_('Layer Tools'), color: '--c-ctx-layerTools', when: (ctx) => ctx.imageLayerCount >= 2, tabs: [{ id: 'layers', label: N_('Layers'), groups: [{ label: N_('Ordering'), items: [S('lay.prev'), S('lay.next'), S('lay.order')] }, { label: N_('Compare'), items: [L('cmp.porthole'), S('cmp.swiper'), S('cmp.twocolour'), S('cmp.blend')] }, { label: N_('Animation'), items: [S('cmp.play'), S('cmp.rate'), S('cmp.record'), S('mie.play', { kind: 'toggle' }), S('mie.prev'), S('mie.next')] }, { label: N_('Change'), items: [S('chg.detect'), S('chg.confirm')] }, { label: N_('Stereo'), items: [L('stereo.open')] }] }] },
  { id: 'surface', label: N_('Surface Tools'), color: '--c-ctx-surfaceTools', when: (ctx) => ctx.hasDem, tabs: [{ id: 'surface', label: N_('Surface'), groups: [{ label: N_('Analyze'), items: [L('dem.select'), S('dem.hillshade'), S('dem.slope'), S('dem.aspect'), S('dem.relief'), S('dem.contours'), S('dem.contourlines')] }, { label: N_('Line of Sight'), items: [L('los.p2p'), S('los.fan'), S('los.viewshed'), S('los.hlz')] }, { label: N_('Extract'), items: [S('dem.extract'), S('dem.groundfilter')] }, { label: N_('Edit'), items: [S('dem.edit'), S('dem.blockstatus')] }, { label: N_('TIN'), items: [S('tin.new'), S('tin.editor'), S('tin.import'), S('tin.export'), S('tin.raster'), S('tin.view3d')] }, { label: N_('Measure'), items: [S('dem.volume'), S('dem.diff'), S('dem.accuracy')] }, { label: N_('Export'), items: [S('dem.save'), S('dem.r2v')] }] }] },
  { id: 'stereo', label: N_('Stereo Tools'), color: '--c-ctx-stereoTools', when: (ctx) => ctx.stereo, tabs: [{ id: 'stereo', label: N_('Stereo'), groups: [{ label: N_('Model'), items: [L('stereo.open'), S('stereo.manager'), S('stereo.next'), S('stereo.finder'), S('stereo.metrics'), S('stereo.epipolar')] }, { label: N_('Display'), items: [S('stereo.mode.dubois'), S('stereo.mode.true'), S('stereo.mode.grey'), S('stereo.mode.half'), S('stereo.mode.split'), S('stereo.mode.sbs'), S('stereo.mode.cross'), S('stereo.mode.spanned'), S('stereo.mode.dual', { kind: 'toggle' }), S('stereo.xr', { kind: 'toggle' }), S('stereo.mode.overunder'), S('stereo.mode.interleaved'), S('stereo.parity'), S('stereo.swap')] }, { label: N_('Cursor'), items: [S('stereo.cursor'), S('stereo.fixedcursor'), S('stereo.place'), S('stereo.snap'), S('stereo.track')] }, { label: N_('Align'), items: [S('stereo.align'), S('stereo.ypar')] }, { label: N_('Measure'), items: [S('stereo.mpoint'), S('stereo.mheight'), S('stereo.mdistance'), S('stereo.mslope'), S('stereo.mpolyline'), S('stereo.mpolygon'), S('stereo.mvolume')] }] }] },
  { id: 'scene3d', label: N_('3D Tools'), color: '--c-ctx-pointCloudTools', when: (ctx) => ctx.view3d, tabs: [{ id: 'scene3d', label: N_('3D'), groups: [{ label: N_('View'), items: [L('3d.open'), S('3d.exag'), S('3d.sync'), S('3d.close')] }, { label: N_('Navigate'), items: [S('3d.navorbit'), S('3d.navfree'), S('3d.navroute')] }, { label: N_('Measure'), items: [S('3d.measure'), S('3d.los')] }, { label: N_('Models'), items: [S('3d.import'), S('3d.tiles'), S('3d.tiles3tz'), S('3d.qmesh'), S('3d.slpk'), S('3d.i3s'), S('3d.i3sidentify'), S('3d.pdf'), S('3d.record')] }] }] },
  { id: 'pointcloud', label: N_('Point Cloud Tools'), color: '--c-ctx-pointCloudTools', when: (ctx) => ctx.pointCloud, tabs: [{ id: 'pointcloud', label: N_('Point Cloud'), groups: [{ label: N_('Display'), items: [L('pc.header'), S('pc.colour.elevation'), S('pc.colour.intensity'), S('pc.colour.class'), S('pc.colour.rgb'), S('pc.colour.return'), S('pc.colour.source'), S('pc.colour.time'), S('pc.colour.hag'), S('pc.classes'), S('pc.budget'), S('pc.edl'), S('pc.fit'), S('pc.close')] }, { label: N_('Analyze'), items: [S('pc.shave'), S('pc.profile'), S('pc.measure')] }, { label: N_('Generate'), items: [S('pc.dsm'), S('pc.dtm'), S('pc.ndsm'), S('pc.intensity'), S('pc.density'), S('pc.dod'), S('pc.extract'), S('tin.new')] }, { label: N_('Classify'), items: [S('pc.groundfilter'), S('pc.classedit'), S('pc.clip'), S('pc.colourise'), S('pc.registerimage'), S('pc.assigncrs'), S('pc.export')] }] }] },
  { id: 'feature', label: N_('Feature Tools'), color: '--c-ctx-featureTools', when: (ctx) => ctx.activeLayer?.kind === 'vector' || ctx.activeLayer?.kind === 'graphics' || ctx.hasVectors, tabs: [{ id: 'feature', label: N_('Feature'), groups: [{ label: N_('Online'), items: [S('vec.remoteopen'), S('vec.remotesave'), S('vec.attachments'), S('vec.related'), S('vec.versions'), S('vec.lyrx')] }, { label: N_('Capture'), items: [L('ext.toolbox'), S('ext.repeat'), S('ext.custom'), S('ext.newschema')] }, { label: N_('Assist'), items: [S('ext.wand'), S('ext.edgetrace'), S('ext.roadtrace'), S('ext.fromdsm')] }, { label: N_('Edit'), items: [S('ext.vertices'), S('ext.split'), S('ext.merge'), S('ext.reshape'), S('ext.square'), S('ext.droptoground')] }, { label: N_('Attributes'), items: [L('ext.attrtable'), S('ext.attributes'), S('ext.attrsets'), S('ext.styles'), S('ext.query'), S('ext.importcatalog'), S('ext.catalogs')] }, { label: N_('Validate'), items: [S('ext.validate'), S('ext.results')] }, { label: N_('Exchange'), items: [S('ext.saveas', { kind: 'split' }), S('ext.arcgis'), S('ext.export3d'), S('ext.texture')] }, { label: N_('Geoprocessing'), items: [L('vec.buffer'), S('vec.overlay'), S('vec.dissolve'), S('vec.join')] }] }] },
  { id: 'observation', label: N_('Observation Tools'), color: '--c-ctx-observationTools', when: (ctx) => ctx.hasObservations, tabs: [{ id: 'observation', label: N_('Observation'), groups: [{ label: N_('Observe'), items: [L('obs.toolbox'), S('obs.table'), S('obs.field'), S('obs.export')] }] }, { id: 'autodetect', label: N_('Auto Detections'), groups: [{ label: N_('Detections'), items: [L('det.import'), S('det.review')] }] }] },
];

export const QAT = ['qat.undo', 'qat.redo', '-', 'dock.layers', 'dock.toolbox', '-', 'wb.toggle', 'ai.assistant', '-', 'file.save', 'qat.customize'];

export const FILE_MENU = [
  { label: N_('Open'), items: [{ cmd: 'file.openimage' }, { cmd: 'file.openproject' }, { cmd: 'file.openvector' }, { cmd: 'file.opendem' }, { cmd: 'file.openpointcloud' }, { cmd: 'pc.stream' }, { cmd: 'fmv.open' }, { cmd: 'fmv.hls' }, { cmd: 'det.import' }, { cmd: 'vec.remoteopen' }, { cmd: 'file.opengpkg' }, { cmd: 'file.openpack' }] },
  { label: N_('Save'), items: [{ cmd: 'file.save' }, { cmd: 'file.saveas' }, '-', { cmd: 'cnv.saveimage' }, { cmd: 'prod.saveas' }, { cmd: 'tpl.saveas' }] },
  { cmd: 'file.saveoptions' },
  { cmd: 'file.relink' },
  { cmd: 'file.snapshot' },
  '-',
  { cmd: 'file.print' },
  { cmd: 'file.prefs' },
  { cmd: 'file.projectprops' },
  '-',
  { cmd: 'win.close' },
];

export const WORKSPACE_MENUS = [
  {
    label: N_('File'),
    items: [
      { label: N_('New'), items: [{ cmd: 'file.newproject' }, { cmd: 'tpl.new' }] },
      { label: N_('Open'), items: [{ cmd: 'file.openimage' }, { cmd: 'file.openproject' }, { cmd: 'file.openvector' }, { cmd: 'file.opendem' }, { cmd: 'file.openpointcloud' }, { cmd: 'pc.stream' }, { cmd: 'fmv.open' }, { cmd: 'fmv.hls' }, { cmd: 'det.import' }, { cmd: 'vec.remoteopen' }, { cmd: 'file.opengpkg' }, { cmd: 'file.openpack' }] },
      { cmd: 'file.recent' },
      '-',
      { cmd: 'file.save' },
      { cmd: 'file.saveas' },
      { cmd: 'file.saveoptions' },
      { cmd: 'file.relink' },
      { cmd: 'file.projectprops' },
    ],
  },
  { label: N_('Edit'), items: [{ cmd: 'qat.undo' }, { cmd: 'qat.redo' }, { cmd: 'edit.history' }, '-', { cmd: 'edit.copy' }, { cmd: 'edit.paste' }, { cmd: 'sel.all' }, { cmd: 'edit.delete' }] },
  {
    label: N_('View'),
    items: [
      { cmd: 'ws.dataview' },
      { cmd: 'ws.windowsview' },
      { cmd: 'ws.mapview' },
      { cmd: 'ws.preview' },
      '-',
      { cmd: 'ui.palette' },
      { cmd: 'win.workspace' },
      { cmd: 'ui.layout' },
      { cmd: 'keys.customize' },
      { cmd: 'dock.jobs' },
      { cmd: 'dock.netlog' },
      { cmd: 'dock.importlog' },
      { label: N_('Theme'), items: [{ cmd: 'theme.system' }, '-', { cmd: 'theme.m3light' }, { cmd: 'theme.m3dark' }, '-', { cmd: 'theme.grey' }, { cmd: 'theme.dark' }, { cmd: 'theme.print' }] },
      { cmd: 'view.uiscale' },
    ],
  },
  { label: N_('Geospatial'), items: [{ cmd: 'geo.convert' }, { cmd: 'nav.jump' }, { cmd: 'dem.folder' }, { cmd: 'online.add' }] },
  { label: N_('Tools'), items: [{ cmd: 'tools.imagelist' }, { cmd: 'tools.loadpoints' }, { cmd: 'file.prefs' }, { cmd: 'auto.console' }] },
  { label: N_('Add-Ins'), items: [{ cmd: 'ai.assistant' }, { cmd: 'ai.connections' }, { cmd: 'ai.prompthelper' }, { cmd: 'ai.mcp' }, '-', { cmd: 'wb.toggle' }, { cmd: 'wb.review' }, { cmd: 'wb.import' }] },
  { label: N_('Window'), items: () => null },
  { label: N_('Help'), items: [{ cmd: 'help.topics' }, { cmd: 'help.keys' }, { cmd: 'help.limits' }, '-', { cmd: 'help.whatsnew' }, { cmd: 'help.about' }] },
];
