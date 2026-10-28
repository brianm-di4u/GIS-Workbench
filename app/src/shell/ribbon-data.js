// Ribbon, QAT and Workspace menu structure as data (Appendix C §2–§7). Commands keep fixed
// positions at every width (REQ-UI-03). A command id resolves through the command registry;
// commands not built yet show their requirement and release (honest stubs, SDP R0.2).
//
// Item forms: 'cmd.id' | {cmd, size:'L'|'S', kind:'split'|'combo'|'toggle'|'gallery'|'input', label?}

const L = (cmd, extra = {}) => ({ cmd, size: 'L', ...extra });
const S = (cmd, extra = {}) => ({ cmd, size: 'S', ...extra });

export const MAIN_TABS = [
  {
    id: 'home',
    label: 'Home',
    key: 'H',
    groups: [
      { label: 'Pan', items: [L('nav.glove'), S('nav.recenter'), S('nav.roam'), S('nav.jump'), { cmd: 'nav.jumpbox', kind: 'input', label: 'Jump to Coordinate:' }] },
      { label: 'Zoom', items: [L('nav.zoombox'), S('nav.zoomin'), S('nav.zoomout'), S('nav.whole'), S('nav.onetoone'), S('nav.magnifier'), { cmd: 'view.interpolation', kind: 'combo', size: 'S' }] },
      { label: 'Rotate', items: [S('rot.zero'), S('rot.upisup'), S('rot.north'), S('rot.shadows'), S('rot.mouse'), { cmd: 'rot.angle', kind: 'input', label: 'Angle' }] },
      { label: 'Linked Panels', launcher: 'link.manager', items: [L('link.all'), S('link.unlink'), S('link.cursors')] },
      { label: 'Overviews', items: [S('ov.open'), S('ov.pip')] },
      { label: 'Bookmarks', items: [S('bm.add'), S('bm.list')] },
    ],
  },
  {
    id: 'select',
    label: 'Select',
    key: 'S',
    groups: [
      { label: 'Area of Interest', items: [L('aoi.box'), S('aoi.polygon'), S('aoi.fromgraphic'), S('aoi.clear')] },
      { label: 'Selection', items: [L('sel.graphics'), S('sel.features'), S('sel.byattr'), S('sel.byloc'), S('sel.all')] },
    ],
  },
  {
    id: 'draw',
    label: 'Draw',
    key: 'D',
    groups: [
      { label: 'Shapes', kind: 'gallery', items: ['draw.point', 'draw.line', 'draw.polyline', 'draw.polygon', 'draw.rect', 'draw.ellipse', 'draw.circle', 'draw.arrow', 'draw.text', 'draw.callout', 'draw.marker'] },
      { label: 'Labels', items: [S('draw.autolabels'), S('draw.automap')] },
      { label: 'Mensuration', launcher: 'men.log', items: [L('men.point'), S('men.bracket'), S('men.rangebearing'), S('men.length'), S('men.area'), S('men.height', { kind: 'split' }), S('men.depth'), S('men.target'), S('men.medial'), S('men.centre'), S('men.log'), S('men.tracking', { kind: 'toggle' })] },
      { label: 'Sequence', items: [S('draw.sequence'), S('draw.count')] },
      { label: 'Manage', items: [S('gfx.props'), S('men.targettable'), S('gfx.legend'), S('gfx.save'), S('gfx.load')] },
      { label: 'Symbols', items: [S('draw.symbol')] },
      { label: 'GPS', items: [S('gps.route'), S('gps.waypoint'), S('gps.load')] },
    ],
  },
  {
    id: 'geospatial',
    label: 'Geospatial',
    key: 'G',
    groups: [
      { label: 'Align', items: [L('align.glove'), S('align.auto'), S('align.quick'), S('align.poly')] },
      { label: 'Sensor Model', items: [L('model.active', { kind: 'split' }), S('model.info'), S('model.error'), S('model.gcp')] },
      { label: 'Triangulation', items: [S('tri.mip'), S('tri.tiepoints'), S('tri.adjust'), S('tri.frame'), S('tri.solutions')] },
      { label: 'Ortho', items: [S('ortho.rectify'), S('ortho.true'), S('ortho.mosaic'), S('ortho.seam'), S('ortho.balance')] },
      { label: 'Coordinates', items: [L('geo.convert'), S('geo.grid', { kind: 'split' }), S('geo.datum')] },
      { label: 'Online', items: [S('online.add'), S('online.backgrounds')] },
    ],
  },
  {
    id: 'products',
    label: 'Products',
    key: 'P',
    groups: [
      { label: 'Chip', items: [L('chip.view'), S('chip.preset'), S('chip.markers')] },
      { label: 'Templates', items: [L('tpl.apply', { kind: 'gallery' }), S('tpl.edit'), S('tpl.props')] },
      { label: 'Snapshot', items: [S('snap.pptx'), S('snap.pdf'), S('snap.geopdf'), S('snap.kmz')] },
      { label: 'Reports', items: [L('report.template', { kind: 'split' }), S('report.ai'), S('obs.toolbox'), S('obs.table'), S('prod.gif'), S('prod.mediapptx'), S('prod.pptxtemplate')] },
      { label: 'Metadata', items: [S('meta.edit'), S('meta.marking'), S('meta.redact')] },
      { label: 'Advanced', items: [L('prod.finishing')] },
    ],
  },
  {
    id: 'view',
    label: 'View',
    key: 'V',
    groups: [
      { label: 'Windows', items: [L('win.new'), S('win.clone'), S('win.separate'), S('win.split', { kind: 'split' }), S('win.tabbed'), S('win.workspace', { kind: 'toggle' })] },
      { label: 'Active Panel', items: [S('panel.props'), S('panel.visibility'), S('panel.legend')] },
      { label: 'Grids', items: [S('grid.map', { kind: 'toggle' }), S('grid.grg'), S('grid.micro'), S('grid.props')] },
      { label: 'Background', items: [S('bg.map'), S('bg.online')] },
      { label: 'Decorations', items: [S('deco.north', { kind: 'toggle' }), S('deco.sun', { kind: 'toggle' }), S('deco.sensor', { kind: 'toggle' }), S('deco.scalebar', { kind: 'toggle' }), S('deco.banners', { kind: 'toggle' })] },
      { label: '3D', items: [S('3d.open'), S('3d.sync'), S('3d.syncalways')] },
      { label: 'Display', items: [L('display.fullscreen'), S('display.theme', { kind: 'split' }), S('display.pixels'), S('input.devices'), S('ribbon.customize'), S('ui.palette'), S('ui.layout')] },
    ],
  },
  {
    id: 'addins',
    label: 'Add-Ins',
    key: 'A',
    groups: [
      { label: 'AI Assistant', items: [L('ai.assistant'), S('ai.askselection'), S('ai.describe'), S('ai.proposals'), S('ai.smartselect', { kind: 'toggle' })] },
      { label: 'AI Setup', items: [S('ai.connections'), S('ai.allowlist'), S('ai.prompthelper'), S('ai.mcp')] },
      { label: 'Feedback', items: [L('wb.toggle'), S('wb.review'), S('wb.import')] },
      { label: 'Automation', items: [S('auto.console'), S('auto.mcpserver')] },
      { label: 'Packs', items: [S('pack.load'), S('pack.list')] },
    ],
  },
];

