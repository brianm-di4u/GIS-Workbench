// Command registry. Every Ribbon/QAT/menu entry is a command with a fixed id, label, icon,
// owning requirement and release. Feature modules attach behaviour with implement(); a
// command without behaviour is an honest stub that says when it arrives (SDP R0.2).

import { Emitter } from '../core/util.js';
import { STEP_FIRST } from './toast.js';

// [id, label, icon, REQ, release, key?, tip?]
const CATALOG = [
  // QAT / file / edit
  ['qat.undo', 'Undo', 'undo', 'REQ-ARC-13', 'R0', 'Mod+Z'],
  ['qat.redo', 'Redo', 'redo', 'REQ-ARC-13', 'R0', 'Mod+Y'],
  ['qat.customize', 'Customize Quick Access Toolbar', 'caret', 'REQ-UI-04', 'R1'],
  ['file.newproject', 'New Project', 'new', 'REQ-ARC-08', 'R0'],
  ['file.openimage', 'Open Image…', 'image', 'REQ-HOST-02', 'R0', 'Mod+O'],
  ['file.openproject', 'Open Project…', 'open', 'REQ-ARC-08', 'R0'],
  ['file.openvector', 'Open Vector…', 'feature', 'REQ-EXT-21', 'R1'],
  ['file.openpointcloud', 'Open Point Cloud…', 'cloud', 'REQ-LDR-01', 'R2', '', 'Open LAS 1.0–1.5 or LAZ files into a 3D panel (decoded in parallel workers).'],
  ['pc.dod', 'DSM of Difference…', 'layers', 'REQ-LDR-11', 'R2', '', 'Change between two point clouds: DSM of the later minus the earlier.'],
  ['pc.extract', 'Buildings and Trees from Points', 'feature', 'REQ-LDR-11', 'R2', '', 'DSM and DTM from the cloud, then building footprints with heights and trees.'],
  ['pc.stream', 'Stream Point Cloud (COPC/EPT)…', 'cloud', 'REQ-LDR-02', 'R3', '', 'Stream a COPC (HTTP Range) or EPT dataset from an allowed online origin, node by node.'],
  ['file.opendem', 'Open DEM…', 'terrain', 'REQ-DEM-01', 'R0'],
  ['file.openpack', 'Open Data Pack…', 'pack', 'REQ-ARC-14', 'R3', '', 'EGM2008 geoid, HDF5 reader, PROJ, local AI: verified against this build before use.'],
  ['packs.manage', 'Data Packs…', 'pack', 'REQ-ARC-14', 'R3', '', 'Loaded and kept data packs, their versions and licences.'],
  ['file.recent', 'Recent Projects', 'list', 'REQ-UI-04', 'R1'],
  ['file.save', 'Save Project', 'save', 'REQ-ARC-08', 'R0', 'Mod+S'],
  ['file.saveas', 'Save Project As…', 'saveas', 'REQ-ARC-08', 'R0', 'Mod+Shift+S'],
  ['file.saveoptions', 'Save Options…', 'gear', 'REQ-SEC-06', 'R1'],
  ['file.relink', 'Relink Imagery…', 'link', 'REQ-ARC-09', 'R0'],
  ['file.snapshot', 'Export Snapshot', 'chip', 'REQ-ARC-19', 'R2'],
  ['file.print', 'Print', 'print', 'REQ-PRD-03', 'R1'],
  ['file.prefs', 'Preferences…', 'gear', 'REQ-UI-11', 'R0'],
  ['file.projectprops', 'Project Properties…', 'info', 'REQ-ARC-08', 'R0'],
  ['prod.saveas', 'Save Product As…', 'chip', 'REQ-PRD-01', 'R1'],
  ['tpl.saveas', 'Save Template As…', 'template', 'REQ-PRD-02', 'R1'],
  ['tpl.new', 'New Template', 'template', 'REQ-PRD-02', 'R1'],
  ['win.close', 'Close Multiport', 'close', 'REQ-UI-02', 'R0'],
  ['edit.history', 'History…', 'list', 'REQ-ARC-13', 'R0'],
  ['edit.copy', 'Copy', 'copy', 'REQ-IMG-27', 'R1', 'Mod+C'],
  ['edit.paste', 'Paste', 'paste', 'REQ-IMG-27', 'R1', 'Mod+V'],
  ['edit.delete', 'Delete', 'delete', 'REQ-IMG-26', 'R1', 'Delete'],
  // workspace views
  ['ws.dataview', 'Data View', 'table', 'REQ-UI-01', 'R0'],
  ['ws.windowsview', 'Windows View', 'window', 'REQ-UI-01', 'R0'],
  ['ws.mapview', 'Map View', 'globe', 'REQ-UI-01', 'R0'],
  ['ws.preview', 'Preview', 'image', 'REQ-UI-01', 'R0'],
  ['keys.customize', 'Customize Hot Keys…', 'console', 'REQ-UI-09', 'R1'],
  ['dock.jobs', 'Job Queue', 'job', 'REQ-ARC-06', 'R0'],
  ['dock.netlog', 'Network Log', 'network', 'REQ-SEC-12', 'R0'],
  ['dock.importlog', 'Import Log', 'list', 'REQ-UI-05', 'R0', '', 'Every file opened this session, what it became and any errors.'],
  ['ribbon.minimise', 'Minimise the Ribbon', 'caret', 'REQ-UI-03', 'R0', 'Ctrl+F1', 'Hide the Ribbon body to show more of the panels; click a tab to show it again.'],
  ['dock.layers', 'Layer Manager', 'layers', 'REQ-UI-18', 'R0'],
  ['dock.toolbox', 'ToolBox', 'toolbox', 'REQ-EXT-01', 'R1'],
  ['theme.grey', 'Grey (default)', 'theme', 'REQ-UI-12', 'R0'],
  ['theme.dark', 'Dark', 'theme', 'REQ-UI-12', 'R0'],
  ['theme.print', 'Print', 'theme', 'REQ-UI-12', 'R0'],
  ['view.uiscale', 'UI Scale…', 'zoomin', 'REQ-UI-17', 'R1'],
  ['dem.folder', 'Terrain Folder…', 'terrain', 'REQ-DEM-03', 'R2'],
  ['tools.imagelist', 'Image List', 'list', 'REQ-UI-19', 'R1'],
  ['tools.loadpoints', 'Load Point File…', 'point', 'REQ-UI-25', 'R1'],
  ['help.topics', 'Help Topics', 'help', 'REQ-UI-15', 'R0', 'F1'],
  ['help.keys', 'Keyboard Map', 'console', 'REQ-UI-09', 'R0'],
  ['help.limits', 'Accuracy and Limits', 'info', 'REQ-SEC-07', 'R0'],
  ['help.whatsnew', "What's New", 'info', 'REQ-HOST-01', 'R0', '', 'The changes in this version and the ones before it.'],
  ['help.about', 'About & Diagnostics', 'info', 'REQ-HOST-01', 'R0'],
  // Home
  ['nav.glove', 'Glove', 'glove', 'REQ-UI-08', 'R0', '', 'Drag to pan the image'],
  ['nav.recenter', 'Re-center', 'recenter', 'REQ-IMG-11', 'R0', '', 'Click to centre the view on a point'],
  ['nav.roam', 'Mouse (Full Roam)', 'roam', 'REQ-IMG-11', 'R0', 'F7', 'Roam continuously; speed grows with distance from the panel centre'],
  ['nav.jump', 'Jump to Point…', 'jump', 'REQ-IMG-13', 'R0', '', 'Centre on a typed coordinate in any format'],
  ['nav.jumpbox', 'Jump to Coordinate', 'jump', 'REQ-GEO-07', 'R0'],
  ['nav.zoombox', 'Zoom to Box', 'zoombox', 'REQ-IMG-11', 'R0'],
  ['nav.zoomin', 'Zoom In', 'zoomin', 'REQ-IMG-11', 'R0', '+'],
  ['nav.zoomout', 'Zoom Out', 'zoomout', 'REQ-IMG-11', 'R0', '-'],
  ['nav.whole', 'Whole Scene', 'whole', 'REQ-IMG-11', 'R0', 'W'],
  ['nav.onetoone', '1:1', 'onetoone', 'REQ-IMG-11', 'R0', 'Mod+Alt+1'],
  ['nav.magnifier', 'Magnifying Glass', 'magnifier', 'REQ-IMG-14', 'R1'],
  ['view.interpolation', 'Interpolation', 'pixels', 'REQ-IMG-02', 'R0'],
  ['rot.zero', 'Zero (Sensor Native)', 'rotate', 'REQ-IMG-12', 'R0'],
  ['rot.upisup', 'Up is Up', 'height', 'REQ-IMG-12', 'R0'],
  ['rot.north', 'True North', 'north', 'REQ-IMG-12', 'R0'],
  ['rot.shadows', 'Shadows Down', 'sun', 'REQ-IMG-12', 'R0'],
  ['rot.mouse', 'Mouse Rotate', 'rotate', 'REQ-UI-08', 'R0'],
  ['rot.angle', 'Rotation Angle', 'rotate', 'REQ-IMG-12', 'R0'],
  ['link.all', 'Link All Panels', 'link', 'REQ-IMG-15', 'R0'],
  ['link.unlink', 'Unlink', 'unlink', 'REQ-IMG-15', 'R0'],
  ['link.manager', 'Link Manager…', 'link', 'REQ-IMG-15', 'R1'],
  ['link.cursors', 'Linked Cursors…', 'target', 'REQ-IMG-17', 'R1'],
  ['ov.open', 'Open Overview', 'overview', 'REQ-IMG-14', 'R1'],
  ['ov.pip', 'Panel-in-Panel', 'overview', 'REQ-IMG-14', 'R1'],
  ['bm.add', 'Add 2D Bookmark', 'bookmark', 'REQ-IMG-13', 'R1'],
  ['bm.list', 'Bookmarks', 'list', 'REQ-IMG-13', 'R1'],
  // Select
  ['aoi.box', 'Box AOI', 'aoi', 'REQ-IMG-30', 'R1'],
  ['aoi.polygon', 'Polygon AOI', 'polygon', 'REQ-IMG-30', 'R1'],
  ['aoi.fromgraphic', 'AOI from Graphic', 'aoi', 'REQ-IMG-30', 'R1'],
  ['aoi.clear', 'Clear AOI', 'close', 'REQ-IMG-30', 'R1'],
  ['sel.graphics', 'Select Graphics', 'select', 'REQ-EXT-12', 'R0'],
  ['sel.features', 'Select Features', 'feature', 'REQ-EXT-12', 'R1'],
  ['sel.byattr', 'Select by Attribute…', 'table', 'REQ-EXT-12', 'R1'],
  ['sel.byloc', 'Select by Location…', 'jump', 'REQ-EXT-12', 'R1'],
  ['sel.all', 'Select All', 'select', 'REQ-EXT-12', 'R0', 'Mod+A'],
  // Draw
  ['draw.point', 'Point', 'point', 'REQ-IMG-26', 'R0'],
  ['draw.line', 'Line', 'line', 'REQ-IMG-26', 'R0'],
  ['draw.polyline', 'Polyline', 'polyline', 'REQ-IMG-26', 'R0'],
  ['draw.polygon', 'Polygon', 'polygon', 'REQ-IMG-26', 'R0'],
  ['draw.rect', 'Rectangle', 'rect', 'REQ-IMG-26', 'R0'],
  ['draw.ellipse', 'Ellipse', 'ellipse', 'REQ-IMG-26', 'R0'],
  ['draw.circle', 'Circle', 'circle', 'REQ-IMG-26', 'R0'],
  ['draw.arrow', 'Arrow', 'arrow', 'REQ-IMG-26', 'R0'],
  ['draw.text', 'Text Box', 'text', 'REQ-IMG-26', 'R0'],
  ['draw.callout', 'Callout', 'callout', 'REQ-IMG-26', 'R0'],
  ['draw.marker', 'Marker', 'marker', 'REQ-IMG-26', 'R0', 'F5'],
  ['draw.autolabels', 'Auto Labels', 'label', 'REQ-IMG-28', 'R1'],
  ['draw.automap', 'Auto Map', 'globe', 'REQ-IMG-28', 'R1'],
  ['men.point', 'Point Position', 'target', 'REQ-MEN-02', 'R0', '', 'Measure a ground point with CE90/LE90'],
  ['men.bracket', 'Bracket', 'ruler', 'REQ-MEN-02', 'R1'],
  ['men.rangebearing', 'Range & Bearing', 'bearing', 'REQ-MEN-02', 'R0'],
  ['men.length', 'Polyline Length', 'ruler', 'REQ-MEN-02', 'R0'],
  ['men.area', 'Polygon Area', 'area', 'REQ-MEN-02', 'R0'],
  ['men.height', 'Height', 'height', 'REQ-MEN-03', 'R1'],
  ['men.target', 'Target', 'target', 'REQ-MEN-04', 'R1'],
  ['men.log', 'Mensuration Log', 'log', 'REQ-MEN-01', 'R0'],
  ['men.tracking', 'Cursor Tracking', 'jump', 'REQ-MEN-05', 'R0'],
  ['men.targettable', 'Target Table', 'table', 'REQ-MEN-04', 'R1'],
  ['men.depth', 'Depth', 'height', 'REQ-MEN-09', 'R2', '', 'Depth of a point below a reference surface point (negative below)'],
  ['men.medial', 'Medial Axis', 'ruler', 'REQ-MEN-08', 'R1', '', 'Length and width of a polygon along its medial axis'],
  ['men.centre', 'Line Centre Point', 'target', 'REQ-MEN-08', 'R1', '', 'The point halfway along a line'],
  ['draw.sequence', 'Numbered Sequence', 'list', 'REQ-IMG-26', 'R1'],
  ['draw.count', 'Count Graphics', 'sigma', 'REQ-IMG-26', 'R1'],
  ['gfx.props', 'Common Properties', 'gear', 'REQ-IMG-27', 'R1'],
  ['gfx.legend', 'Legend', 'list', 'REQ-IMG-30', 'R1'],
  ['gfx.save', 'Save Graphics…', 'save', 'REQ-IMG-29', 'R0'],
  ['gfx.load', 'Load Graphics…', 'open', 'REQ-IMG-29', 'R0'],
  ['draw.symbol', 'MIL-STD-2525 Symbol…', 'symbol', 'REQ-IMG-32', 'R2'],
  ['gps.route', 'Route', 'polyline', 'REQ-IMG-31', 'R2'],
  ['gps.waypoint', 'Waypoint', 'point', 'REQ-IMG-31', 'R2'],
  ['gps.load', 'Load GPX…', 'open', 'REQ-IMG-31', 'R2'],
  // Geospatial
  ['align.glove', 'Glove Align', 'align', 'REQ-SNS-09', 'R1'],
  ['align.auto', 'Auto Align', 'align', 'REQ-SNS-09', 'R1'],
  ['align.quick', 'Quick Align (2-point)', 'align', 'REQ-SNS-09', 'R1'],
  ['align.poly', 'Polynomial Registration…', 'align', 'REQ-SNS-09', 'R1'],
  ['model.active', 'Active Model', 'model', 'REQ-SNS-06', 'R0'],
  ['model.info', 'Model Info…', 'info', 'REQ-SNS-06', 'R0'],
  ['model.error', 'Error Budget…', 'sigma', 'REQ-MEN-06', 'R0'],
  ['model.gcp', 'GCP Model…', 'point', 'REQ-SNS-05', 'R1'],
  ['tri.mip', 'Multi-Image Point', 'target', 'REQ-MEN-11', 'R2'],
  ['tri.tiepoints', 'Tie Points', 'link', 'REQ-SNS-13', 'R2'],
  ['tri.adjust', 'Block Adjustment…', 'model', 'REQ-SNS-11', 'R2'],
  ['tri.frame', 'Frame Import Wizard…', 'image', 'REQ-SNS-14', 'R2'],
  ['tri.solutions', 'Solutions', 'list', 'REQ-SNS-15', 'R2'],
  ['ortho.rectify', 'Orthorectify…', 'ortho', 'REQ-SNS-17', 'R2'],
  ['ortho.true', 'True Ortho', 'ortho', 'REQ-SNS-19', 'R2', '', 'Orthos through a DSM with occluded cells filled from the other images.'],
  ['ortho.mosaic', 'Mosaic…', 'layout', 'REQ-SNS-18', 'R2'],
  ['ortho.seam', 'Seamline Edit', 'polyline', 'REQ-SNS-18', 'R2'],
  ['ortho.balance', 'Colour Balance', 'contrast', 'REQ-SNS-18', 'R2'],
  ['geo.convert', 'Convert Coordinates…', 'globe', 'REQ-GEO-08', 'R0'],
  ['geo.grid', 'Grid', 'grid', 'REQ-IMG-22', 'R1'],
  ['geo.datum', 'Datum Info', 'info', 'REQ-GEO-01', 'R0'],
  ['online.add', 'Add Online Source…', 'network', 'REQ-ARC-16', 'R2'],
  ['online.backgrounds', 'Map Backgrounds', 'globe', 'REQ-UI-26', 'R1'],
  // Products
  ['chip.view', 'Chip Current View', 'chip', 'REQ-PRD-01', 'R1'],
  ['chip.preset', 'By Preset Area Size', 'chip', 'REQ-PRD-01', 'R1'],
  ['chip.markers', 'All Markers', 'marker', 'REQ-PRD-01', 'R1'],
  ['tpl.apply', 'Apply Template', 'template', 'REQ-PRD-02', 'R1'],
  ['tpl.edit', 'Edit Template', 'template', 'REQ-PRD-02', 'R1'],
  ['tpl.props', 'Product Properties', 'gear', 'REQ-PRD-04', 'R1'],
  ['snap.pptx', 'PowerPoint', 'report', 'REQ-PRD-05', 'R2'],
  ['snap.pdf', 'PDF', 'pdf', 'REQ-PRD-03', 'R1'],
  ['snap.geopdf', 'GeoPDF', 'pdf', 'REQ-PRD-08', 'R3'],
  ['snap.kmz', 'KMZ', 'kmz', 'REQ-PRD-07', 'R1'],
  ['report.template', 'Report Template', 'report', 'REQ-PRD-11', 'R1'],
  ['prod.gif', 'Make Animation…', 'record', 'REQ-PRD-12', 'R3', '', 'Animated GIF from video frames or panel layers, or a short clip with the HUD, for reports and slides.'],
  ['prod.mediapptx', 'Media Slides (PPTX)…', 'record', 'REQ-PRD-12', 'R3'],
  ['prod.pptxtemplate', 'Import PowerPoint Template…', 'open', 'REQ-PRD-09', 'R3', '', 'Slide size, fonts, background and logos from a .pptx/.potx for PPTX exports.'],
  ['report.ai', 'Draft with AI…', 'ai', 'REQ-AI-10', 'R1'],
  ['meta.edit', 'Edit Metadata', 'info', 'REQ-PRD-04', 'R1'],
  ['meta.marking', 'Classification & Marking…', 'marking', 'REQ-SEC-04', 'R0'],
  ['meta.redact', 'Redact / Split Image…', 'cut', 'REQ-SEC-11', 'R2'],
  ['prod.finishing', 'Finishing Tool', 'template', 'REQ-PRD-06', 'R2'],
  // View
  ['win.new', 'New Multiport', 'window', 'REQ-UI-02', 'R0'],
  ['win.clone', 'Clone', 'copy', 'REQ-UI-02', 'R1'],
  ['win.separate', 'Separate Multiport', 'window', 'REQ-UI-02', 'R1'],
  ['win.split', 'Split', 'layout', 'REQ-UI-02', 'R0'],
  ['win.tabbed', 'Tabbed Panels', 'tabs', 'REQ-UI-02', 'R1'],
  ['panel.props', 'Panel Properties', 'gear', 'REQ-UI-18', 'R1'],
  ['panel.visibility', 'Data Visibility', 'layers', 'REQ-UI-18', 'R1'],
  ['panel.legend', 'Legend', 'list', 'REQ-IMG-30', 'R1'],
  ['grid.map', 'Map Grid', 'grid', 'REQ-IMG-22', 'R1'],
  ['grid.grg', 'GRG', 'grid', 'REQ-IMG-23', 'R2'],
  ['grid.micro', 'Micro GRG', 'grid', 'REQ-IMG-23', 'R2'],
  ['grid.props', 'Grid Properties', 'gear', 'REQ-IMG-22', 'R1'],
  ['bg.map', 'Map / Image Background', 'globe', 'REQ-UI-26', 'R1'],
  ['bg.online', 'Online Source Properties', 'network', 'REQ-UI-26', 'R2'],
  ['deco.north', 'North Arrow', 'north', 'REQ-IMG-22', 'R0'],
  ['deco.sun', 'Sun Azimuth', 'sun', 'REQ-IMG-22', 'R1'],
  ['deco.sensor', 'Sensor Azimuth', 'target', 'REQ-IMG-22', 'R1'],
  ['deco.scalebar', 'Scale Bar', 'ruler', 'REQ-IMG-22', 'R0'],
  ['deco.banners', 'Classification Banners', 'marking', 'REQ-SEC-04', 'R0'],
  ['stereo.open', 'Stereo Panel', 'stereo', 'REQ-STR-03', 'R2', '', 'Show the two images of the active panel as a stereo pair on one epipolar display plane.'],
  ['stereo.manager', 'Stereo Model Manager', 'list', 'REQ-STR-02', 'R2'],
  ['stereo.next', 'Next Stereo Model', 'jump', 'REQ-STR-02', 'R2'],
  ['stereo.finder', 'Pair Finder…', 'search', 'REQ-STR-02', 'R2'],
  ['stereo.metrics', 'Pair Metrics', 'sigma', 'REQ-STR-01', 'R2'],
  ['stereo.mode.dubois', 'Anaglyph (Dubois)', 'stereo', 'REQ-STR-04', 'R2'],
  ['stereo.mode.true', 'True Anaglyph', 'stereo', 'REQ-STR-04', 'R2'],
  ['stereo.mode.grey', 'Grey Anaglyph', 'stereo', 'REQ-STR-04', 'R2'],
  ['stereo.mode.half', 'Half-Colour Anaglyph', 'stereo', 'REQ-STR-04', 'R2'],
  ['stereo.mode.split', 'Split Screen', 'layout', 'REQ-STR-04', 'R2'],
  ['stereo.mode.sbs', 'Side-by-Side (Parallel)', 'layout', 'REQ-STR-04', 'R2'],
  ['stereo.mode.cross', 'Side-by-Side (Cross-Eyed)', 'layout', 'REQ-STR-04', 'R2'],
  ['stereo.mode.spanned', 'Spanned (Two Monitors)', 'layout', 'REQ-STR-05', 'R2'],
  ['stereo.mode.dual', 'Dual Output (Second Window)', 'window', 'REQ-STR-06', 'R3', '', 'Left eye in the panel, right eye in a second window (second projector or mirror rig).'],
  ['stereo.xr', 'WebXR Stereo', 'stereo', 'REQ-STR-06', 'R3', '', 'Per-eye stereo in a WebXR headset (immersive-vr) where the browser offers it.'],
  ['stereo.mode.overunder', 'Over-Under', 'layout', 'REQ-STR-05', 'R2'],
  ['stereo.mode.interleaved', 'Row-Interleaved', 'layout', 'REQ-STR-05', 'R2'],
  ['stereo.parity', 'Interleave Parity', 'stereo', 'REQ-STR-05', 'R2'],
  ['stereo.swap', 'Swap Eyes', 'stereo', 'REQ-STR-04', 'R2'],
  ['stereo.cursor', 'Floating Cursor', 'target', 'REQ-STR-08', 'R2'],
  ['stereo.fixedcursor', 'Fixed Cursor', 'target', 'REQ-STR-08', 'R2', '', 'Fixed Cursor keeps the cursor at the panel centre and moves the images; off is Fixed Image.'],
  ['stereo.place', 'Place on Ground', 'terrain', 'REQ-STR-09', 'R2'],
  ['stereo.snap', 'Snap to Ground', 'terrain', 'REQ-STR-09', 'R2'],
  ['stereo.track', 'Terrain Tracking', 'terrain', 'REQ-STR-09', 'R2'],
  ['stereo.align', 'Stereo Align', 'model', 'REQ-SNS-10', 'R2'],
  ['stereo.epipolar', 'Export Epipolar Pair…', 'save', 'REQ-STR-16', 'R2', '', 'Both images resampled to the epipolar display plane over the view, as GeoTIFFs.'],
  ['stereo.ypar', 'Show Y-Parallax', 'sigma', 'REQ-STR-03', 'R2'],
  ['stereo.mpoint', 'Point', 'point', 'REQ-MEN-12', 'R2'],
  ['stereo.mheight', 'Height', 'height', 'REQ-MEN-12', 'R2'],
  ['stereo.mdistance', 'Distance', 'ruler', 'REQ-MEN-12', 'R2'],
  ['stereo.mslope', 'Slope', 'ruler', 'REQ-MEN-12', 'R2'],
  ['stereo.mpolyline', 'Polyline Z', 'polyline', 'REQ-MEN-12', 'R2'],
  ['stereo.mpolygon', 'Polygon Z', 'polygon', 'REQ-MEN-12', 'R2'],
  ['stereo.mvolume', 'Volume', 'area', 'REQ-MEN-12', 'R2'],
  ['3d.open', 'Open 3D Multiport', 'model', 'REQ-STR-11', 'R2'],
  ['3d.sync', 'Sync Now', 'link', 'REQ-STR-11', 'R2'],
  ['3d.syncalways', 'Sync Always', 'link', 'REQ-STR-11', 'R2'],
  ['3d.close', 'Close 3D View', 'close', 'REQ-STR-11', 'R2'],
  ['input.devices', 'Input Devices…', 'gear', 'REQ-UI-20', 'R2', '', 'Gains for X/Y/Z, wheel and keyboard; connect a SpaceMouse (WebHID) or use a gamepad.'],
  ['3d.exag', 'Vertical Exaggeration…', 'height', 'REQ-STR-11', 'R2'],
  ['3d.navorbit', 'Orbit', 'rotate', 'REQ-STR-11', 'R2'],
  ['3d.navfree', 'Free Flight', 'roam', 'REQ-STR-11', 'R2', '', 'W/S forward and back, A/D sideways, Q/E down and up, drag to look; Shift is faster.'],
  ['3d.navroute', 'Fly Route', 'polyline', 'REQ-STR-11', 'R2', '', 'Fly along the selected line feature above the terrain.'],
  ['3d.measure', '3D Cursor Measure', 'ruler', 'REQ-STR-12', 'R2'],
  ['3d.los', '3D Line of Sight', 'los', 'REQ-STR-12', 'R2'],
  ['3d.import', 'Import glTF/GLB…', 'model', 'REQ-STR-13', 'R2'],
  ['3d.qmesh', 'Add Quantized-Mesh Terrain…', 'terrain', 'REQ-ARC-16', 'R3', '', 'Cesium quantized-mesh terrain tiles (layer.json) from an allowed online origin.'],
  ['3d.tiles3tz', 'Open 3D Tiles Archive (.3tz)…', 'globe', 'REQ-STR-15', 'R3', '', 'A local .3tz (3D Tiles in one ZIP).'],
  ['3d.tiles', 'Add 3D Tiles…', 'globe', 'REQ-STR-15', 'R3', '', 'Stream an OGC 3D Tiles tileset (b3dm, glb) from an allowed online origin.'],
  ['3d.record', 'Record WebM…', 'record', 'REQ-STR-14', 'R2'],
  ['ribbon.customize', 'Customize the Ribbon…', 'gear', 'REQ-UI-24', 'R2', '', 'Hide or show Ribbon groups and keep a tab of your own commands.'],
  ['display.fullscreen', 'Exploitation Fullscreen', 'fullscreen', 'REQ-UI-10', 'R0'],
  ['display.theme', 'Theme', 'theme', 'REQ-UI-12', 'R0'],
  ['display.pixels', 'Pixel Matrix Viewer', 'pixels', 'REQ-IMG-21', 'R1'],
  // Add-Ins
  ['ai.assistant', 'AI Assistant', 'ai', 'REQ-AI-01', 'R0', 'Mod+Shift+Space'],
  ['ai.smartselect', 'Smart Select (local AI)', 'wand', 'REQ-EXT-18', 'R3', '', 'Click an object: SlimSAM from the AI data pack outlines it on this device (imagery or DSM hillshade).'],
  ['ai.askselection', 'Ask About Selection', 'ai', 'REQ-AI-01', 'R1'],
  ['ai.describe', 'Describe View', 'observation', 'REQ-AI-09', 'R1'],
  ['ai.proposals', 'Proposals', 'list', 'REQ-AI-06', 'R0'],
  ['ai.connections', 'Connections…', 'plug', 'REQ-AI-02', 'R0'],
  ['ai.allowlist', 'Network Allow-List…', 'network', 'REQ-AI-05', 'R0'],
  ['ai.prompthelper', 'Prompt Helper (offline)…', 'report', 'REQ-AI-13', 'R0'],
  ['ai.mcp', 'MCP Servers…', 'network', 'REQ-AI-14', 'R1'],
  ['wb.toggle', 'Feedback Whiteboard', 'whiteboard', 'REQ-WB-01', 'R0', 'B'],
  ['wb.review', 'Review & Send…', 'send', 'REQ-WB-08', 'R0'],
  ['wb.import', 'Import Feedback…', 'open', 'REQ-WB-11', 'R0'],
  ['auto.console', 'Automation Console', 'console', 'REQ-ARC-17', 'R1'],
  ['auto.mcpserver', 'Expose as MCP Server…', 'network', 'REQ-AI-15', 'R1'],
  ['pack.load', 'Load Data Pack…', 'pack', 'REQ-ARC-14', 'R3'],
  ['pack.list', 'Installed Packs', 'list', 'REQ-ARC-14', 'R3'],
  // Image Tools
  ['img.orthofly', 'Ortho On-the-Fly', 'ortho', 'REQ-IMG-18', 'R2'],
  ['img.vmosaic', 'Virtual Mosaic', 'layout', 'REQ-IMG-18', 'R2'],
  ['img.projection', 'Projection', 'globe', 'REQ-IMG-18', 'R2'],
  ['img.voids', 'Remove Void Pixels', 'aoi', 'REQ-IMG-19', 'R0'],
  ['img.footprint', 'Footprint', 'aoi', 'REQ-IMG-19', 'R0'],
  ['img.segments', 'Segments', 'layers', 'REQ-IMG-20', 'R1'],
  ['enh.brightness', 'Brightness', 'brightness', 'REQ-IMG-06', 'R0'],
  ['enh.contrast', 'Contrast', 'contrast', 'REQ-IMG-06', 'R0'],
  ['enh.gamma', 'Gamma', 'curve', 'REQ-IMG-06', 'R0'],
  ['enh.saturation', 'Saturation', 'theme', 'REQ-IMG-06', 'R0'],
  ['enh.sharpness', 'Sharpness', 'sharpen', 'REQ-IMG-06', 'R1'],
  ['enh.invert', 'Invert', 'invert', 'REQ-IMG-06', 'R0'],
  ['enh.drascope', 'DRA Scope', 'aoi', 'REQ-IMG-05', 'R0'],
  ['enh.dralock', 'Lock DRA', 'select', 'REQ-IMG-05', 'R0'],
  ['enh.drasettings', 'DRA Settings…', 'gear', 'REQ-IMG-05', 'R0'],
  ['enh.stretch', 'Histogram Stretch', 'histogram', 'REQ-IMG-06', 'R0'],
  ['enh.curve', 'Tonal Curve…', 'curve', 'REQ-IMG-06', 'R1'],
  ['enh.lut', 'Pseudo-colour LUT', 'lut', 'REQ-IMG-06', 'R0'],
  ['enh.histogram', 'Histogram Editor', 'histogram', 'REQ-IMG-06', 'R1'],
  ['enh.sharpen', 'Sharpen', 'sharpen', 'REQ-IMG-08', 'R1'],
  ['enh.edge', 'Edge', 'filter', 'REQ-IMG-08', 'R1'],
  ['enh.smooth', 'Smooth', 'smooth', 'REQ-IMG-08', 'R1'],
  ['enh.median', 'Median', 'filter', 'REQ-IMG-08', 'R1'],
  ['enh.morph', 'Morphology', 'filter', 'REQ-IMG-08', 'R1'],
  ['enh.clahe', 'CLAHE', 'contrast', 'REQ-IMG-08', 'R1'],
  ['enh.auto', 'Auto Enhance', 'wand', 'REQ-IMG-07', 'R0'],
  ['enh.reset', 'Reset', 'reset', 'REQ-IMG-07', 'R0'],
  ['enh.remove', 'Remove Enhancements', 'close', 'REQ-IMG-07', 'R0'],
  ['enh.chain', 'Chain Editor…', 'list', 'REQ-IMG-04', 'R0'],
  ['enh.pansharpen', 'Pan Sharpen', 'sharpen', 'REQ-IMG-10', 'R1'],
  ['search.find', 'Find in Scene…', 'search', 'REQ-MSI-07', 'R3'],
  ['search.template', 'Template Match…', 'search', 'REQ-EXT-28', 'R3'],
  ['bands.select', 'Select Bands', 'bands', 'REQ-IMG-09', 'R0'],
  ['bands.preview', 'Band Preview', 'bands', 'REQ-MSI-03', 'R3'],
  ['bands.stats', 'Band Statistics', 'histogram', 'REQ-MSI-07', 'R1'],
  ['bands.snr', 'Assess SNR', 'sigma', 'REQ-MSI-07', 'R3'],
  ['clip.threshold', 'Transparency Threshold', 'aoi', 'REQ-IMG-09', 'R1'],
  ['clip.void', 'Void Pixels', 'aoi', 'REQ-IMG-19', 'R1'],
  ['profile.spectral', 'Spectral Profile', 'curve', 'REQ-MSI-07', 'R3'],
  ['profile.elevation', 'Elevation Profile', 'terrain', 'REQ-DEM-12', 'R1'],
  // Layer Tools
  ['lay.prev', 'Previous Image', 'caret', 'REQ-UI-18', 'R1'],
  ['lay.next', 'Next Image', 'caret', 'REQ-UI-18', 'R1'],
  ['lay.order', 'Order Images', 'layers', 'REQ-UI-18', 'R1'],
  ['cmp.porthole', 'Porthole', 'porthole', 'REQ-IMG-24', 'R1'],
  ['cmp.swiper', 'Swiper', 'swipe', 'REQ-IMG-24', 'R1'],
  ['cmp.twocolour', 'Multi-Colour', 'blend', 'REQ-IMG-24', 'R1'],
  ['cmp.blend', 'Blend', 'blend', 'REQ-IMG-24', 'R1'],
  ['cmp.play', 'Play (Flicker)', 'play', 'REQ-IMG-24', 'R1'],
  ['cmp.rate', 'Flicker Rate', 'job', 'REQ-IMG-24', 'R1'],
  ['cmp.record', 'Record', 'record', 'REQ-IMG-25', 'R1'],
  ['chg.detect', 'Change Detection…', 'flicker', 'SCN-11', 'R1'],
  ['chg.confirm', 'Confirm Change', 'check', 'SCN-11', 'R1'],
  // Surface Tools
  ['dem.select', 'Select Terrain File', 'terrain', 'REQ-DEM-03', 'R0'],
  ['dem.hillshade', 'Hillshade', 'terrain', 'REQ-DEM-10', 'R1'],
  ['dem.slope', 'Slope Map', 'terrain', 'REQ-DEM-10', 'R1'],
  ['dem.aspect', 'Aspect Map', 'terrain', 'REQ-DEM-10', 'R1', '', 'Aspect clockwise from true north: grid north turned by the meridian convergence (gdaldem measures from grid north).'],
  ['dem.relief', 'Colour Relief', 'lut', 'REQ-DEM-10', 'R1'],
  ['dem.contours', 'Contours', 'curve', 'REQ-DEM-11', 'R1'],
  ['dem.contourlines', 'Contour Lines…', 'curve', 'REQ-DEM-11', 'R2', '', 'Contour lines as features, with thicker labelled index lines; they also draw in stereo panels.'],
  ['los.p2p', 'Point-to-Point LOS', 'los', 'REQ-MEN-10', 'R1'],
  ['los.fan', 'Range Fan', 'los', 'REQ-DEM-13', 'R2'],
  ['los.viewshed', '360° Viewshed', 'los', 'REQ-DEM-13', 'R2'],
  ['los.hlz', 'HLZ…', 'terrain', 'REQ-DEM-14', 'R2'],
  ['dem.extract', 'Terrain Extraction…', 'terrain', 'REQ-DEM-04', 'R2'],
  ['dem.groundfilter', 'Ground Filter…', 'filter', 'REQ-DEM-07', 'R2'],
  ['dem.edit', 'Post Edit', 'pen', 'REQ-DEM-08', 'R2'],
  ['dem.volume', 'Volume', 'area', 'REQ-DEM-15', 'R2'],
  ['dem.diff', 'DEM Difference', 'terrain', 'REQ-DEM-15', 'R2'],
  ['dem.accuracy', 'DEM Accuracy…', 'sigma', 'REQ-DEM-17', 'R2'],
  ['dem.save', 'Save DEM As', 'save', 'REQ-DEM-16', 'R2'],
  ['dem.r2v', 'Raster to Vector', 'feature', 'REQ-DEM-18', 'R2'],
  // Point clouds (REQ-LDR, Appendix C Point Cloud tab)
  // Multispectral / hyperspectral (R3, Research/10)
  ['msi.bandmath', 'Band Math…', 'sigma', 'REQ-MSI-04', 'R3', '', 'An expression over bands, compiled to a shader; division by zero is no-data.'],
  ['msi.index.ndvi', 'NDVI', 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.index.ndwi', 'NDWI (McFeeters)', 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.index.ndwi_gao', 'NDWI (Gao) / NDMI', 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.index.mndwi', 'MNDWI', 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.index.ndbi', 'NDBI', 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.index.savi', 'SAVI', 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.index.nbr', 'NBR', 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.preset.natural', 'Natural Colour', 'image', 'REQ-MSI-03', 'R3'],
  ['msi.preset.cir', 'Colour Infrared', 'image', 'REQ-MSI-03', 'R3'],
  ['msi.preset.swir', 'SWIR', 'image', 'REQ-MSI-03', 'R3'],
  ['msi.preset.agriculture', 'Agriculture', 'image', 'REQ-MSI-03', 'R3'],
  ['msi.preset.rededge', 'Red Edge', 'image', 'REQ-MSI-03', 'R3'],
  ['msi.preset.bathymetric', 'Bathymetric', 'image', 'REQ-MSI-03', 'R3'],
  ['msi.radiometric', 'Radiometric Conversion…', 'sun', 'REQ-MSI-05', 'R3', '', 'DN → radiance → reflectance from metadata; DOS, IARR, flat field.'],
  ['msi.stack', 'Layer Stack…', 'layers', 'REQ-MSI-04', 'R3', '', 'One-band files on the same grid (Landsat, Sentinel-2) as one multiband image, for composites, indices and Band Math.'],
  ['msi.threshold', 'Classifier Threshold…', 'filter', 'REQ-MSI-08', 'R3'],
  ['msi.cluster', 'Unsupervised…', 'layers', 'REQ-MSI-09', 'R3', '', 'K-means and ISODATA.'],
  ['msi.majority', 'Majority Filter', 'filter', 'REQ-MSI-09', 'R3'],
  ['msi.sieve', 'Sieve', 'filter', 'REQ-MSI-09', 'R3'],
  ['msi.fill', 'Fill Unclassified', 'filter', 'REQ-MSI-09', 'R3'],
  ['msi.vectors', 'Class Vectors', 'polygon', 'REQ-MSI-09', 'R3'],
  ['msi.accuracy', 'Accuracy Assessment', 'table', 'REQ-MSI-10', 'R3'],
  ['msi.detect', 'Target / Anomaly Detection…', 'target', 'REQ-MSI-11', 'R3'],
  ['msi.pca', 'PCA / MNF…', 'bands', 'REQ-MSI-12', 'R3'],
  ['msi.library', 'Spectral Library…', 'list', 'REQ-MSI-13', 'R3'],
  ['msi.thermal', 'Brightness Temperature…', 'sun', 'REQ-MSI-14', 'R3'],
  ['msi.xport', 'Xport', 'layout', 'REQ-MSI-15', 'R3', '', 'Up to 16 linked panes with different presets and indices.'],
  ['msi.destripe', 'Destripe', 'filter', 'REQ-MSI-16', 'R3'],
  ['msi.change', 'Spectral Change…', 'swipe', 'REQ-MSI-16', 'R3'],
  // SAR (R3, Research/09)
  // Motion imagery (R3, Research/12)
  ['fmv.open', 'Open Video or GMTI…', 'video', 'REQ-FMV-01', 'R3', '', 'MPEG-TS with KLV, STANAG 4607 GMTI, STANAG 4676 tracks.'],
  ['fmv.close', 'Close Video', 'close', 'REQ-FMV-05', 'R3'],
  ['fmv.play', 'Play / Pause', 'play', 'REQ-FMV-08', 'R3', '', 'Play or pause the video in the active panel.'],
  ['fmv.stepback', 'Step Back', 'play', 'REQ-FMV-08', 'R3', '', 'One frame back (decoded exactly through WebCodecs).'],
  ['fmv.stepfwd', 'Step Forward', 'play', 'REQ-FMV-08', 'R3', '', 'One frame forward (decoded exactly through WebCodecs).'],
  ['fmv.loop', 'Loop A–B', 'record', 'REQ-FMV-08', 'R3'],
  ['fmv.klv', 'KLV Table', 'table', 'REQ-FMV-02', 'R3', '', 'Every item with its raw value, checksum status, LS version and unknown items.'],
  ['fmv.basis', 'Time Basis…', 'log', 'REQ-FMV-04', 'R3', '', 'MISP Time (default) or legacy UTC, and a metadata time offset.'],
  ['fmv.hud', 'HUD', 'text', 'REQ-FMV-08', 'R3', '', 'Show the head-up display; drag its blocks to move them.'],
  ['fmv.vmti', 'VMTI Boxes', 'target', 'REQ-FMV-12', 'R3'],
  ['fmv.capture', 'Capture Frame', 'image', 'REQ-FMV-09', 'R3', '', 'PNG + world file + JSON, and NITF 2.1 with IGEOLO and an RPC00B.'],
  ['fmv.event', 'Event Log…', 'bookmark', 'REQ-FMV-10', 'R3', '', 'Log events at the current frame; they plot on the map.'],
  ['fmv.gmti', 'Open GMTI…', 'radar', 'REQ-FMV-11', 'R3', '', 'STANAG 4607 dwells and target reports on the shared time slider.'],
  ['fmv.gmticolour', 'Colour by Velocity', 'lut', 'REQ-FMV-11', 'R3', '', 'GMTI targets coloured by radial velocity (inbound blue, outbound red) instead of age.'],
  ['fmv.measure', 'Measure on Video', 'ruler', 'REQ-FMV-13', 'R3', '', 'Click two points on a paused frame: distance from the KLV frame model.'],
  ['fmv.link', 'Link Video Panels', 'link', 'REQ-FMV-13', 'R3', '', 'Other video panels follow the active clip by UTC.'],
  ['fmv.csv', 'Import Metadata CSV…', 'table', 'REQ-FMV-14', 'R3', '', 'Platform metadata for video without KLV.'],
  ['fmv.export', 'Export Clip (burn-in)…', 'record', 'REQ-FMV-13', 'R3', '', 'WebM with the HUD and VMTI burned in.'],
  ['mie.play', 'Play MIE4NITF Frames', 'play', 'REQ-FMT-14', 'R3', '', 'Play the time-stamped image segments of a MIE4NITF file in order.'],
  ['mie.next', 'Next MIE4NITF Frame', 'play', 'REQ-FMT-14', 'R3'],
  ['mie.prev', 'Previous MIE4NITF Frame', 'play', 'REQ-FMT-14', 'R3'],
  ['sar.metadata', 'SAR Metadata', 'radar', 'REQ-SAR-02', 'R3', '', 'The SICD/SIDD summary card and XML tree.'],
  ['sar.view', 'View SAR', 'radar', 'REQ-SAR-03', 'R3', '', 'Magnitude, phase, I, Q, power and calibrated views.'],
  ['sar.remap', 'SAR Remap', 'lut', 'REQ-SAR-03', 'R3', '', 'Density, Brighter, Darker, High-Contrast, Linear, Log, PEDF, NRL.'],
  ['sar.anamorphic', 'Anamorphic Correction', 'grid', 'REQ-SAR-04', 'R3', '', 'Square the pixels (Col.SS/Row.SS).'],
  ['sar.ground', 'Ground Plane', 'terrain', 'REQ-SAR-04', 'R3', '', 'Show the slant-plane image in a local ground plane.'],
  ['sar.shadows', 'Shadows Down', 'shadow', 'REQ-SAR-04', 'R3'],
  ['sar.northup', 'North Up', 'north', 'REQ-SAR-04', 'R3'],
  ['sar.overlay', 'SAR Overlay', 'arrow', 'REQ-SAR-04', 'R3', '', 'North, layover, look and shadow arrows from SCPCOA.'],
  ['sar.speckle', 'Speckle Filter…', 'filter', 'REQ-SAR-07', 'R3'],
  ['sar.acd', 'Amplitude Change…', 'swipe', 'REQ-SAR-08', 'R3', '', '2CMV, log-ratio and change polygons.'],
  ['sar.ccd', 'Coherent Change…', 'radar', 'REQ-SAR-09', 'R3'],
  ['sar.pairs', 'Pair Finder…', 'search', 'REQ-SAR-10', 'R3'],
  ['sar.subap', 'Sub-aperture Stack', 'layers', 'REQ-SAR-11', 'R3'],
  ['sar.csi', 'Colour Sub-aperture', 'bands', 'REQ-SAR-11', 'R3'],
  ['sar.pauli', 'Pauli Composite', 'bands', 'REQ-SAR-13', 'R3'],
  ['pc.header', 'Header', 'info', 'REQ-LDR-01', 'R2', '', 'The LAS header, VLRs, CRS and class counts.'],
  ['pc.close', 'Close 3D View', 'close', 'REQ-LDR-04', 'R2'],
  ['pc.fit', 'Fit Cloud', 'whole', 'REQ-LDR-04', 'R2'],
  ['pc.colour.elevation', 'Colour by Elevation', 'terrain', 'REQ-LDR-05', 'R2'],
  ['pc.colour.intensity', 'Colour by Intensity', 'contrast', 'REQ-LDR-05', 'R2'],
  ['pc.colour.class', 'Colour by Class', 'layers', 'REQ-LDR-05', 'R2'],
  ['pc.colour.rgb', 'Colour by RGB', 'image', 'REQ-LDR-05', 'R2'],
  ['pc.colour.return', 'Colour by Return', 'bands', 'REQ-LDR-05', 'R2'],
  ['pc.colour.source', 'Colour by Point Source', 'symbol', 'REQ-LDR-05', 'R2'],
  ['pc.colour.time', 'Colour by GPS Time', 'log', 'REQ-LDR-05', 'R2'],
  ['pc.colour.hag', 'Colour by Height Above Ground', 'height', 'REQ-LDR-05', 'R2'],
  ['pc.classes', 'Class Visibility', 'list', 'REQ-LDR-05', 'R2', '', 'Show or hide classes and edit their colours.'],
  ['pc.budget', 'Point Budget', 'gear', 'REQ-LDR-04', 'R2', '', 'Points drawn per frame (default 3 M) and point size.'],
  ['pc.edl', 'Eye-Dome Lighting', 'sun', 'REQ-LDR-04', 'R2'],
  ['pc.shave', 'Elevation Shaving', 'filter', 'REQ-LDR-06', 'R2', '', 'Hide points above or below a plane or a height above ground.'],
  ['pc.profile', 'Profile / Cross-Section', 'line', 'REQ-LDR-07', 'R2', '', 'Points within a swath along a line, with a linked cursor and point-snapped measurement.'],
  ['pc.measure', 'Measure 3D', 'ruler', 'REQ-LDR-07', 'R2', '', '3D and horizontal distance, height difference and height above the DTM.'],
  ['pc.dsm', 'DSM', 'terrain', 'REQ-LDR-08', 'R2'],
  ['pc.dtm', 'DTM', 'terrain', 'REQ-LDR-08', 'R2'],
  ['pc.ndsm', 'nDSM', 'height', 'REQ-LDR-08', 'R2'],
  ['pc.intensity', 'Intensity Image', 'image', 'REQ-LDR-08', 'R2'],
  ['pc.density', 'Density Image', 'grid', 'REQ-LDR-08', 'R2'],
  ['pc.groundfilter', 'Ground Filter', 'wand', 'REQ-LDR-09', 'R2', '', 'SMRF ground classification (undoable).'],
  ['pc.classedit', 'Edit Classes', 'polygon', 'REQ-LDR-09', 'R2', '', 'Reclassify the points inside a polygon drawn on the view (undoable).'],
  ['pc.clip', 'Clip Box/Polygon', 'aoi', 'REQ-LDR-09', 'R2'],
  ['pc.colourise', 'Colourise from Image', 'image', 'REQ-LDR-10', 'R2'],
  ['pc.export', 'Export LAS/LAZ', 'save', 'REQ-LDR-10', 'R2', '', 'LAS 1.4 point format 6 or 7, WGS 84 / UTM, optionally LAZ.'],
  // Feature Tools
  ['ext.toolbox', 'ToolBox', 'toolbox', 'REQ-EXT-01', 'R1'],
  ['ext.repeat', 'Repeat', 'reset', 'REQ-EXT-01', 'R1'],
  ['ext.custom', 'Custom Tools', 'toolbox', 'REQ-EXT-03', 'R2'],
  ['ext.newschema', 'New Layer from Schema…', 'layers', 'REQ-EXT-10', 'R2', '', 'A vector layer for a TDS 7.1 feature class, with its attributes, domains and nulls.'],
  ['ext.attributes', 'Attributes…', 'table', 'REQ-EXT-09', 'R2', '', 'The schema form for the selected feature; can set the layer defaults (persistent attribution).'],
  ['ext.styles', 'Style Sheet…', 'theme', 'REQ-EXT-11', 'R2'],
  ['ext.fromdsm', 'Buildings from DSM', 'terrain', 'REQ-EXT-16', 'R2', '', 'Extract buildings and trees from a DSM (nDSM, roughness, trace, simplify, square, heights).'],
  ['ext.wand', 'Magic Wand', 'wand', 'REQ-EXT-17', 'R2'],
  ['ext.edgetrace', 'Edge Trace', 'pen', 'REQ-EXT-17', 'R2'],
  ['ext.roadtrace', 'Road Trace', 'polyline', 'REQ-EXT-17', 'R2'],
  ['file.opengpkg', 'Open GeoPackage or CSV…', 'open', 'REQ-EXT-22', 'R2'],
  ['ext.vertices', 'Edit Vertices', 'pen', 'REQ-EXT-06', 'R1'],
  ['ext.split', 'Split', 'cut', 'REQ-EXT-06', 'R1'],
  ['ext.merge', 'Merge', 'layers', 'REQ-EXT-06', 'R1'],
  ['ext.reshape', 'Reshape', 'pen', 'REQ-EXT-06', 'R1'],
  ['ext.square', 'Square', 'rect', 'REQ-EXT-05', 'R1'],
  ['ext.droptoground', 'Drop to Ground', 'terrain', 'REQ-EXT-07', 'R2'],
  ['ext.attrtable', 'Feature Attributes Table', 'table', 'REQ-EXT-12', 'R1'],
  ['ext.attrsets', 'Attribute Sets', 'list', 'REQ-EXT-09', 'R2'],
  ['ext.query', 'Feature Query…', 'search', 'REQ-EXT-12', 'R1'],
  ['ext.validate', 'Validate Now', 'check', 'REQ-EXT-13', 'R2'],
  ['ext.results', 'Validation Results', 'list', 'REQ-EXT-13', 'R2'],
  ['ext.saveas', 'Save As', 'save', 'REQ-EXT-21', 'R1'],
  ['ext.arcgis', 'Hand off to ArcGIS Pro', 'send', 'REQ-EXT-24', 'R2'],
  ['ext.export3d', '3D Export', 'model', 'REQ-EXT-25', 'R2'],
  ['ext.texture', 'Texture Buildings…', 'image', 'REQ-EXT-15', 'R3', '', 'Texture building models from an ortho or oblique image through its sensor model.'],
  ['obs.toolbox', 'Observation Toolbox', 'observation', 'REQ-EXT-20', 'R3'],
  ['obs.table', 'Observation Table', 'table', 'REQ-EXT-20', 'R3'],
  ['det.import', 'Import Detections…', 'open', 'REQ-EXT-19', 'R3'],
  ['vec.remoteopen', 'Edit Online Layer…', 'network', 'REQ-EXT-26', 'R3', '', 'Open an ArcGIS REST feature service layer or a WFS-T feature type for editing.'],
  ['vec.remotesave', 'Save Online Edits', 'save', 'REQ-EXT-26', 'R3', '', 'Send adds, updates and deletes to the service (applyEdits or a WFS Transaction).'],
  ['det.review', 'Review Queue', 'list', 'REQ-EXT-19', 'R3'],
  // GIS Workbench 2.0 (release R4): modern shell.
  ['ui.palette', 'Command Palette…', 'search', 'REQ-SHL-05', 'R4', 'Mod+K', 'Find and run any command, or type a coordinate to fly there.'],
  ['win.workspace', 'Workspace Window', 'window', 'REQ-SHL-02', 'R4', '', 'Show or hide the Workspace window: data tree, map view and preview.'],
  ['ui.layout', 'Interface Layout', 'layout', 'REQ-SHL-01', 'R4', '', 'Switches between Modern (clean canvas) and Classic (Ribbon, open docks, as in 1.x).'],
  ['theme.m3light', 'Light', 'theme', 'REQ-SHL-13', 'R4', '', 'Material light theme.'],
  ['theme.m3dark', 'Dark (Material)', 'theme', 'REQ-SHL-13', 'R4', '', 'Material dark theme.'],
  ['hud.radial', 'Radial Menu', 'more', 'REQ-SHL-10', 'R4', 'Space', 'Opens a ring of tools at the cursor: tap Space, drag with the right button, or press `.'],
  ['hud.pill', 'Contextual Tools', 'toolbox', 'REQ-SHL-08', 'R4', '', 'Shows or hides the floating bar of tools for what is selected.'],
  ['hud.flicker', 'Hold to Flicker', 'flicker', 'REQ-SHL-11', 'R4', 'F (hold)', 'Hold F over the panel to see the image underneath; release to come back.'],
  ['hud.quickchip', 'Quick Chip', 'chip', 'REQ-SHL-11', 'R4', 'C + drag', 'Drag a box with C held: a full-resolution chip with its caption goes to the clipboard and the session deck.'],
  ['deck.export', 'Export Session Deck…', 'report', 'REQ-SHL-11', 'R4', '', 'Saves every quick chip of this session as PowerPoint slides.'],
  ['deck.clear', 'Empty Session Deck', 'delete', 'REQ-SHL-11', 'R4', '', 'Removes the quick chips collected so far.'],
  ['patrol.next', 'Next Target', 'jump', 'REQ-SHL-11', 'R4', 'J', 'Centres the next marker, detection or observation at the current zoom.'],
  ['patrol.prev', 'Previous Target', 'jump', 'REQ-SHL-11', 'R4', 'K', 'Centres the previous marker, detection or observation at the current zoom.'],
  ['triage.clear', 'Triage: Clear', 'check', 'REQ-SHL-11', 'R4', '1', 'Marks the current target as clear (nothing there).'],
  ['triage.active', 'Triage: Active', 'target', 'REQ-SHL-11', 'R4', '2', 'Marks the current target as active.'],
  ['triage.flag', 'Triage: Flag', 'marker', 'REQ-SHL-11', 'R4', '3', 'Flags the current target for a closer look.']
];

/** Commands that need a module GIS Workbench Lite leaves out (build.mjs LITE_OMIT), by block (GUI-007). */
const LITE_NEEDS = [
  ['js-three', /^(3d\.|pc\.)|^file\.openpointcloud$/],
  ['wasm-sar', /^sar\.(speckle|acd|ccd|pairs|subap|csi|pauli)$/],
];


export class Commands extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.map = new Map();
    for (const [id, label, ic, req, rel, key, tip] of CATALOG) this.map.set(id, { id, label, icon: ic, req, rel, key: key || '', tip: tip || '', implemented: false });
  }

  get(id) {
    return this.map.get(id);
  }

  list() {
    return [...this.map.values()];
  }

  define(spec) {
    const prev = this.map.get(spec.id) ?? {};
    this.map.set(spec.id, { ...prev, ...spec, implemented: !!spec.run || prev.implemented });
    this.emit('change', spec.id);
  }

  /** Attach behaviour to a catalogued command. */
  implement(id, impl) {
    const c = this.map.get(id);
    if (!c) throw new Error(`unknown command ${id}`);
    Object.assign(c, impl, { implemented: !!impl.run });
    this.emit('change', id);
  }

  /** In the Lite file: why a command cannot run here, else null. */
  liteGap(id) {
    const omitted = this.app.gw?.manifest?.omitted;
    if (!omitted?.length) return null;
    const hit = LITE_NEEDS.find(([block, re]) => omitted.includes(block) && re.test(id));
    return hit ? `${this.map.get(id)?.label ?? id} needs the ${hit[0] === 'wasm-sar' ? 'SAR' : '3D/LiDAR'} module, which GIS Workbench Lite leaves out: open the Standard file` : null;
  }

  enabled(id) {
    const c = this.map.get(id);
    if (!c) return false;
    if (this.liteGap(id)) return false;
    try {
      return c.enabled ? !!c.enabled() : true;
    } catch {
      return false;
    }
  }

  checked(id) {
    const c = this.map.get(id);
    try {
      return c?.checked ? !!c.checked() : false;
    } catch {
      return false;
    }
  }

  async run(id, args) {
    const c = this.map.get(id);
    if (!c) return console.warn('no command', id);
    this.emit('run', { id, args });
    if (!c.run) {
      this.app.toast(`${c.label} is planned for ${c.rel} (${c.req}).`, { kind: 'info' });
      return;
    }
    const gap = this.liteGap(id);
    if (gap) return this.app.toast(gap, { kind: 'info', ms: 6000 });
    if (!this.enabled(id)) return;
    try {
      return await c.run(args);
    } catch (e) {
      const msg = String(e?.message || e);
      // "Do this first" refusals are guidance, not failures (GUI-018, GUI-019).
      if (STEP_FIRST.test(msg)) {
        const action = /no AI connection/.test(msg) ? { label: 'Set up…', run: () => this.run('ai.connections') } : undefined;
        this.app.toast(`${c.label}: ${msg}`, { kind: 'warn', ms: 6000, action });
        return;
      }
      console.error(e);
      this.app.toast(`${c.label}: ${msg}`, { kind: 'error', ms: 6000 });
    }
  }

  /** Counts for the validation report: implemented vs planned per release. */
  coverage() {
    const out = {};
    for (const c of this.map.values()) {
      out[c.rel] ??= { total: 0, implemented: 0 };
      out[c.rel].total++;
      if (c.implemented) out[c.rel].implemented++;
    }
    return out;
  }
}