/** Contextual sets (REQ-UI-03): shown only when the active layer needs them. */
export const CONTEXT_SETS = [
  {
    id: 'image',
    label: 'Image Tools',
    color: '--c-ctx-imageTools',
    when: (ctx) => ctx.activeLayer?.kind === 'image',
    tabs: [
      {
        id: 'visualize',
        label: 'Visualize',
        groups: [
          { label: 'Orthorectify', items: [L('img.orthofly')] },
          { label: 'Mosaic', items: [S('img.vmosaic'), S('img.projection')] },
          { label: 'Display', items: [S('img.voids', { kind: 'toggle' }), S('img.footprint', { kind: 'toggle' }), S('img.segments')] },
        ],
      },
      {
        id: 'enhance',
        label: 'Enhance',
        groups: [
          { label: 'Basic', items: [{ cmd: 'enh.brightness', kind: 'slider' }, { cmd: 'enh.contrast', kind: 'slider' }, { cmd: 'enh.gamma', kind: 'slider' }, { cmd: 'enh.saturation', kind: 'slider' }, { cmd: 'enh.sharpness', kind: 'slider' }, S('enh.invert', { kind: 'toggle' })] },
          { label: 'DRA', launcher: 'enh.drasettings', items: [S('enh.drascope', { kind: 'combo' }), S('enh.dralock', { kind: 'toggle' })] },
          { label: 'Stretch', items: [S('enh.stretch', { kind: 'combo' }), S('enh.curve'), S('enh.lut', { kind: 'combo' }), S('enh.histogram')] },
          { label: 'Filters', items: [S('enh.sharpen'), S('enh.edge'), S('enh.smooth'), S('enh.median'), S('enh.morph'), S('enh.clahe')] },
          { label: 'Processing Chain', items: [L('enh.auto'), S('enh.reset'), S('enh.remove'), S('enh.chain')] },
          { label: 'Pan Sharpen', items: [S('enh.pansharpen', { kind: 'split' })] },
        ],
      },
      { id: 'search', label: 'Search', groups: [{ label: 'Find in Scene', items: [L('search.find'), S('search.template')] }] },
      {
        id: 'analyze',
        label: 'Analyze',
        groups: [
          { label: 'Bands', items: [L('bands.select'), S('bands.preview'), S('bands.stats'), S('bands.snr')] },
          { label: 'Clip Pixels', items: [S('clip.threshold'), S('clip.void')] },
          { label: 'Profile', items: [S('profile.spectral'), S('profile.elevation')] },
          { label: 'Pixel Values', items: [L('display.pixels')] },
          { label: 'Spectral', items: [L('search.find'), S('msi.bandmath'), S('msi.index.ndvi'), S('msi.radiometric'), S('msi.stack'), S('msi.thermal'), S('msi.cluster'), S('msi.detect'), S('msi.pca'), S('msi.xport')] },
          { label: 'SAR', items: [S('sar.view', { kind: 'combo' }), S('sar.anamorphic', { kind: 'toggle' }), S('sar.ccd', { kind: 'split' })] },
        ],
      },
    ],
  },
  { id: 'spectral', label: 'Spectral Tools', color: '--c-ctx-featureTools', when: (ctx) => ctx.multiband, tabs: [{ id: 'spectral', label: 'Spectral', groups: [{ label: 'Bands', items: [L('bands.select'), S('bands.preview'), S('bands.snr'), S('profile.spectral')] }, { label: 'Composites', items: [S('msi.preset.natural'), S('msi.preset.cir'), S('msi.preset.swir'), S('msi.preset.agriculture'), S('msi.preset.rededge'), S('msi.preset.bathymetric')] }, { label: 'Band Math', items: [L('msi.bandmath'), S('msi.index.ndvi'), S('msi.index.ndwi'), S('msi.index.ndwi_gao'), S('msi.index.mndwi'), S('msi.index.ndbi'), S('msi.index.savi'), S('msi.index.nbr')] }, { label: 'Radiometry', items: [S('msi.radiometric'), S('msi.thermal'), S('msi.destripe')] }, { label: 'Classify', items: [L('search.find'), S('msi.threshold'), S('msi.cluster'), S('msi.majority'), S('msi.sieve'), S('msi.fill'), S('msi.vectors'), S('msi.accuracy')] }, { label: 'Detect', items: [S('msi.detect'), S('msi.pca'), S('msi.library'), S('msi.change'), S('search.template')] }, { label: 'Views', items: [S('msi.xport')] }] }] },
  { id: 'video', label: 'Video Tools', color: '--c-ctx-imageTools', when: (ctx) => ctx.video, tabs: [{ id: 'video', label: 'Video', groups: [{ label: 'Player', items: [L('fmv.play', { kind: 'toggle' }), S('fmv.stepback'), S('fmv.stepfwd'), S('fmv.loop', { kind: 'toggle' }), S('fmv.close')] }, { label: 'Metadata', items: [L('fmv.klv'), S('fmv.basis'), S('fmv.hud', { kind: 'toggle' }), S('fmv.vmti', { kind: 'toggle' }), S('fmv.csv')] }, { label: 'Exploit', items: [L('fmv.capture'), S('fmv.event'), S('fmv.measure', { kind: 'toggle' }), S('fmv.export')] }, { label: 'GMTI', items: [S('fmv.gmti'), S('fmv.gmticolour', { kind: 'toggle' }), S('fmv.link', { kind: 'toggle' })] }] }] },
  { id: 'sar', label: 'SAR Tools', color: '--c-ctx-imageTools', when: (ctx) => ctx.sar, tabs: [{ id: 'sar', label: 'SAR', groups: [{ label: 'View', items: [L('sar.metadata'), S('sar.view', { kind: 'combo' }), S('sar.remap', { kind: 'combo' }), S('sar.speckle')] }, { label: 'Geometry', items: [S('sar.anamorphic', { kind: 'toggle' }), S('sar.ground', { kind: 'toggle' }), S('sar.shadows'), S('sar.northup'), S('sar.overlay', { kind: 'toggle' })] }, { label: 'Change', items: [S('sar.acd'), S('sar.ccd'), S('sar.pairs')] }, { label: 'Advanced', items: [S('sar.subap'), S('sar.csi'), S('sar.pauli')] }] }] },
  { id: 'layer', label: 'Layer Tools', color: '--c-ctx-layerTools', when: (ctx) => ctx.imageLayerCount >= 2, tabs: [{ id: 'layers', label: 'Layers', groups: [{ label: 'Ordering', items: [S('lay.prev'), S('lay.next'), S('lay.order')] }, { label: 'Compare', items: [L('cmp.porthole'), S('cmp.swiper'), S('cmp.twocolour'), S('cmp.blend')] }, { label: 'Animation', items: [S('cmp.play'), S('cmp.rate'), S('cmp.record'), S('mie.play', { kind: 'toggle' }), S('mie.prev'), S('mie.next')] }, { label: 'Change', items: [S('chg.detect'), S('chg.confirm')] }, { label: 'Stereo', items: [L('stereo.open')] }] }] },
  { id: 'surface', label: 'Surface Tools', color: '--c-ctx-surfaceTools', when: (ctx) => ctx.hasDem, tabs: [{ id: 'surface', label: 'Surface', groups: [{ label: 'Analyze', items: [L('dem.select'), S('dem.hillshade'), S('dem.slope'), S('dem.aspect'), S('dem.relief'), S('dem.contours'), S('dem.contourlines')] }, { label: 'Line of Sight', items: [L('los.p2p'), S('los.fan'), S('los.viewshed'), S('los.hlz')] }, { label: 'Extract', items: [S('dem.extract'), S('dem.groundfilter')] }, { label: 'Edit', items: [S('dem.edit')] }, { label: 'Measure', items: [S('dem.volume'), S('dem.diff'), S('dem.accuracy')] }, { label: 'Export', items: [S('dem.save'), S('dem.r2v')] }] }] },
  { id: 'stereo', label: 'Stereo Tools', color: '--c-ctx-stereoTools', when: (ctx) => ctx.stereo, tabs: [{ id: 'stereo', label: 'Stereo', groups: [{ label: 'Model', items: [L('stereo.open'), S('stereo.manager'), S('stereo.next'), S('stereo.finder'), S('stereo.metrics'), S('stereo.epipolar')] }, { label: 'Display', items: [S('stereo.mode.dubois'), S('stereo.mode.true'), S('stereo.mode.grey'), S('stereo.mode.half'), S('stereo.mode.split'), S('stereo.mode.sbs'), S('stereo.mode.cross'), S('stereo.mode.spanned'), S('stereo.mode.dual', { kind: 'toggle' }), S('stereo.xr', { kind: 'toggle' }), S('stereo.mode.overunder'), S('stereo.mode.interleaved'), S('stereo.parity'), S('stereo.swap')] }, { label: 'Cursor', items: [S('stereo.cursor'), S('stereo.fixedcursor'), S('stereo.place'), S('stereo.snap'), S('stereo.track')] }, { label: 'Align', items: [S('stereo.align'), S('stereo.ypar')] }, { label: 'Measure', items: [S('stereo.mpoint'), S('stereo.mheight'), S('stereo.mdistance'), S('stereo.mslope'), S('stereo.mpolyline'), S('stereo.mpolygon'), S('stereo.mvolume')] }] }] },
  { id: 'scene3d', label: '3D Tools', color: '--c-ctx-pointCloudTools', when: (ctx) => ctx.view3d, tabs: [{ id: 'scene3d', label: '3D', groups: [{ label: 'View', items: [L('3d.open'), S('3d.exag'), S('3d.sync'), S('3d.close')] }, { label: 'Navigate', items: [S('3d.navorbit'), S('3d.navfree'), S('3d.navroute')] }, { label: 'Measure', items: [S('3d.measure'), S('3d.los')] }, { label: 'Models', items: [S('3d.import'), S('3d.tiles'), S('3d.tiles3tz'), S('3d.qmesh'), S('3d.record')] }] }] },
  { id: 'pointcloud', label: 'Point Cloud Tools', color: '--c-ctx-pointCloudTools', when: (ctx) => ctx.pointCloud, tabs: [{ id: 'pointcloud', label: 'Point Cloud', groups: [{ label: 'Display', items: [L('pc.header'), S('pc.colour.elevation'), S('pc.colour.intensity'), S('pc.colour.class'), S('pc.colour.rgb'), S('pc.colour.return'), S('pc.colour.source'), S('pc.colour.time'), S('pc.colour.hag'), S('pc.classes'), S('pc.budget'), S('pc.edl'), S('pc.fit'), S('pc.close')] }, { label: 'Analyze', items: [S('pc.shave'), S('pc.profile'), S('pc.measure')] }, { label: 'Generate', items: [S('pc.dsm'), S('pc.dtm'), S('pc.ndsm'), S('pc.intensity'), S('pc.density'), S('pc.dod'), S('pc.extract')] }, { label: 'Classify', items: [S('pc.groundfilter'), S('pc.classedit'), S('pc.clip'), S('pc.colourise'), S('pc.export')] }] }] },
  { id: 'feature', label: 'Feature Tools', color: '--c-ctx-featureTools', when: (ctx) => ctx.activeLayer?.kind === 'vector' || ctx.activeLayer?.kind === 'graphics' || ctx.hasVectors, tabs: [{ id: 'feature', label: 'Feature', groups: [{ label: 'Online', items: [S('vec.remoteopen'), S('vec.remotesave')] }, { label: 'Capture', items: [L('ext.toolbox'), S('ext.repeat'), S('ext.custom'), S('ext.newschema')] }, { label: 'Assist', items: [S('ext.wand'), S('ext.edgetrace'), S('ext.roadtrace'), S('ext.fromdsm')] }, { label: 'Edit', items: [S('ext.vertices'), S('ext.split'), S('ext.merge'), S('ext.reshape'), S('ext.square'), S('ext.droptoground')] }, { label: 'Attributes', items: [L('ext.attrtable'), S('ext.attributes'), S('ext.attrsets'), S('ext.styles'), S('ext.query')] }, { label: 'Validate', items: [S('ext.validate'), S('ext.results')] }, { label: 'Exchange', items: [S('ext.saveas', { kind: 'split' }), S('ext.arcgis'), S('ext.export3d'), S('ext.texture')] }] }] },
  { id: 'observation', label: 'Observation Tools', color: '--c-ctx-observationTools', when: (ctx) => ctx.hasObservations, tabs: [{ id: 'observation', label: 'Observation', groups: [{ label: 'Observe', items: [L('obs.toolbox'), S('obs.table')] }] }, { id: 'autodetect', label: 'Auto Detections', groups: [{ label: 'Detections', items: [L('det.import'), S('det.review')] }] }] },
];

export const QAT = ['qat.undo', 'qat.redo', '-', 'dock.layers', 'dock.toolbox', '-', 'wb.toggle', 'ai.assistant', '-', 'file.save', 'qat.customize'];

export const FILE_MENU = [
  { label: 'Open', items: [{ cmd: 'file.openimage' }, { cmd: 'file.openproject' }, { cmd: 'file.openvector' }, { cmd: 'file.opendem' }, { cmd: 'file.openpointcloud' }, { cmd: 'pc.stream' }, { cmd: 'fmv.open' }, { cmd: 'det.import' }, { cmd: 'vec.remoteopen' }, { cmd: 'file.opengpkg' }, { cmd: 'file.openpack' }] },
  { label: 'Save', items: [{ cmd: 'file.save' }, { cmd: 'file.saveas' }, '-', { cmd: 'prod.saveas' }, { cmd: 'tpl.saveas' }] },
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
    label: 'File',
    items: [
      { label: 'New', items: [{ cmd: 'file.newproject' }, { cmd: 'tpl.new' }] },
      { label: 'Open', items: [{ cmd: 'file.openimage' }, { cmd: 'file.openproject' }, { cmd: 'file.openvector' }, { cmd: 'file.opendem' }, { cmd: 'file.openpointcloud' }, { cmd: 'pc.stream' }, { cmd: 'fmv.open' }, { cmd: 'det.import' }, { cmd: 'vec.remoteopen' }, { cmd: 'file.opengpkg' }, { cmd: 'file.openpack' }] },
      { cmd: 'file.recent' },
      '-',
      { cmd: 'file.save' },
      { cmd: 'file.saveas' },
      { cmd: 'file.saveoptions' },
      { cmd: 'file.relink' },
      { cmd: 'file.projectprops' },
    ],
  },
  { label: 'Edit', items: [{ cmd: 'qat.undo' }, { cmd: 'qat.redo' }, { cmd: 'edit.history' }, '-', { cmd: 'edit.copy' }, { cmd: 'edit.paste' }, { cmd: 'sel.all' }, { cmd: 'edit.delete' }] },
  {
    label: 'View',
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
      { label: 'Theme', items: [{ cmd: 'theme.grey' }, { cmd: 'theme.dark' }, { cmd: 'theme.print' }] },
      { cmd: 'view.uiscale' },
    ],
  },
  { label: 'Geospatial', items: [{ cmd: 'geo.convert' }, { cmd: 'nav.jump' }, { cmd: 'dem.folder' }, { cmd: 'online.add' }] },
  { label: 'Tools', items: [{ cmd: 'tools.imagelist' }, { cmd: 'tools.loadpoints' }, { cmd: 'file.prefs' }, { cmd: 'auto.console' }] },
  { label: 'Add-Ins', items: [{ cmd: 'ai.assistant' }, { cmd: 'ai.connections' }, { cmd: 'ai.prompthelper' }, { cmd: 'ai.mcp' }, '-', { cmd: 'wb.toggle' }, { cmd: 'wb.review' }, { cmd: 'wb.import' }] },
  { label: 'Window', items: () => null },
  { label: 'Help', items: [{ cmd: 'help.topics' }, { cmd: 'help.keys' }, { cmd: 'help.limits' }, '-', { cmd: 'help.whatsnew' }, { cmd: 'help.about' }] },
];
