// Command registry. Every Ribbon/QAT/menu entry is a command with a fixed id, label, icon,
// owning requirement and release. Feature modules attach behaviour with implement(); a
// command without behaviour is an honest stub that says when it arrives (SDP R0.2).

import { Emitter } from '../core/util.js';
import { STEP_FIRST } from './toast.js';
import { N_, t, tr, msgOf } from '../i18n/index.js';
import { profilesOf, buildProfile, inProfile } from '../core/profile.js';

// [id, label, icon, REQ, release, key?, tip?]. Labels and tips are English sources marked with
// N_(): the registry is built before the locale loads (main.js), so they are translated where
// they are shown, through labelOf() / tipOf() or tr(c.label). A command added later with define()
// passes N_() labels too, never t() ones.
const CATALOG = [
  // QAT / file / edit
  ['qat.undo', N_('Undo'), 'undo', 'REQ-ARC-13', 'R0', 'Mod+Z'],
  ['qat.redo', N_('Redo'), 'redo', 'REQ-ARC-13', 'R0', 'Mod+Y'],
  ['qat.customize', N_('Customize Quick Access Toolbar'), 'caret', 'REQ-UI-04', 'R1'],
  ['file.newproject', N_('New Project'), 'new', 'REQ-ARC-08', 'R0'],
  ['file.openimage', N_('Open Image…'), 'image', 'REQ-HOST-02', 'R0', 'Mod+O'],
  ['file.openproject', N_('Open Project…'), 'open', 'REQ-ARC-08', 'R0'],
  ['file.openvector', N_('Open Vector…'), 'feature', 'REQ-EXT-21', 'R1'],
  ['file.openpointcloud', N_('Open Point Cloud…'), 'cloud', 'REQ-LDR-01', 'R2', '', N_('Open LAS 1.0–1.5 or LAZ files into a 3D panel (decoded in parallel workers).')],
  ['pc.dod', N_('DSM of Difference…'), 'layers', 'REQ-LDR-11', 'R2', '', N_('Change between two point clouds: DSM of the later minus the earlier.')],
  ['pc.extract', N_('Buildings and Trees from Points'), 'feature', 'REQ-LDR-11', 'R2', '', N_('DSM and DTM from the cloud, then building footprints with heights and trees.')],
  ['pc.stream', N_('Stream Point Cloud (COPC/EPT)…'), 'cloud', 'REQ-LDR-02', 'R3', '', N_('Stream a COPC (HTTP Range) or EPT dataset from an allowed online origin, node by node.')],
  ['file.opendem', N_('Open DEM…'), 'terrain', 'REQ-DEM-01', 'R0'],
  ['file.openpack', N_('Open Data Pack…'), 'pack', 'REQ-ARC-14', 'R3', '', N_('EGM2008 geoid, HDF5 reader, PROJ, local AI: verified against this build before use.')],
  ['packs.manage', N_('Data Packs…'), 'pack', 'REQ-ARC-14', 'R3', '', N_('Loaded and kept data packs, their versions and licences.')],
  ['file.recent', N_('Recent Projects'), 'list', 'REQ-UI-04', 'R1'],
  ['file.save', N_('Save Project'), 'save', 'REQ-ARC-08', 'R0', 'Mod+S'],
  ['file.saveas', N_('Save Project As…'), 'saveas', 'REQ-ARC-08', 'R0', 'Mod+Shift+S'],
  ['file.saveoptions', N_('Save Options…'), 'gear', 'REQ-SEC-06', 'R1'],
  ['file.relink', N_('Relink Imagery…'), 'link', 'REQ-ARC-09', 'R0'],
  ['file.snapshot', N_('Export Snapshot'), 'chip', 'REQ-ARC-19', 'R2'],
  ['file.print', N_('Print'), 'print', 'REQ-PRD-03', 'R1'],
  ['file.prefs', N_('Preferences…'), 'gear', 'REQ-UI-11', 'R0'],
  ['file.projectprops', N_('Project Properties…'), 'info', 'REQ-ARC-08', 'R0'],
  ['prod.saveas', N_('Save Product As…'), 'chip', 'REQ-PRD-01', 'R1'],
  ['tpl.saveas', N_('Save Template As…'), 'template', 'REQ-PRD-02', 'R1'],
  ['tpl.new', N_('New Template'), 'template', 'REQ-PRD-02', 'R1'],
  ['win.close', N_('Close Multiport'), 'close', 'REQ-UI-02', 'R0'],
  ['edit.history', N_('History…'), 'list', 'REQ-ARC-13', 'R0'],
  ['edit.copy', N_('Copy'), 'copy', 'REQ-IMG-27', 'R1', 'Mod+C'],
  ['edit.paste', N_('Paste'), 'paste', 'REQ-IMG-27', 'R1', 'Mod+V'],
  ['edit.delete', N_('Delete'), 'delete', 'REQ-IMG-26', 'R1', 'Delete'],
  // workspace views
  ['ws.dataview', N_('Data View'), 'table', 'REQ-UI-01', 'R0'],
  ['ws.windowsview', N_('Windows View'), 'window', 'REQ-UI-01', 'R0'],
  ['ws.mapview', N_('Map View'), 'globe', 'REQ-UI-01', 'R0'],
  ['ws.preview', N_('Preview'), 'image', 'REQ-UI-01', 'R0'],
  ['keys.customize', N_('Customize Hot Keys…'), 'console', 'REQ-UI-09', 'R1'],
  ['dock.jobs', N_('Job Queue'), 'job', 'REQ-ARC-06', 'R0'],
  ['dock.netlog', N_('Network Log'), 'network', 'REQ-SEC-12', 'R0'],
  ['dock.importlog', N_('Import Log'), 'list', 'REQ-UI-05', 'R0', '', N_('Every file opened this session, what it became and any errors.')],
  ['ribbon.minimise', N_('Minimise the Ribbon'), 'caret', 'REQ-UI-03', 'R0', 'Ctrl+F1', N_('Hide the Ribbon body to show more of the panels; click a tab to show it again.')],
  ['dock.layers', N_('Layer Manager'), 'layers', 'REQ-UI-18', 'R0'],
  ['dock.toolbox', N_('ToolBox'), 'toolbox', 'REQ-EXT-01', 'R1'],
  ['theme.system', N_('Follow System'), 'theme', 'REQ-UI-12', 'R4', '', N_('Light or dark as the operating system is set; the default.')],
  ['theme.grey', N_('Grey'), 'theme', 'REQ-UI-12', 'R0'],
  ['theme.dark', N_('Dark'), 'theme', 'REQ-UI-12', 'R0'],
  ['theme.print', N_('Print Theme'), 'theme', 'REQ-UI-12', 'R0'],
  ['view.uiscale', N_('UI Scale…'), 'zoomin', 'REQ-UI-17', 'R1'],
  ['dem.folder', N_('Terrain Folder…'), 'terrain', 'REQ-DEM-03', 'R2'],
  ['tools.imagelist', N_('Image List'), 'list', 'REQ-UI-19', 'R1'],
  ['tools.loadpoints', N_('Load Point File…'), 'point', 'REQ-UI-25', 'R1'],
  ['help.topics', N_('Help Topics'), 'help', 'REQ-UI-15', 'R0', 'F1'],
  ['help.keys', N_('Keyboard Map'), 'console', 'REQ-UI-09', 'R0'],
  ['help.limits', N_('Accuracy and Limits'), 'info', 'REQ-SEC-07', 'R0'],
  ['help.whatsnew', N_("What's New"), 'info', 'REQ-HOST-01', 'R0', '', N_('The changes in this version and the ones before it.')],
  ['help.about', N_('About & Diagnostics'), 'info', 'REQ-HOST-01', 'R0'],
  // Home
  ['nav.glove', N_('Glove'), 'glove', 'REQ-UI-08', 'R0', '', N_('Drag to pan the image')],
  ['nav.recenter', N_('Re-center'), 'recenter', 'REQ-IMG-11', 'R0', '', N_('Click to centre the view on a point')],
  ['nav.roam', N_('Mouse (Full Roam)'), 'roam', 'REQ-IMG-11', 'R0', 'F7', N_('Roam continuously; speed grows with distance from the panel centre')],
  ['nav.jump', N_('Jump to Point…'), 'jump', 'REQ-IMG-13', 'R0', '', N_('Centre on a typed coordinate in any format')],
  ['nav.jumpbox', N_('Jump to Coordinate'), 'jump', 'REQ-GEO-07', 'R0'],
  ['nav.zoombox', N_('Zoom to Box'), 'zoombox', 'REQ-IMG-11', 'R0'],
  ['nav.zoomin', N_('Zoom In'), 'zoomin', 'REQ-IMG-11', 'R0', '+'],
  ['nav.zoomout', N_('Zoom Out'), 'zoomout', 'REQ-IMG-11', 'R0', '-'],
  ['nav.whole', N_('Whole Scene'), 'whole', 'REQ-IMG-11', 'R0', 'W'],
  ['nav.onetoone', N_('1:1'), 'onetoone', 'REQ-IMG-11', 'R0', 'Mod+Alt+1'],
  ['nav.magnifier', N_('Magnifying Glass'), 'magnifier', 'REQ-IMG-14', 'R1'],
  ['view.interpolation', N_('Interpolation'), 'pixels', 'REQ-IMG-02', 'R0'],
  ['rot.zero', N_('Zero (Sensor Native)'), 'rotate', 'REQ-IMG-12', 'R0'],
  ['rot.upisup', N_('Up is Up'), 'height', 'REQ-IMG-12', 'R0'],
  ['rot.north', N_('True North'), 'north', 'REQ-IMG-12', 'R0'],
  ['rot.shadows', N_('Shadows Down'), 'sun', 'REQ-IMG-12', 'R0'],
  ['rot.mouse', N_('Mouse Rotate'), 'rotate', 'REQ-UI-08', 'R0'],
  ['rot.angle', N_('Rotation Angle'), 'rotate', 'REQ-IMG-12', 'R0'],
  ['link.all', N_('Link All Panels'), 'link', 'REQ-IMG-15', 'R0'],
  ['link.unlink', N_('Unlink'), 'unlink', 'REQ-IMG-15', 'R0'],
  ['link.manager', N_('Link Manager…'), 'link', 'REQ-IMG-15', 'R1'],
  ['link.cursors', N_('Linked Cursors…'), 'target', 'REQ-IMG-17', 'R1'],
  ['ov.open', N_('Open Overview'), 'overview', 'REQ-IMG-14', 'R1'],
  ['ov.pip', N_('Panel-in-Panel'), 'overview', 'REQ-IMG-14', 'R1'],
  ['bm.add', N_('Add 2D Bookmark'), 'bookmark', 'REQ-IMG-13', 'R1'],
  ['bm.list', N_('Bookmarks'), 'list', 'REQ-IMG-13', 'R1'],
  // Select
  ['aoi.box', N_('Box AOI'), 'aoi', 'REQ-IMG-30', 'R1'],
  ['aoi.polygon', N_('Polygon AOI'), 'polygon', 'REQ-IMG-30', 'R1'],
  ['aoi.fromgraphic', N_('AOI from Graphic'), 'aoi', 'REQ-IMG-30', 'R1'],
  ['aoi.clear', N_('Clear AOI'), 'close', 'REQ-IMG-30', 'R1'],
  ['sel.graphics', N_('Select Graphics'), 'select', 'REQ-EXT-12', 'R0'],
  ['sel.features', N_('Select Features'), 'feature', 'REQ-EXT-12', 'R1'],
  ['sel.byattr', N_('Select by Attribute…'), 'table', 'REQ-EXT-12', 'R1'],
  ['sel.byloc', N_('Select by Location…'), 'jump', 'REQ-EXT-12', 'R1'],
  ['sel.all', N_('Select All'), 'select', 'REQ-EXT-12', 'R0', 'Mod+A'],
  // Draw
  ['draw.point', N_('Point'), 'point', 'REQ-IMG-26', 'R0'],
  ['draw.line', N_('Line'), 'line', 'REQ-IMG-26', 'R0'],
  ['draw.polyline', N_('Polyline'), 'polyline', 'REQ-IMG-26', 'R0'],
  ['draw.polygon', N_('Polygon'), 'polygon', 'REQ-IMG-26', 'R0'],
  ['draw.rect', N_('Rectangle'), 'rect', 'REQ-IMG-26', 'R0'],
  ['draw.ellipse', N_('Ellipse'), 'ellipse', 'REQ-IMG-26', 'R0'],
  ['draw.circle', N_('Circle'), 'circle', 'REQ-IMG-26', 'R0'],
  ['draw.arrow', N_('Arrow'), 'arrow', 'REQ-IMG-26', 'R0'],
  ['draw.text', N_('Text Box'), 'text', 'REQ-IMG-26', 'R0'],
  ['draw.callout', N_('Callout'), 'callout', 'REQ-IMG-26', 'R0'],
  ['draw.marker', N_('Marker'), 'marker', 'REQ-IMG-26', 'R0', 'F5'],
  ['draw.autolabels', N_('Auto Labels'), 'label', 'REQ-IMG-28', 'R1'],
  ['draw.automap', N_('Auto Map'), 'globe', 'REQ-IMG-28', 'R1'],
  ['men.point', N_('Point Position'), 'target', 'REQ-MEN-02', 'R0', '', N_('Measure a ground point with CE90/LE90')],
  ['men.bracket', N_('Bracket'), 'ruler', 'REQ-MEN-02', 'R1'],
  ['men.rangebearing', N_('Range & Bearing'), 'bearing', 'REQ-MEN-02', 'R0'],
  ['men.length', N_('Polyline Length'), 'ruler', 'REQ-MEN-02', 'R0'],
  ['men.area', N_('Polygon Area'), 'area', 'REQ-MEN-02', 'R0'],
  ['men.height', N_('Height'), 'height', 'REQ-MEN-03', 'R1'],
  ['men.target', N_('Range Ring Point'), 'target', 'REQ-MEN-04', 'R1'],
  ['men.log', N_('Mensuration Log'), 'log', 'REQ-MEN-01', 'R0'],
  ['men.tracking', N_('Cursor Tracking'), 'jump', 'REQ-MEN-05', 'R0'],
  ['men.targettable', N_('Point Table'), 'table', 'REQ-MEN-04', 'R1'],
  ['men.depth', N_('Depth'), 'height', 'REQ-MEN-09', 'R2', '', N_('Depth of a point below a reference surface point (negative below)')],
  ['men.medial', N_('Medial Axis'), 'ruler', 'REQ-MEN-08', 'R1', '', N_('Length and width of a polygon along its medial axis')],
  ['men.centre', N_('Line Centre Point'), 'target', 'REQ-MEN-08', 'R1', '', N_('The point halfway along a line')],
  ['draw.sequence', N_('Numbered Sequence'), 'list', 'REQ-IMG-26', 'R1'],
  ['draw.count', N_('Count Graphics'), 'sigma', 'REQ-IMG-26', 'R1'],
  ['gfx.props', N_('Common Properties'), 'gear', 'REQ-IMG-27', 'R1'],
  ['gfx.legend', N_('Legend'), 'list', 'REQ-IMG-30', 'R1'],
  ['gfx.save', N_('Save Graphics…'), 'save', 'REQ-IMG-29', 'R0'],
  ['gfx.load', N_('Load Graphics…'), 'open', 'REQ-IMG-29', 'R0'],
  ['gps.route', N_('Route'), 'polyline', 'REQ-IMG-31', 'R2'],
  ['gps.waypoint', N_('Waypoint'), 'point', 'REQ-IMG-31', 'R2'],
  ['gps.load', N_('Load GPX…'), 'open', 'REQ-IMG-31', 'R2'],
  // Geospatial
  ['align.glove', N_('Glove Align'), 'align', 'REQ-SNS-09', 'R1'],
  ['align.auto', N_('Auto Align'), 'align', 'REQ-SNS-09', 'R1'],
  ['align.quick', N_('Quick Align (2-point)'), 'align', 'REQ-SNS-09', 'R1'],
  ['align.poly', N_('Polynomial Registration…'), 'align', 'REQ-SNS-09', 'R1'],
  ['model.active', N_('Active Model'), 'model', 'REQ-SNS-06', 'R0'],
  ['model.info', N_('Model Info…'), 'info', 'REQ-SNS-06', 'R0'],
  ['model.error', N_('Error Budget…'), 'sigma', 'REQ-MEN-06', 'R0'],
  ['model.gcp', N_('GCP Model…'), 'point', 'REQ-SNS-05', 'R1'],
  ['tri.mip', N_('Multi-Image Point'), 'target', 'REQ-MEN-11', 'R2'],
  ['tri.tiepoints', N_('Tie Points'), 'link', 'REQ-SNS-13', 'R2'],
  ['tri.adjust', N_('Block Adjustment…'), 'model', 'REQ-SNS-11', 'R2'],
  ['tri.frame', N_('Frame Import Wizard…'), 'image', 'REQ-SNS-14', 'R2'],
  ['tri.solutions', N_('Solutions'), 'list', 'REQ-SNS-15', 'R2'],
  ['ortho.rectify', N_('Orthorectify…'), 'ortho', 'REQ-SNS-17', 'R2'],
  ['ortho.true', N_('True Ortho'), 'ortho', 'REQ-SNS-19', 'R2', '', N_('Orthos through a DSM with occluded cells filled from the other images.')],
  ['ortho.mosaic', N_('Mosaic…'), 'layout', 'REQ-SNS-18', 'R2'],
  ['ortho.seam', N_('Seamline Edit'), 'polyline', 'REQ-SNS-18', 'R2'],
  ['ortho.balance', N_('Colour Balance'), 'contrast', 'REQ-SNS-18', 'R2'],
  ['geo.convert', N_('Convert Coordinates…'), 'globe', 'REQ-GEO-08', 'R0'],
  ['geo.grid', N_('Grid'), 'grid', 'REQ-IMG-22', 'R1'],
  ['geo.datum', N_('Datum Info'), 'info', 'REQ-GEO-01', 'R0'],
  ['geo.transform', N_('Datum Transform…'), 'globe', 'REQ-GAP-16', 'R8', '', N_('Transform points between datums, frames and height systems with grids (NTv2, NADCON5, OSTN15, geoids) at an epoch.')],
  ['online.add', N_('Add Online Source…'), 'network', 'REQ-ARC-16', 'R2'],
  ['online.backgrounds', N_('Map Backgrounds'), 'globe', 'REQ-UI-26', 'R1'],
  // Products
  ['chip.view', N_('Chip Current View'), 'chip', 'REQ-PRD-01', 'R1'],
  ['chip.preset', N_('By Preset Area Size'), 'chip', 'REQ-PRD-01', 'R1'],
  ['chip.markers', N_('All Markers'), 'marker', 'REQ-PRD-01', 'R1'],
  ['tpl.apply', N_('Apply Template'), 'template', 'REQ-PRD-02', 'R1'],
  ['tpl.edit', N_('Edit Template'), 'template', 'REQ-PRD-02', 'R1'],
  ['tpl.props', N_('Product Properties'), 'gear', 'REQ-PRD-04', 'R1'],
  ['snap.pptx', N_('PowerPoint'), 'report', 'REQ-PRD-05', 'R2'],
  ['snap.pdf', N_('PDF'), 'pdf', 'REQ-PRD-03', 'R1'],
  ['snap.geopdf', N_('GeoPDF'), 'pdf', 'REQ-PRD-08', 'R3'],
  ['snap.kmz', N_('KMZ'), 'kmz', 'REQ-PRD-07', 'R1'],
  ['report.template', N_('Report Template'), 'report', 'REQ-PRD-11', 'R1'],
  ['prod.gif', N_('Make Animation…'), 'record', 'REQ-PRD-12', 'R3', '', N_('Animated GIF from video frames or panel layers, or a short clip with the HUD, for reports and slides.')],
  ['prod.mediapptx', N_('Media Slides (PPTX)…'), 'record', 'REQ-PRD-12', 'R3'],
  ['prod.pptxtemplate', N_('Import PowerPoint Template…'), 'open', 'REQ-PRD-09', 'R3', '', N_('Slide size, fonts, background and logos from a .pptx/.potx for PPTX exports.')],
  ['report.ai', N_('Draft with AI…'), 'ai', 'REQ-AI-10', 'R1'],
  ['meta.edit', N_('Edit Metadata'), 'info', 'REQ-PRD-04', 'R1'],
  ['meta.redact', N_('Redact / Split Image…'), 'cut', 'REQ-SEC-11', 'R2'],
  ['prod.finishing', N_('Finishing Tool'), 'template', 'REQ-PRD-06', 'R2'],
  // View
  ['win.new', N_('New Multiport'), 'window', 'REQ-UI-02', 'R0'],
  ['win.clone', N_('Clone'), 'copy', 'REQ-UI-02', 'R1'],
  ['win.separate', N_('Separate Multiport'), 'window', 'REQ-UI-02', 'R1'],
  ['win.split', N_('Split'), 'layout', 'REQ-UI-02', 'R0'],
  ['win.tabbed', N_('Tabbed Panels'), 'tabs', 'REQ-UI-02', 'R1'],
  ['panel.props', N_('Panel Properties'), 'gear', 'REQ-UI-18', 'R1'],
  ['panel.visibility', N_('Data Visibility'), 'layers', 'REQ-UI-18', 'R1'],
  ['panel.legend', N_('Legend'), 'list', 'REQ-IMG-30', 'R1'],
  ['grid.map', N_('Map Grid'), 'grid', 'REQ-IMG-22', 'R1'],
  ['grid.grg', N_('GRG'), 'grid', 'REQ-IMG-23', 'R2'],
  ['grid.micro', N_('Micro GRG'), 'grid', 'REQ-IMG-23', 'R2'],
  ['grid.props', N_('Grid Properties'), 'gear', 'REQ-IMG-22', 'R1'],
  ['bg.map', N_('Map / Image Background'), 'globe', 'REQ-UI-26', 'R1'],
  ['bg.online', N_('Online Source Properties'), 'network', 'REQ-UI-26', 'R2'],
  ['deco.north', N_('North Arrow'), 'north', 'REQ-IMG-22', 'R0'],
  ['deco.sun', N_('Sun Azimuth'), 'sun', 'REQ-IMG-22', 'R1'],
  ['deco.sensor', N_('Sensor Azimuth'), 'target', 'REQ-IMG-22', 'R1'],
  ['deco.scalebar', N_('Scale Bar'), 'ruler', 'REQ-IMG-22', 'R0'],
  ['stereo.open', N_('Stereo Panel'), 'stereo', 'REQ-STR-03', 'R2', '', N_('Show the two images of the active panel as a stereo pair on one epipolar display plane.')],
  ['stereo.manager', N_('Stereo Model Manager'), 'list', 'REQ-STR-02', 'R2'],
  ['stereo.next', N_('Next Stereo Model'), 'jump', 'REQ-STR-02', 'R2'],
  ['stereo.finder', N_('Pair Finder…'), 'search', 'REQ-STR-02', 'R2'],
  ['stereo.metrics', N_('Pair Metrics'), 'sigma', 'REQ-STR-01', 'R2'],
  ['stereo.mode.dubois', N_('Anaglyph (Dubois)'), 'stereo', 'REQ-STR-04', 'R2'],
  ['stereo.mode.true', N_('True Anaglyph'), 'stereo', 'REQ-STR-04', 'R2'],
  ['stereo.mode.grey', N_('Grey Anaglyph'), 'stereo', 'REQ-STR-04', 'R2'],
  ['stereo.mode.half', N_('Half-Colour Anaglyph'), 'stereo', 'REQ-STR-04', 'R2'],
  ['stereo.mode.split', N_('Split Screen'), 'layout', 'REQ-STR-04', 'R2'],
  ['stereo.mode.sbs', N_('Side-by-Side (Parallel)'), 'layout', 'REQ-STR-04', 'R2'],
  ['stereo.mode.cross', N_('Side-by-Side (Cross-Eyed)'), 'layout', 'REQ-STR-04', 'R2'],
  ['stereo.mode.spanned', N_('Spanned (Two Monitors)'), 'layout', 'REQ-STR-05', 'R2'],
  ['stereo.mode.dual', N_('Dual Output (Second Window)'), 'window', 'REQ-STR-06', 'R3', '', N_('Left eye in the panel, right eye in a second window (second projector or mirror rig).')],
  ['stereo.xr', N_('WebXR Stereo'), 'stereo', 'REQ-STR-06', 'R3', '', N_('Per-eye stereo in a WebXR headset (immersive-vr) where the browser offers it.')],
  ['stereo.mode.overunder', N_('Over-Under'), 'layout', 'REQ-STR-05', 'R2'],
  ['stereo.mode.interleaved', N_('Row-Interleaved'), 'layout', 'REQ-STR-05', 'R2'],
  ['stereo.parity', N_('Interleave Parity'), 'stereo', 'REQ-STR-05', 'R2'],
  ['stereo.swap', N_('Swap Eyes'), 'stereo', 'REQ-STR-04', 'R2'],
  ['stereo.cursor', N_('Floating Cursor'), 'target', 'REQ-STR-08', 'R2'],
  ['stereo.fixedcursor', N_('Fixed Cursor'), 'target', 'REQ-STR-08', 'R2', '', N_('Fixed Cursor keeps the cursor at the panel centre and moves the images; off is Fixed Image.')],
  ['stereo.place', N_('Place on Ground'), 'terrain', 'REQ-STR-09', 'R2'],
  ['stereo.snap', N_('Snap to Ground'), 'terrain', 'REQ-STR-09', 'R2'],
  ['stereo.track', N_('Terrain Tracking'), 'terrain', 'REQ-STR-09', 'R2'],
  ['stereo.align', N_('Stereo Align'), 'model', 'REQ-SNS-10', 'R2'],
  ['stereo.epipolar', N_('Export Epipolar Pair…'), 'save', 'REQ-STR-16', 'R2', '', N_('Both images resampled to the epipolar display plane over the view, as GeoTIFFs.')],
  ['stereo.ypar', N_('Show Y-Parallax'), 'sigma', 'REQ-STR-03', 'R2'],
  ['stereo.mpoint', N_('Point'), 'point', 'REQ-MEN-12', 'R2'],
  ['stereo.mheight', N_('Height'), 'height', 'REQ-MEN-12', 'R2'],
  ['stereo.mdistance', N_('Distance'), 'ruler', 'REQ-MEN-12', 'R2'],
  ['stereo.mslope', N_('Slope'), 'ruler', 'REQ-MEN-12', 'R2'],
  ['stereo.mpolyline', N_('Polyline Z'), 'polyline', 'REQ-MEN-12', 'R2'],
  ['stereo.mpolygon', N_('Polygon Z'), 'polygon', 'REQ-MEN-12', 'R2'],
  ['stereo.mvolume', N_('Volume'), 'area', 'REQ-MEN-12', 'R2'],
  ['3d.open', N_('Open 3D Multiport'), 'model', 'REQ-STR-11', 'R2'],
  ['3d.sync', N_('Sync Now'), 'link', 'REQ-STR-11', 'R2'],
  ['3d.syncalways', N_('Sync Always'), 'link', 'REQ-STR-11', 'R2'],
  ['3d.close', N_('Close 3D View'), 'close', 'REQ-STR-11', 'R2'],
  ['input.devices', N_('Input Devices…'), 'gear', 'REQ-UI-20', 'R2', '', N_('Gains for X/Y/Z, wheel and keyboard; connect a SpaceMouse (WebHID) or use a gamepad.')],
  ['3d.exag', N_('Vertical Exaggeration…'), 'height', 'REQ-STR-11', 'R2'],
  ['3d.navorbit', N_('Orbit'), 'rotate', 'REQ-STR-11', 'R2'],
  ['3d.navfree', N_('Free Flight'), 'roam', 'REQ-STR-11', 'R2', '', N_('W/S forward and back, A/D sideways, Q/E down and up, drag to look; Shift is faster.')],
  ['3d.navroute', N_('Fly Route'), 'polyline', 'REQ-STR-11', 'R2', '', N_('Fly along the selected line feature above the terrain.')],
  ['3d.measure', N_('3D Cursor Measure'), 'ruler', 'REQ-STR-12', 'R2'],
  ['3d.los', N_('3D Line of Sight'), 'los', 'REQ-STR-12', 'R2'],
  ['3d.import', N_('Import glTF/GLB…'), 'model', 'REQ-STR-13', 'R2'],
  ['3d.qmesh', N_('Add Quantized-Mesh Terrain…'), 'terrain', 'REQ-ARC-16', 'R3', '', N_('Cesium quantized-mesh terrain (layer.json, EPSG:4326 or EPSG:3857) from an allowed online origin or a local folder (REQ-FMT-38).')],
  ['3d.tiles3tz', N_('Open Local 3D Tiles…'), 'globe', 'REQ-STR-15', 'R3', '', N_('A .3tz archive, a tileset.json with its tiles, a ZIP of a tileset, or single b3dm, pnts, i3dm or cmpt tiles (REQ-FMT-36).')],
  ['3d.tiles', N_('Add 3D Tiles…'), 'globe', 'REQ-STR-15', 'R3', '', N_('Stream an OGC 3D Tiles tileset (b3dm, pnts, i3dm, cmpt, glb, implicit tiling) from an allowed online origin or a local folder.')],
  ['3d.record', N_('Record WebM…'), 'record', 'REQ-STR-14', 'R2'],
  ['ribbon.customize', N_('Customize the Ribbon…'), 'gear', 'REQ-UI-24', 'R2', '', N_('Hide or show Ribbon groups and keep a tab of your own commands.')],
  ['display.fullscreen', N_('Analysis Fullscreen'), 'fullscreen', 'REQ-UI-10', 'R0'],
  ['display.theme', N_('Theme'), 'theme', 'REQ-UI-12', 'R0'],
  ['display.pixels', N_('Pixel Matrix Viewer'), 'pixels', 'REQ-IMG-21', 'R1'],
  // Add-Ins
  ['ai.assistant', N_('AI Assistant'), 'ai', 'REQ-AI-01', 'R0', 'Mod+Shift+Space'],
  ['ai.smartselect', N_('Smart Select (local AI)'), 'wand', 'REQ-EXT-18', 'R3', '', N_('Click an object: SlimSAM from the AI data pack outlines it on this device (imagery or DSM hillshade).')],
  ['ai.askselection', N_('Ask About Selection'), 'ai', 'REQ-AI-01', 'R1'],
  ['ai.describe', N_('Describe View'), 'observation', 'REQ-AI-09', 'R1'],
  ['ai.proposals', N_('Proposals'), 'list', 'REQ-AI-06', 'R0'],
  ['ai.connections', N_('Connections…'), 'plug', 'REQ-AI-02', 'R0'],
  ['ai.allowlist', N_('Network Allow-List…'), 'network', 'REQ-AI-05', 'R0'],
  ['ai.prompthelper', N_('Prompt Helper (offline)…'), 'report', 'REQ-AI-13', 'R0'],
  ['ai.mcp', N_('MCP Servers…'), 'network', 'REQ-AI-14', 'R1'],
  ['wb.toggle', N_('Feedback Whiteboard'), 'whiteboard', 'REQ-WB-01', 'R0', 'B'],
  ['wb.review', N_('Review & Send…'), 'send', 'REQ-WB-08', 'R0'],
  ['wb.import', N_('Import Feedback…'), 'open', 'REQ-WB-11', 'R0'],
  ['auto.console', N_('Automation Console'), 'console', 'REQ-ARC-17', 'R1'],
  ['auto.mcpserver', N_('Expose as MCP Server…'), 'network', 'REQ-AI-15', 'R1'],
  ['pack.load', N_('Load Data Pack…'), 'pack', 'REQ-ARC-14', 'R3'],
  ['pack.list', N_('Installed Packs'), 'list', 'REQ-ARC-14', 'R3'],
  // Image Tools
  ['img.orthofly', N_('Ortho On-the-Fly'), 'ortho', 'REQ-IMG-18', 'R2'],
  ['img.vmosaic', N_('Virtual Mosaic'), 'layout', 'REQ-IMG-18', 'R2'],
  ['img.projection', N_('Projection'), 'globe', 'REQ-IMG-18', 'R2'],
  ['img.voids', N_('Remove Void Pixels'), 'aoi', 'REQ-IMG-19', 'R0'],
  ['img.footprint', N_('Footprint'), 'aoi', 'REQ-IMG-19', 'R0'],
  ['img.segments', N_('Segments'), 'layers', 'REQ-IMG-20', 'R1'],
  ['enh.brightness', N_('Brightness'), 'brightness', 'REQ-IMG-06', 'R0'],
  ['enh.contrast', N_('Contrast'), 'contrast', 'REQ-IMG-06', 'R0'],
  ['enh.gamma', N_('Gamma'), 'curve', 'REQ-IMG-06', 'R0'],
  ['enh.saturation', N_('Saturation'), 'theme', 'REQ-IMG-06', 'R0'],
  ['enh.sharpness', N_('Sharpness'), 'sharpen', 'REQ-IMG-06', 'R1'],
  ['enh.invert', N_('Invert'), 'invert', 'REQ-IMG-06', 'R0'],
  ['enh.drascope', N_('DRA Scope'), 'aoi', 'REQ-IMG-05', 'R0'],
  ['enh.dralock', N_('Lock DRA'), 'select', 'REQ-IMG-05', 'R0'],
  ['enh.drasettings', N_('DRA Settings…'), 'gear', 'REQ-IMG-05', 'R0'],
  ['enh.stretch', N_('Histogram Stretch'), 'histogram', 'REQ-IMG-06', 'R0'],
  ['enh.curve', N_('Tonal Curve…'), 'curve', 'REQ-IMG-06', 'R1'],
  ['enh.lut', N_('Pseudo-colour LUT'), 'lut', 'REQ-IMG-06', 'R0'],
  ['enh.histogram', N_('Histogram Editor'), 'histogram', 'REQ-IMG-06', 'R1'],
  ['enh.sharpen', N_('Sharpen'), 'sharpen', 'REQ-IMG-08', 'R1'],
  ['enh.edge', N_('Edge'), 'filter', 'REQ-IMG-08', 'R1'],
  ['enh.smooth', N_('Smooth'), 'smooth', 'REQ-IMG-08', 'R1'],
  ['enh.median', N_('Median'), 'filter', 'REQ-IMG-08', 'R1'],
  ['enh.morph', N_('Morphology'), 'filter', 'REQ-IMG-08', 'R1'],
  ['enh.clahe', N_('CLAHE'), 'contrast', 'REQ-IMG-08', 'R1'],
  ['enh.auto', N_('Auto Enhance'), 'wand', 'REQ-IMG-07', 'R0'],
  ['enh.reset', N_('Reset'), 'reset', 'REQ-IMG-07', 'R0'],
  ['enh.remove', N_('Remove Enhancements'), 'close', 'REQ-IMG-07', 'R0'],
  ['enh.chain', N_('Chain Editor…'), 'list', 'REQ-IMG-04', 'R0'],
  ['enh.pansharpen', N_('Pan Sharpen'), 'sharpen', 'REQ-IMG-10', 'R1'],
  ['search.find', N_('Find in Scene…'), 'search', 'REQ-MSI-07', 'R3'],
  ['search.template', N_('Template Match…'), 'search', 'REQ-EXT-28', 'R3'],
  ['bands.select', N_('Select Bands'), 'bands', 'REQ-IMG-09', 'R0'],
  ['bands.preview', N_('Band Preview'), 'bands', 'REQ-MSI-03', 'R3'],
  ['bands.stats', N_('Band Statistics'), 'histogram', 'REQ-MSI-07', 'R1'],
  ['bands.snr', N_('Assess SNR'), 'sigma', 'REQ-MSI-07', 'R3'],
  ['clip.threshold', N_('Transparency Threshold'), 'aoi', 'REQ-IMG-09', 'R1'],
  ['clip.void', N_('Void Pixels'), 'aoi', 'REQ-IMG-19', 'R1'],
  ['profile.spectral', N_('Spectral Profile'), 'curve', 'REQ-MSI-07', 'R3'],
  ['profile.elevation', N_('Elevation Profile'), 'terrain', 'REQ-DEM-12', 'R1'],
  // Layer Tools
  ['lay.prev', N_('Previous Image'), 'caret', 'REQ-UI-18', 'R1'],
  ['lay.next', N_('Next Image'), 'caret', 'REQ-UI-18', 'R1'],
  ['lay.order', N_('Order Images'), 'layers', 'REQ-UI-18', 'R1'],
  ['cmp.porthole', N_('Porthole'), 'porthole', 'REQ-IMG-24', 'R1'],
  ['cmp.swiper', N_('Swiper'), 'swipe', 'REQ-IMG-24', 'R1'],
  ['cmp.twocolour', N_('Multi-Colour'), 'blend', 'REQ-IMG-24', 'R1'],
  ['cmp.blend', N_('Blend'), 'blend', 'REQ-IMG-24', 'R1'],
  ['cmp.play', N_('Play (Flicker)'), 'play', 'REQ-IMG-24', 'R1'],
  ['cmp.rate', N_('Flicker Rate'), 'job', 'REQ-IMG-24', 'R1'],
  ['cmp.record', N_('Record'), 'record', 'REQ-IMG-25', 'R1'],
  ['chg.detect', N_('Change Detection…'), 'flicker', 'SCN-11', 'R1'],
  ['chg.confirm', N_('Confirm Change'), 'check', 'SCN-11', 'R1'],
  // Surface Tools
  ['dem.select', N_('Select Terrain File'), 'terrain', 'REQ-DEM-03', 'R0'],
  ['dem.useterrain', N_('Use as Terrain…'), 'terrain', 'REQ-DEM-03', 'R4', '', N_('Uses the active single-band elevation image as the terrain: heights, line of sight and the Surface tools work from it.')],
  ['dem.hillshade', N_('Hillshade'), 'terrain', 'REQ-DEM-10', 'R1'],
  ['dem.slope', N_('Slope Map'), 'terrain', 'REQ-DEM-10', 'R1'],
  ['dem.aspect', N_('Aspect Map'), 'terrain', 'REQ-DEM-10', 'R1', '', N_('Aspect clockwise from true north: grid north turned by the meridian convergence (gdaldem measures from grid north).')],
  ['dem.relief', N_('Colour Relief'), 'lut', 'REQ-DEM-10', 'R1'],
  ['dem.contours', N_('Contours'), 'curve', 'REQ-DEM-11', 'R1'],
  ['dem.contourlines', N_('Contour Lines…'), 'curve', 'REQ-DEM-11', 'R2', '', N_('Contour lines as features, with thicker labelled index lines; they also draw in stereo panels.')],
  ['los.p2p', N_('Point-to-Point LOS'), 'los', 'REQ-MEN-10', 'R1'],
  ['los.fan', N_('Range Fan'), 'los', 'REQ-DEM-13', 'R2'],
  ['los.viewshed', N_('360° Viewshed'), 'los', 'REQ-DEM-13', 'R2'],
  ['los.hlz', N_('HLZ…'), 'terrain', 'REQ-DEM-14', 'R2'],
  ['hydro.fill', N_('Fill Sinks…'), 'terrain', 'REQ-GAP-80', 'R10', '', N_('Fills the pits of the elevation model so water can flow off it, as a new terrain layer.')],
  ['hydro.flow', N_('Flow Accumulation…'), 'sigma', 'REQ-GAP-80', 'R10', '', N_('Counts the posts upslope of each post (D8 or D-infinity) as a new layer.')],
  ['hydro.streams', N_('Stream Network…'), 'network', 'REQ-GAP-80', 'R10', '', N_('Traces the streams draining at least an area you set, with their Strahler order and Shreve magnitude.')],
  ['hydro.watershed', N_('Watershed…'), 'polygon', 'REQ-GAP-80', 'R10', '', N_('Outlines the area draining to a point you pick, such as a stream gauge.')],
  ['dem.extract', N_('Terrain Extraction…'), 'terrain', 'REQ-DEM-04', 'R2'],
  ['dem.groundfilter', N_('Ground Filter…'), 'filter', 'REQ-DEM-07', 'R2'],
  ['dem.edit', N_('Post Edit'), 'pen', 'REQ-DEM-08', 'R2'],
  ['dem.blockstatus', N_('Block Status…'), 'list', 'REQ-GAP-37', 'R8', '', N_('The DEM in 256 × 256 post blocks: voids, edits and review state; mark blocks reviewed or accepted.')],
  // 2.5 (REQ-GAP-39): TIN editing (Full).
  ['tin.new', N_('New TIN…'), 'terrain', 'REQ-GAP-39', 'R8', '', N_('A TIN from the DEM posts (thinned to a vertical tolerance) or from point-cloud ground points.')],
  ['tin.editor', N_('TIN Editor'), 'pen', 'REQ-GAP-39', 'R8', '', N_('Mass points, breaklines, ridge and drain profiles and exclusion areas of a TIN; wireframe and shaded display.')],
  ['tin.import', N_('Import TIN…'), 'open', 'REQ-GAP-39', 'R8', '', N_('A LandXML surface, or mass points and breaklines from Shapefile, GeoJSON or CSV.')],
  ['tin.export', N_('Export TIN…'), 'save', 'REQ-GAP-39', 'R8', '', N_('The TIN as a LandXML surface, or its mass points and breaklines as Shapefile, GeoJSON or CSV.')],
  ['tin.raster', N_('TIN to DEM…'), 'layers', 'REQ-GAP-39', 'R8', '', N_('A DEM layer from the TIN: linear interpolation in each triangle.')],
  ['tin.view3d', N_('TIN in 3D'), 'model', 'REQ-GAP-39', 'R8', '', N_('Shows the TIN as a shaded mesh in the 3D view.')],
  ['dem.volume', N_('Volume'), 'area', 'REQ-DEM-15', 'R2'],
  ['dem.diff', N_('DEM Difference'), 'terrain', 'REQ-DEM-15', 'R2'],
  ['dem.accuracy', N_('DEM Accuracy…'), 'sigma', 'REQ-DEM-17', 'R2'],
  ['dem.save', N_('Save DEM As'), 'save', 'REQ-DEM-16', 'R2'],
  ['dem.r2v', N_('Raster to Vector'), 'feature', 'REQ-DEM-18', 'R2'],
  // Point clouds (REQ-LDR, Appendix C Point Cloud tab)
  // Multispectral / hyperspectral (R3, Research/10)
  ['msi.bandmath', N_('Band Math…'), 'sigma', 'REQ-MSI-04', 'R3', '', N_('An expression over bands, compiled to a shader; division by zero is no-data.')],
  ['msi.index.ndvi', N_('NDVI'), 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.index.ndwi', N_('NDWI (McFeeters)'), 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.index.ndwi_gao', N_('NDWI (Gao) / NDMI'), 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.index.mndwi', N_('MNDWI'), 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.index.ndbi', N_('NDBI'), 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.index.savi', N_('SAVI'), 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.index.nbr', N_('NBR'), 'bands', 'REQ-MSI-04', 'R3'],
  ['msi.preset.natural', N_('Natural Colour'), 'image', 'REQ-MSI-03', 'R3'],
  ['msi.preset.cir', N_('Colour Infrared'), 'image', 'REQ-MSI-03', 'R3'],
  ['msi.preset.swir', N_('SWIR'), 'image', 'REQ-MSI-03', 'R3'],
  ['msi.preset.agriculture', N_('Agriculture'), 'image', 'REQ-MSI-03', 'R3'],
  ['msi.preset.rededge', N_('Red Edge'), 'image', 'REQ-MSI-03', 'R3'],
  ['msi.preset.bathymetric', N_('Bathymetric'), 'image', 'REQ-MSI-03', 'R3'],
  ['msi.radiometric', N_('Radiometric Conversion…'), 'sun', 'REQ-MSI-05', 'R3', '', N_('DN → radiance → reflectance from metadata; DOS, IARR, flat field.')],
  ['msi.stack', N_('Layer Stack…'), 'layers', 'REQ-MSI-04', 'R3', '', N_('One-band files on the same grid (Landsat, Sentinel-2) as one multiband image, for composites, indices and Band Math.')],
  ['msi.threshold', N_('Classifier Threshold…'), 'filter', 'REQ-MSI-08', 'R3'],
  ['msi.cluster', N_('Unsupervised…'), 'layers', 'REQ-MSI-09', 'R3', '', N_('K-means and ISODATA.')],
  ['msi.majority', N_('Majority Filter'), 'filter', 'REQ-MSI-09', 'R3'],
  ['msi.sieve', N_('Sieve'), 'filter', 'REQ-MSI-09', 'R3'],
  ['msi.fill', N_('Fill Unclassified'), 'filter', 'REQ-MSI-09', 'R3'],
  ['msi.vectors', N_('Class Vectors'), 'polygon', 'REQ-MSI-09', 'R3'],
  ['msi.accuracy', N_('Accuracy Assessment'), 'table', 'REQ-MSI-10', 'R3'],
  ['msi.detect', N_('Spectral Anomaly Detection…'), 'target', 'REQ-MSI-11', 'R3'],
  ['msi.pca', N_('PCA / MNF…'), 'bands', 'REQ-MSI-12', 'R3'],
  ['ts.stack', N_('Time Stack…'), 'layers', 'REQ-GAP-83', 'R11', '', N_('Stacks dated images, each from its file name or metadata, in date order on one grid, resampling those on another grid, as a time series.')],
  ['ts.panel', N_('Time Series'), 'curve', 'REQ-GAP-83', 'R11', '', N_('Opens the Time Series panel: a date slider with playback and recording, and the values over time at the cursor, a pinned point or the AOI, with CSV export.')],
  ['ts.trend', N_('Temporal Trend…'), 'curve', 'REQ-GAP-83', 'R11', '', N_('Fits a straight line through each pixel of a time series: the slope per year, its p-value and the number of dates used.')],
  ['ts.anomaly', N_('Temporal Anomaly…'), 'curve', 'REQ-GAP-83', 'R11', '', N_('Each date of a time series against a baseline period, as a difference or a z-score, compared with the same calendar month or the whole baseline.')],
  ['addr.index', N_('Address Index…'), 'search', 'REQ-GAP-85', 'R11', '', N_('Builds an address index from your own address layer (points with a number and street, or streets with number ranges), and can save it as a GeoPackage.')],
  ['addr.find', N_('Find Address…'), 'pin', 'REQ-GAP-85', 'R11', '', N_('Finds an address in your address index, with spelling slips forgiven, and marks it. Nothing is sent anywhere.')],
  ['addr.batch', N_('Geocode a Table…'), 'table', 'REQ-GAP-85', 'R11', '', N_('Finds every address in a CSV table, as points with how they matched and a score.')],
  ['addr.reverse', N_('Reverse Geocode'), 'pin', 'REQ-GAP-85', 'R11', '', N_('Click a place to get the nearest address in your address index.')],
  ['route.roads', N_('Road Network…'), 'line', 'REQ-GAP-85', 'R11', '', N_('Builds a road network from your own line layer, with one-way streets and speeds from its fields.')],
  ['route.shortest', N_('Shortest Route'), 'line', 'REQ-GAP-85', 'R11', '', N_('Click a start and an end: the fastest or shortest route on the road network.')],
  ['route.service', N_('Service Area…'), 'target', 'REQ-GAP-85', 'R11', '', N_('The roads reachable from a place within each travel time or distance you give.')],
  ['msi.endmembers', N_('Automatic Endmembers…'), 'bands', 'REQ-GAP-82', 'R10', '', N_('Finds the purest spectra in a hyperspectral image, pins them to the Spectral Plot, and can unmix the image with them.')],
  ['msi.library', N_('Spectral Library…'), 'list', 'REQ-MSI-13', 'R3'],
  ['msi.library.browse', N_('Library Browser…'), 'search', 'REQ-MSI-13', 'R3', '', N_('Find, rank (spectral angle) and pin imported library spectra.')],
  ['msi.thermal', N_('Brightness Temperature…'), 'sun', 'REQ-MSI-14', 'R3'],
  ['msi.xport', N_('Xport'), 'layout', 'REQ-MSI-15', 'R3', '', N_('Up to 16 linked panes with different presets and indices.')],
  ['msi.destripe', N_('Destripe'), 'filter', 'REQ-MSI-16', 'R3'],
  ['msi.change', N_('Spectral Change…'), 'swipe', 'REQ-MSI-16', 'R3'],
  // SAR (R3, Research/09)
  // Motion imagery (R3, Research/12)
  ['fmv.open', N_('Open Video…'), 'video', 'REQ-FMV-01', 'R3', '', N_('MPEG-TS with KLV, MPEG program streams (MPEG-1 and MPEG-2 play; the sidecar converts MPEG-2 the app cannot decode).')],
  ['fmv.close', N_('Close Video'), 'close', 'REQ-FMV-05', 'R3'],
  ['fmv.play', N_('Play / Pause'), 'play', 'REQ-FMV-08', 'R3', '', N_('Play or pause the video in the active panel.')],
  ['fmv.stepback', N_('Step Back'), 'play', 'REQ-FMV-08', 'R3', '', N_('One frame back (decoded exactly through WebCodecs).')],
  ['fmv.stepfwd', N_('Step Forward'), 'play', 'REQ-FMV-08', 'R3', '', N_('One frame forward (decoded exactly through WebCodecs).')],
  ['fmv.loop', N_('Loop A–B'), 'record', 'REQ-FMV-08', 'R3'],
  ['fmv.klv', N_('KLV Table'), 'table', 'REQ-FMV-02', 'R3', '', N_('Every item with its raw value, checksum status, LS version and unknown items.')],
  ['fmv.basis', N_('Time Basis…'), 'log', 'REQ-FMV-04', 'R3', '', N_('MISP Time (default) or legacy UTC, and a metadata time offset.')],
  ['fmv.hud', N_('HUD'), 'text', 'REQ-FMV-08', 'R3', '', N_('Show the head-up display; drag its blocks to move them.')],
  ['fmv.capture', N_('Capture Frame'), 'image', 'REQ-FMV-09', 'R3', '', N_('PNG + world file + JSON, and NITF 2.1 with IGEOLO and an RPC00B.')],
  ['fmv.event', N_('Event Log…'), 'bookmark', 'REQ-FMV-10', 'R3', '', N_('Log events at the current frame; they plot on the map.')],
  ['fmv.measure', N_('Measure on Video'), 'ruler', 'REQ-FMV-13', 'R3', '', N_('Click two points on a paused frame: distance from the KLV frame model.')],
  ['fmv.link', N_('Link Video Panels'), 'link', 'REQ-FMV-13', 'R3', '', N_('Other video panels follow the active clip by UTC.')],
  ['fmv.csv', N_('Import Metadata CSV…'), 'table', 'REQ-FMV-14', 'R3', '', N_('Platform metadata for video without KLV.')],
  ['fmv.export', N_('Export Clip (burn-in)…'), 'record', 'REQ-FMV-13', 'R3', '', N_('WebM with the HUD burned in.')],
  ['mie.play', N_('Play MIE4NITF Frames'), 'play', 'REQ-FMT-14', 'R3', '', N_('Play the time-stamped image segments of a MIE4NITF file in order.')],
  ['mie.next', N_('Next MIE4NITF Frame'), 'play', 'REQ-FMT-14', 'R3'],
  ['mie.prev', N_('Previous MIE4NITF Frame'), 'play', 'REQ-FMT-14', 'R3'],
  ['mie.chip', N_('WAMI Chip…'), 'image', 'REQ-GAP-47', 'R8', '', N_('Write a region of a frame range of a MIE4NITF sequence as a MIE4NITF file.')],
  ['mie.clearcache', N_('Clear Cached Motion Imagery'), 'close', 'REQ-GAP-47', 'R8', '', N_('Remove the MIE4NITF frame tiles the hosted copy keeps in its private browser storage.')],
  ['sar.metadata', N_('SAR Metadata'), 'radar', 'REQ-SAR-02', 'R3', '', N_('The SICD/SIDD summary card and XML tree.')],
  ['sar.cphd', N_('Phase History'), 'radar', 'REQ-FMT-49', 'R5', '', N_('The CPHD summary, per-vector parameter plots, support arrays and XML tree.')],
  ['sar.cphdsubset', N_('Save CPHD Subset'), 'save', 'REQ-FMT-51', 'R5', '', N_('Writes chosen channels, vectors and samples as a new CPHD file.')],
  ['sar.view', N_('View SAR'), 'radar', 'REQ-SAR-03', 'R3', '', N_('Magnitude, phase, I, Q, power and calibrated views.')],
  ['sar.remap', N_('SAR Remap'), 'lut', 'REQ-SAR-03', 'R3', '', N_('Density, Brighter, Darker, High-Contrast, Linear, Log, PEDF, NRL.')],
  ['sar.anamorphic', N_('Anamorphic Correction'), 'grid', 'REQ-SAR-04', 'R3', '', N_('Square the pixels (Col.SS/Row.SS).')],
  ['sar.ground', N_('Ground Plane'), 'terrain', 'REQ-SAR-04', 'R3', '', N_('Show the slant-plane image in a local ground plane.')],
  ['sar.shadows', N_('Shadows Down'), 'shadow', 'REQ-SAR-04', 'R3'],
  ['sar.northup', N_('North Up'), 'north', 'REQ-SAR-04', 'R3'],
  ['sar.overlay', N_('SAR Overlay'), 'arrow', 'REQ-SAR-04', 'R3', '', N_('North, layover, look and shadow arrows from SCPCOA.')],
  ['sar.speckle', N_('Speckle Filter…'), 'filter', 'REQ-SAR-07', 'R3'],
  ['sar.acd', N_('Amplitude Change…'), 'swipe', 'REQ-SAR-08', 'R3', '', N_('2CMV, log-ratio and change polygons.')],
  ['sar.ccd', N_('Coherent Change…'), 'radar', 'REQ-SAR-09', 'R3'],
  ['sar.pairs', N_('Pair Finder…'), 'search', 'REQ-SAR-10', 'R3'],
  ['sar.subap', N_('Sub-aperture Stack'), 'layers', 'REQ-SAR-11', 'R3'],
  ['sar.csi', N_('Colour Sub-aperture'), 'bands', 'REQ-SAR-11', 'R3'],
  ['sar.pauli', N_('Pauli Composite'), 'bands', 'REQ-SAR-13', 'R3'],
  ['sar.polsar', N_('Polarimetric Decomposition…'), 'bands', 'REQ-GAP-40', 'R8', '', N_('Freeman–Durden, Yamaguchi, Cloude–Pottier H/A/α and Wishart classes from quad-pol SICD or UAVSAR covariance; dual-pol and compact-pol H/α.')],
  // ---- 2.5 SAR stereo terrain (gap wave T0b, group sarstereo, REQ-GAP-42) ----
  ['sar.stereopairs', N_('Stereo Pair Finder…'), 'stereo', 'REQ-GAP-42', 'R8', '', N_('Ranks pairs of the open SICDs for radargrammetry: intersection angle, same or opposite side, look, incidence, days apart, overlap and height sensitivity.')],
  ['sar.stereodsm', N_('SAR Stereo DSM…'), 'terrain', 'REQ-GAP-42', 'R8', '', N_('A DSM from two SICDs: both images sampled on the ground through their models, speckle-aware matching about a prior DEM, layover and shadow masks, and a height and σ per post.')],
  ['sar.stereolevel', N_('Level DSM on Reference…'), 'terrain', 'REQ-GAP-91', 'R10', '', N_('Removes a SAR stereo DSM’s vertical offset, and optionally a tilt, against a reference DEM over stable terrain, and states the residual.')],
  ['sar.terrain', N_('Terrain Correction…'), 'terrain', 'REQ-GAP-90', 'R10', '', N_('Geocodes a Sentinel-1 image onto an elevation model by range-Doppler with its orbit, flattens it to γ⁰ by projected area, and masks layover and shadow.')],
  ['sar.stereoreport', N_('DSM Accuracy Report…'), 'report', 'REQ-GAP-42', 'R8', '', N_('Compares a DSM with a reference DEM: bias, NMAD, RMSE, LE90, completeness and the masked share, by slope, and how well the stated σ predicts the error.')],
  ['pc.header', N_('Header'), 'info', 'REQ-LDR-01', 'R2', '', N_('The LAS header, VLRs, CRS and class counts.')],
  ['pc.close', N_('Close 3D View'), 'close', 'REQ-LDR-04', 'R2'],
  ['pc.fit', N_('Fit Cloud'), 'whole', 'REQ-LDR-04', 'R2'],
  ['pc.colour.elevation', N_('Colour by Elevation'), 'terrain', 'REQ-LDR-05', 'R2'],
  ['pc.colour.intensity', N_('Colour by Intensity'), 'contrast', 'REQ-LDR-05', 'R2'],
  ['pc.colour.class', N_('Colour by Class'), 'layers', 'REQ-LDR-05', 'R2'],
  ['pc.colour.rgb', N_('Colour by RGB'), 'image', 'REQ-LDR-05', 'R2'],
  ['pc.colour.return', N_('Colour by Return'), 'bands', 'REQ-LDR-05', 'R2'],
  ['pc.colour.source', N_('Colour by Point Source'), 'symbol', 'REQ-LDR-05', 'R2'],
  ['pc.colour.time', N_('Colour by GPS Time'), 'log', 'REQ-LDR-05', 'R2'],
  ['pc.colour.hag', N_('Colour by Height Above Ground'), 'height', 'REQ-LDR-05', 'R2'],
  ['pc.classes', N_('Class Visibility'), 'list', 'REQ-LDR-05', 'R2', '', N_('Show or hide classes and edit their colours.')],
  ['pc.budget', N_('Point Budget'), 'gear', 'REQ-LDR-04', 'R2', '', N_('Points drawn per frame (default 3 M) and point size.')],
  ['pc.edl', N_('Eye-Dome Lighting'), 'sun', 'REQ-LDR-04', 'R2'],
  ['pc.shave', N_('Elevation Shaving'), 'filter', 'REQ-LDR-06', 'R2', '', N_('Hide points above or below a plane or a height above ground.')],
  ['pc.profile', N_('Profile / Cross-Section'), 'line', 'REQ-LDR-07', 'R2', '', N_('Points within a swath along a line, with a linked cursor and point-snapped measurement.')],
  ['pc.measure', N_('Measure 3D'), 'ruler', 'REQ-LDR-07', 'R2', '', N_('3D and horizontal distance, height difference and height above the DTM.')],
  ['pc.dsm', N_('DSM'), 'terrain', 'REQ-LDR-08', 'R2'],
  ['pc.dtm', N_('DTM'), 'terrain', 'REQ-LDR-08', 'R2'],
  ['pc.ndsm', N_('nDSM'), 'height', 'REQ-LDR-08', 'R2'],
  ['pc.intensity', N_('Intensity Image'), 'image', 'REQ-LDR-08', 'R2'],
  ['pc.density', N_('Density Image'), 'grid', 'REQ-LDR-08', 'R2'],
  ['pc.groundfilter', N_('Ground Filter'), 'wand', 'REQ-LDR-09', 'R2', '', N_('SMRF ground classification (undoable).')],
  ['pc.classedit', N_('Edit Classes'), 'polygon', 'REQ-LDR-09', 'R2', '', N_('Reclassify the points inside a polygon drawn on the view (undoable).')],
  ['pc.profileselect', N_('Select in Profile'), 'select', 'REQ-GAP-81', 'R10', '', N_('Draw a profile, then select points in it with a box or a lasso to reclassify, withhold or delete them.')],
  ['pc.withheld', N_('Set Withheld'), 'filter', 'REQ-GAP-81', 'R10', '', N_('Sets the LAS withheld flag on the points selected in the profile (undoable); grids and the ground filter leave them out.')],
  ['pc.delete', N_('Delete Points'), 'delete', 'REQ-GAP-81', 'R10', '', N_('Deletes the points selected in the profile (undoable); views, grids, clips and exports leave them out.')],
  ['pc.clip', N_('Clip Box/Polygon'), 'aoi', 'REQ-LDR-09', 'R2'],
  ['pc.colourise', N_('Colourise from Image'), 'image', 'REQ-LDR-10', 'R2'],
  ['pc.export', N_('Export LAS/LAZ/BPF'), 'save', 'REQ-LDR-10', 'R2', '', N_('LAS 1.4 (format 6 or 7, WGS 84 / UTM, optionally LAZ) or BPF v3 in any coordinate type.')],
  ['pc.assigncrs', N_('Assign CRS'), 'globe', 'REQ-FMT-47', 'R5', '', N_('Places a point cloud in the CRS you name: a BPF opened in a local frame (Cartesian or ENU), or a LAS or LAZ file read again.')],
  // Feature Tools
  ['ext.toolbox', N_('ToolBox'), 'toolbox', 'REQ-EXT-01', 'R1'],
  ['ext.repeat', N_('Repeat'), 'reset', 'REQ-EXT-01', 'R1'],
  ['ext.custom', N_('Custom Tools'), 'toolbox', 'REQ-EXT-03', 'R2'],
  ['ext.newschema', N_('New Layer from Schema…'), 'layers', 'REQ-EXT-10', 'R2', '', N_('A vector layer for a TDS 7.1 feature class, with its attributes, domains and nulls.')],
  ['ext.attributes', N_('Attributes…'), 'table', 'REQ-EXT-09', 'R2', '', N_('The schema form for the selected feature; can set the layer defaults (persistent attribution).')],
  ['ext.styles', N_('Style Sheet…'), 'theme', 'REQ-EXT-11', 'R2'],
  ['ext.fromdsm', N_('Buildings from DSM'), 'terrain', 'REQ-EXT-16', 'R2', '', N_('Extract buildings and trees from a DSM (nDSM, roughness, trace, simplify, square, heights).')],
  ['ext.wand', N_('Magic Wand'), 'wand', 'REQ-EXT-17', 'R2'],
  ['ext.edgetrace', N_('Edge Trace'), 'pen', 'REQ-EXT-17', 'R2'],
  ['ext.roadtrace', N_('Road Trace'), 'polyline', 'REQ-EXT-17', 'R2'],
  ['file.opengpkg', N_('Open GeoPackage or CSV…'), 'open', 'REQ-EXT-22', 'R2'],
  ['ext.vertices', N_('Edit Vertices'), 'pen', 'REQ-EXT-06', 'R1'],
  ['ext.split', N_('Split'), 'cut', 'REQ-EXT-06', 'R1'],
  ['ext.merge', N_('Merge'), 'layers', 'REQ-EXT-06', 'R1'],
  ['ext.reshape', N_('Reshape'), 'pen', 'REQ-EXT-06', 'R1'],
  ['ext.square', N_('Square'), 'rect', 'REQ-EXT-05', 'R1'],
  ['ext.droptoground', N_('Drop to Ground'), 'terrain', 'REQ-EXT-07', 'R2'],
  ['ext.attrtable', N_('Feature Attributes Table'), 'table', 'REQ-EXT-12', 'R1'],
  ['ext.attrsets', N_('Attribute Sets'), 'list', 'REQ-EXT-09', 'R2'],
  ['ext.query', N_('Feature Query…'), 'search', 'REQ-EXT-12', 'R1'],
  ['ext.validate', N_('Validate Now'), 'check', 'REQ-EXT-13', 'R2'],
  ['ext.results', N_('Validation Results'), 'list', 'REQ-EXT-13', 'R2'],
  ['ext.saveas', N_('Save As'), 'save', 'REQ-EXT-21', 'R1'],
  ['ext.arcgis', N_('Hand off to ArcGIS Pro'), 'send', 'REQ-EXT-24', 'R2'],
  ['ext.export3d', N_('3D Export'), 'model', 'REQ-EXT-25', 'R2'],
  ['ext.texture', N_('Texture Buildings…'), 'image', 'REQ-EXT-15', 'R3', '', N_('Texture building models from an ortho or oblique image through its sensor model.')],
  ['obs.toolbox', N_('Observation Toolbox'), 'observation', 'REQ-EXT-20', 'R3'],
  ['obs.table', N_('Observation Table'), 'table', 'REQ-EXT-20', 'R3'],
  ['det.import', N_('Import Detections…'), 'open', 'REQ-EXT-19', 'R3'],
  ['vec.remoteopen', N_('Edit Online Layer…'), 'network', 'REQ-EXT-26', 'R3', '', N_('Open an ArcGIS REST feature service layer or a WFS-T feature type for editing.')],
  ['vec.remotesave', N_('Save Online Edits'), 'save', 'REQ-EXT-26', 'R3', '', N_('Send adds, updates and deletes to the service (applyEdits or a WFS Transaction).')],
  ['det.review', N_('Review Queue'), 'list', 'REQ-EXT-19', 'R3'],
  // GIS Workbench 2.4 (gap wave T0a, group svc): online services and publishing.
  ['svc.connect', N_('Online Services…'), 'network', 'REQ-GAP-06', 'R8', '', N_('Connect to a WMS, WMTS, ArcGIS REST, OGC API, WCS, WPS or SensorThings service and use its layers.')],
  ['online.identify', N_('Identify Online Map'), 'info', 'REQ-GAP-05', 'R8', '', N_('Click the Map view to see what the active WMS or ArcGIS source has at that point.')],
  ['svc.publish', N_('Publish to a Service…'), 'network', 'REQ-GAP-59', 'R8', '', N_('Send accepted detections or observations to a FeatureServer, WFS-T or OGC API Features service.')],
  ['det.publish', N_('Publish Accepted Detections…'), 'network', 'REQ-GAP-59', 'R8', '', N_('Send the accepted detections to a FeatureServer, WFS-T or OGC API Features service.')],
  ['obs.publish', N_('Publish Observations…'), 'network', 'REQ-GAP-59', 'R8', '', N_('Send the observations to a FeatureServer, WFS-T or OGC API Features service.')],
  // GIS Workbench 2.0 (release R4): modern shell.
  ['ui.palette', N_('Command Palette…'), 'search', 'REQ-SHL-05', 'R4', 'Mod+K', N_('Find and run any command, or type a coordinate to fly there.')],
  ['win.workspace', N_('Workspace Window'), 'window', 'REQ-SHL-02', 'R4', '', N_('Show or hide the Workspace window: data tree, map view and preview.')],
  ['ui.layout', N_('Interface Layout'), 'layout', 'REQ-SHL-01', 'R4', '', N_('Switches between Modern (clean canvas) and Classic (Ribbon, open docks, as in 1.x).')],
  ['theme.m3light', N_('Light'), 'theme', 'REQ-SHL-13', 'R4', '', N_('Material light theme.')],
  ['theme.m3dark', N_('Dark (Material)'), 'theme', 'REQ-SHL-13', 'R4', '', N_('Material dark theme.')],
  ['hud.radial', N_('Radial Menu'), 'more', 'REQ-SHL-10', 'R4', 'Space', N_('Opens a ring of tools at the cursor: tap Space, drag with the right button, or press `.')],
  ['hud.pill', N_('Contextual Tools'), 'toolbox', 'REQ-SHL-08', 'R4', '', N_('Shows or hides the floating bar of tools for what is selected.')],
  ['hud.flicker', N_('Hold to Flicker'), 'flicker', 'REQ-SHL-11', 'R4', 'F (hold)', N_('Hold F over the panel to see the image underneath; release to come back.')],
  ['hud.quickchip', N_('Quick Chip'), 'chip', 'REQ-SHL-11', 'R4', 'C + drag', N_('Drag a box with C held: a full-resolution chip with its caption goes to the clipboard and the session deck.')],
  ['deck.export', N_('Export Session Deck…'), 'report', 'REQ-SHL-11', 'R4', '', N_('Saves every quick chip of this session as PowerPoint slides.')],
  ['deck.clear', N_('Empty Session Deck'), 'delete', 'REQ-SHL-11', 'R4', '', N_('Removes the quick chips collected so far.')],
  ['patrol.next', N_('Next Item'), 'jump', 'REQ-SHL-11', 'R4', 'J', N_('Centres the next marker, detection or observation at the current zoom.')],
  ['patrol.prev', N_('Previous Item'), 'jump', 'REQ-SHL-11', 'R4', 'K', N_('Centres the previous marker, detection or observation at the current zoom.')],
  ['triage.clear', N_('Triage: Clear'), 'check', 'REQ-SHL-11', 'R4', '1', N_('Marks the current item as clear (nothing there).')],
  ['triage.active', N_('Triage: Active'), 'target', 'REQ-SHL-11', 'R4', '2', N_('Marks the current item as active.')],
  ['triage.flag', N_('Triage: Flag'), 'marker', 'REQ-SHL-11', 'R4', '3', N_('Flags the current item for a closer look.')],
  ['net.toggle', N_('Online'), 'network', 'REQ-NET-02', 'R4', '', N_('Switches between Online (basemaps, cloud catalogs) and Offline (no request leaves this computer).')],
  ['bm.basemap', N_('Basemap'), 'globe', 'REQ-NET-04', 'R4', '', N_('Chooses the map shown under and around georeferenced imagery.')],
  ['file.openurl', N_('Open from URL…'), 'network', 'REQ-CON-03', 'R4', '', N_('Opens imagery from an https, s3:// or gs:// address by range: only what is shown is read.')],
  ['cat.panel', N_('Catalog'), 'list', 'REQ-CON-06', 'R4', '', N_('Shows the Catalog: open a URL, search STAC catalogues, browse buckets and local folders.')],
  ['cat.folder', N_('Add Folder…'), 'open', 'REQ-CON-02', 'R4', '', N_('Catalogues a folder on this computer and watches it for new files while the app is open.')],
  ['cat.s3keys', N_('Connect a Bucket…'), 'network', 'REQ-CON-04', 'R4', '', N_('Keys for a private S3, MinIO or GCS bucket, held in memory for this session only.')],
  ['cnv.open', N_('Convert…'), 'save', 'REQ-CNV-02', 'R4', '', N_('One drop zone: vectors to GeoJSON or GeoParquet, rasters to Cloud-Optimized GeoTIFF.')],
  ['cnv.cog', N_('Make Cloud-Optimized Copy'), 'save', 'REQ-CNV-01', 'R4', '', N_('Writes the active image as a Cloud-Optimized GeoTIFF: tiled, compressed, with overviews.')],
  ['cnv.saveimage', N_('Save Image As…'), 'save', 'REQ-FMT-25', 'R5', '', N_('Writes the active image as a Cloud-Optimized GeoTIFF, an ERDAS Imagine .img or a NetCDF-3 file.')],
  ['cnv.hfa', N_('Save as ERDAS Imagine'), 'save', 'REQ-FMT-25', 'R5', '', N_('Writes the active image as an ERDAS Imagine .img with map information, statistics and overviews.')],
  ['cnv.nc3', N_('Save as NetCDF-3'), 'save', 'REQ-FMT-27', 'R5', '', N_('Writes the active image as a CF-1.8 NetCDF-3 file with its grid mapping and coordinates.')],
  ['glb.toggle', N_('2D / 3D'), 'globe', 'REQ-GLB-02', 'R4', '', N_('Turns the view into an oblique 3D scene of the same place, and back.')],
  ['bm.pmtiles', N_('Open Tile Basemap…'), 'open', 'REQ-NET-05', 'R4', '', N_('Uses a PMTiles or MBTiles file on this computer (raster or vector) as the basemap; it works offline.')],
  // ---- 2.1 tile sets (FC-05..07) ----
  ['vt.extract', N_('Extract Tile Features…'), 'layers', 'REQ-FMT-32', 'R5', '', N_('Copies the features of the vector tiles (view, AOI or whole set) to ordinary vector layers.')],
  ['vt.identify', N_('Identify Tile Features'), 'search', 'REQ-FMT-32', 'R5', '', N_('Click a place: lists the vector-tile features there with their attributes.')],
  ['vt.basemap', N_('Use Tile Set as Basemap'), 'globe', 'REQ-FMT-28', 'R5', '', N_('Puts the active MBTiles or PMTiles layer under other imagery as a basemap.')],
  ['tiles.save', N_('Save As Tiles…'), 'save', 'REQ-FMT-31', 'R5', '', N_('Writes the active image or tile set as PMTiles or MBTiles (Web Mercator tiles over a zoom range).')],
  ['tiles.mvt', N_('Save As Vector Tiles…'), 'save', 'REQ-FMT-33', 'R5', '', N_('Tiles a vector layer to Mapbox Vector Tiles in PMTiles or MBTiles, simplified per zoom.')],
  // ---- 2.0 local AI (P5) ----
  ['lai.find', N_('Find Objects (AI)…'), 'search', 'REQ-LAI-03', 'R4', '', N_('Finds the objects you name (aircraft, vehicle…) in the view on this device; they go to the detections review queue.')],
  ['lai.search', N_('Search Imagery (AI)…'), 'search', 'REQ-LAI-06', 'R4', '', N_('Describe what you are looking for; the places in the image that look most like it are outlined and centred.')],
  ['lai.contrast', N_('Auto Contrast'), 'contrast', 'REQ-LAI-07', 'R4', '', N_('Sets local contrast and brightness for this image automatically; Undo restores the previous look.')],
  ['lai.square', N_('Square Corners'), 'wand', 'REQ-LAI-02', 'R4', '', N_('Smart Select outlines of buildings and other man-made objects get right-angled corners.')],
  ['lai.device', N_('AI Device…'), 'ai', 'REQ-LAI-01', 'R4', '', N_('Shows whether the local models run on the graphics card (WebGPU) or the CPU, and which model packs are loaded.')],
  ['align.ai', N_('Auto Align (AI)'), 'align', 'REQ-LAI-05', 'R4', '', N_('Lines up the active image with the reference by matching learned keypoints; works across dates and sensors.')],
  // ---- 2.0 recipes (P6) ----
  ['rcp.open', N_('Recipes'), 'template', 'REQ-PIP-02', 'R4', '', N_('Shows the recipe stepper: run a workflow step by step, change a step and re-run from there.')],
  ['rcp.import', N_('Open Recipe…'), 'open', 'REQ-PIP-01', 'R4', '', N_('Opens a .gwrecipe.json file and keeps it in your recipe library.')],
  ['pip.builder', N_('Workflow Builder'), 'list', 'REQ-GAP-84', 'R10', '', N_('Wires steps into a workflow, output to input; saves it in the project and your library, and runs it again on new inputs.')],
  ['rcp.airfield-triage', N_('Airfield Triage'), 'list', 'REQ-PIP-04', 'R4', '', N_('Runs the recipe: auto contrast, find aircraft, your review, a chip deck and a GeoJSON of the accepted ones.')],
  ['rcp.damage-triage', N_('Damage Triage'), 'list', 'REQ-PIP-04', 'R4', '', N_('Runs the recipe: align the post-event image, find damage, your review, GeoJSON.')],
  ['rcp.folder-to-cog', N_('Convert a Folder to COG'), 'list', 'REQ-PIP-04', 'R4', '', N_('Runs the recipe: every raster in a folder becomes a Cloud-Optimized GeoTIFF.')],
  ['rcp.building-extraction', N_('Building Extraction'), 'list', 'REQ-PIP-04', 'R4', '', N_('Runs the recipe: find buildings, outline and square each one, your review, GeoJSON.')],
  // ---- 2.0 hub bridges (P7) ----
  ['hub.psd', N_('Photoshop (PSD)…'), 'save', 'REQ-HUB-01', 'R4', '', N_('Saves the view as a Photoshop file: the image plus Levels and Curves layers that rebuild its look, and the graphics.')],
  ['hub.tiff16', N_('16-bit TIFF + Curves…'), 'save', 'REQ-HUB-01', 'R4', '', N_('Saves the view as a 16-bit GeoTIFF and a Photoshop Curves preset that gives it the same look.')],
  ['hub.pdf', N_('Illustrator (Layered PDF)…'), 'save', 'REQ-HUB-02', 'R4', '', N_('Saves the view as a PDF whose layers (imagery, graphics, vectors, neatline, scale bar) Illustrator opens as layers.')],
  ['hub.svg', N_('Layered SVG…'), 'save', 'REQ-HUB-02', 'R4', '', N_('Saves the view as an SVG with the imagery and each vector layer as its own layer.')],
  ['hub.glb', N_('3D Terrain (GLB)…'), 'save', 'REQ-HUB-03', 'R4', '', N_('Saves the ground in view as a textured 3D mesh for Blender or Unreal.')],
  ['hub.usdz', N_('3D Terrain (USDZ)…'), 'save', 'REQ-HUB-03', 'R4', '', N_('Saves the ground in view as a textured 3D model that iPhone and iPad open in AR Quick Look.')],
  ['hub.relay', N_('Send to Google Sheet…'), 'network', 'REQ-HUB-06', 'R4', '', N_('Appends markers, observations and accepted detections to a Google Sheet through your own Apps Script relay (experimental).')],
  // ---- 2.1 optional sidecar (P12, app/src/sidecar) ----
  ['sidecar.status', N_('Sidecar…'), 'network', 'REQ-HOST-10', 'R5', '', N_('Shows whether a local sidecar is running and paired; pair it, forget it or switch it off.')],
  ['sidecar.convert', N_('Convert with Sidecar'), 'save', 'REQ-SDC-08', 'R5', '', N_('Converts files this app cannot read into formats it reads, with the optional local sidecar.')],
  ['sidecar.convertdialog', N_('Convert with Sidecar…'), 'save', 'REQ-SDC-09', 'R5', '', N_("Identifies a file with the sidecar's GDAL, PDAL or FFmpeg and converts it into a format the app reads.")],
  ['sidecar.pick', N_('Pick in Sidecar…'), 'open', 'REQ-SDC-07', 'R5', '', N_("Chooses a large file in the sidecar's own dialog; it is read where it is, without a copy.")],
  ['sidecar.view', N_('View with Sidecar…'), 'open', 'REQ-GAP-70', 'R8', '', N_('Shows the pixels of a MrSID or ECW file by tiles the sidecar decodes as you pan, with nothing converted.')],
  ['sidecar.batch', N_('Convert a Folder with Sidecar…'), 'list', 'REQ-SDC-08', 'R5', '', N_('Converts every matching file of a folder, or mosaics a multi-file MrSID delivery into one COG.')],
  ['sidecar.jobs', N_('Sidecar Jobs'), 'job', 'REQ-SDC-06', 'R5', '', N_('Shows sidecar conversions: queue, progress, log, cancel, retry and open the result.')],
  ['sidecar.saveas', N_('Save As with GDAL/OGR…'), 'saveas', 'REQ-SDC-10', 'R5', '', N_("Saves a file in any format the sidecar's GDAL or OGR can write, with checked creation options.")],
  ['sidecar.pair', N_('Pair with Sidecar'), 'link', 'REQ-SDC-03', 'R5', '', N_('Pairs this page with the sidecar: the same six digits appear here and in the sidecar window.')],
  ['sidecar.forget', N_('Forget Sidecar'), 'unlink', 'REQ-SDC-03', 'R5', '', N_("Revokes this page's sidecar token, here and in the sidecar.")],
  ['sidecar.toggle', N_('Use the Sidecar'), 'network', 'REQ-SDC-14', 'R5', '', N_('Allows or stops calls to the local sidecar (127.0.0.1 only; they work while Offline and are logged).')],
  ['sidecar.relay', N_('Python Relay…'), 'link', 'REQ-GAP-02', 'R8', '', N_('Lets a paired Python script use this page through the sidecar; everything it changes waits in Proposals.')],
  ['sidecar.stereoviewer', N_('Native Stereo Viewer…'), 'stereo', 'REQ-GAP-33', 'R8', '', N_('Shows a stereo pair in a native window fed by the sidecar, with quad-buffer stereo on a display that has it.')],
  ['sidecar.prosync', N_('Sync with ArcGIS Pro…'), 'link', 'REQ-GAP-65', 'R8', '', N_('Keeps the view and cursor of this page and of ArcGIS Pro together, through the sidecar and an add-in.')],
  ['sidecar.corsrelay', N_('CORS Relay…'), 'network', 'REQ-GAP-08', 'R8', '', N_('Reads an origin with no CORS headers through the sidecar. Off until the sidecar is signed and reviewed.')],
  // ---- 2.6 gdalroutes (gap wave T3) ----
  ['sidecar.pansharpen', N_('Pan-Sharpen with Sidecar…'), 'sharpen', 'REQ-GAP-15', 'R8', '', N_('Fuses a panchromatic band and spectral bands by weighted Brovey in GDAL, for scenes too large for the browser.')],
  ['sidecar.reproject', N_('Reproject with Sidecar…'), 'globe', 'REQ-GAP-17', 'R8', '', N_('Reprojects a raster of any size with GDAL and every PROJ grid, and refuses rather than fall back when a grid is missing.')],
  ['sidecar.gdbcatalog', N_('Catalogue from FileGDB…'), 'list', 'REQ-GAP-54', 'R8', '', N_("Reads a File Geodatabase's domains and subtypes and imports them as a feature catalogue.")],
  ['sidecar.sfm', N_('Structure from Motion with Sidecar…'), 'globe', 'REQ-GAP-29', 'R8', '', N_('Orients a folder of UAV photographs and makes a dense cloud, a DSM and an orthomosaic on this computer.')],
  ['sidecar.sfmcontrol', N_('Structure from Motion with Ground Control…'), 'globe', 'REQ-GAP-94', 'R8', '', N_('Places a UAV block on surveyed ground control points marked in its photographs, then makes a dense cloud, a DSM and an orthomosaic.')],
  ['sidecar.modelexport', N_('Export 3D Model with Sidecar…'), 'save', 'REQ-GAP-36', 'R8', '', N_('Writes a 3D model as Esri multipatch, FBX or IFC through the sidecar.')],
  // ---- 2.4 imaging (REQ-GAP-14, REQ-GAP-34) ----
  ['enh.pansharpenproduct', N_('Pan-Sharpened Product…'), 'sharpen', 'REQ-GAP-14', 'R8', '', N_('Fuses the pan and multispectral images at the pan resolution and bit depth into a Cloud-Optimized GeoTIFF, with ERGAS, SAM and Q4.')],
  ['hub.dae', N_('3D Terrain (COLLADA)…'), 'save', 'REQ-GAP-34', 'R8', '', N_('Saves the ground in view as a textured COLLADA model (with its texture image) for SketchUp, Blender or 3ds Max.')],
  ['hub.kmz3d', N_('3D Terrain (KMZ)…'), 'save', 'REQ-GAP-34', 'R8', '', N_('Saves the ground in view as a KMZ whose textured COLLADA model Google Earth places at its true position and height.')],
  ['hub.stl', N_('3D Terrain (STL)…'), 'save', 'REQ-GAP-34', 'R8', '', N_('Saves the ground in view as an STL mesh in local metres, for 3D printing.')],
  ['hub.ply', N_('3D Terrain (PLY)…'), 'save', 'REQ-GAP-34', 'R8', '', N_('Saves the ground in view as a PLY mesh with texture coordinates, and its texture image.')],
  // 2.4 auth (REQ-GAP-09, REQ-GAP-10)
  ['net.signin', N_('Sign-In for Data Origins…'), 'network', 'REQ-GAP-10', 'R8', '', N_('Per origin: sign in with OpenID Connect, or mark it "use my sign-in" for your certificate and single sign-on.')],
  // ---- 2.4 feature catalogues and local AI (gap wave T0a, group extai) ----
  ['ext.importcatalog', N_('Import Feature Catalogue…'), 'open', 'REQ-GAP-52', 'R8', '', N_('Reads your feature catalogue (ISO 19110, an INSPIRE schema with code lists, OpenStreetMap presets or gw-catalog/1) for New Layer from Schema.')],
  ['ext.catalogs', N_('Feature Catalogues…'), 'list', 'REQ-GAP-53', 'R8', '', N_('Lists the feature catalogues: built in, from data packs and imported; removes the ones you imported.')],
  ['lai.findscene', N_('Find Objects in Whole Scene (AI)…'), 'search', 'REQ-GAP-56', 'R8', '', N_('Finds the objects you name over the whole image as a background job on this device; they go to the detections review queue.')],
  ['lai.describe', N_('Draft Observation (AI)…'), 'observation', 'REQ-LAI-04', 'R8', '', N_('Moondream2 on this device drafts an observation or a count for the AOI or the view; the draft is a proposal labelled AI-drafted, with no measurements.')],
  ['lai.changemask', N_('Change Mask'), 'flicker', 'REQ-LAI-05', 'R8', '', N_('After Auto Align (AI), marks where the aligned image differs from the reference; the changes go to the change list.')],
  ['lai.models', N_('AI Models…'), 'ai', 'REQ-GAP-57', 'R8', '', N_('Lists the detection, segmentation and land-cover models and runs one on the view; adds your own ONNX model with its descriptor (hash and licence checked).')],
  ['lai.landcover', N_('Land Cover (AI)'), 'layers', 'REQ-GAP-57', 'R8', '', N_('Classifies the view into eight land-cover classes on this device and opens the class map as a layer.')],
  ['lai.benchmark', N_('Time the AI Encoder'), 'ai', 'REQ-GAP-56', 'R8', '', N_('Times the SAM 2.1 image encoder on this device (graphics card or CPU) on one 1024-pixel window of the active image.')],
  // ---- 2.4 GeoPDF (gap wave T0a, group geopdf, REQ-GAP-66) ----
  // ---- 2.5 vendor rigorous models (gap wave T0b, group vendor, REQ-GAP-20) ----
  ['model.vendor', N_('Load Vendor Model…'), 'model', 'REQ-GAP-20', 'R8', '', N_('Adds the rigorous model of DigitalGlobe .IMD/.EPH/.ATT/.GEO files, or the line of sight of a Landsat ANG or Sentinel-2 MTD_TL file, to the active image beside its RPC or map model.')],
  ['file.geopdf', N_('GeoPDF Map…'), 'pdf', 'REQ-GAP-66', 'R8', '', N_('Saves the view as a GeoPDF map in a projected CRS, with a main and an overview frame, each vector layer as a layer with its attributes, and text in any script.')],
  // ---- 2.5 field tools (OD-2.23, group mobile): in Full and in Lite (data/lite-commands.json) ----
  ['geo.locate', N_('My Location'), 'target', 'REQ-HOST-05', 'R9', '', N_("Shows where this device is (with your permission), on the image when it covers the place; tap again to stop.")],
  ['obs.field', N_('Field Observation…'), 'observation', 'REQ-HOST-05', 'R9', '', N_('Adds an observation at a place (the view centre, a point you pressed or your location), with photos from the camera or the device.')],
  ['obs.export', N_('Export Observations…'), 'save', 'REQ-HOST-05', 'R9', '', N_('Saves or shares the observations, with their photos, and the AOI, GRG and annotations, as KML, KMZ or GeoJSON.')],
  ['model.csm', N_('Attach CSM ISD…'), 'model', 'REQ-GAP-24', 'R8', '', N_('Gives the active image a USGS CSM sensor model (frame, line scanner, push frame or SAR) from its usgscsm ISD file, computed by usgscsm in this page.')],
  ['model.ossim', N_('Load OSSIM Rigorous Model…'), 'model', 'REQ-GAP-21', 'R8', '', N_("Samples OSSIM's rigorous model of a sensor through the sidecar and fits an RPC to it for the active image.")],
  // ---- 2.5 LiDAR registration (gap wave T0b, group lidarreg, REQ-GAP-46) ----
  ['pc.registerimage', N_('Register Image to LiDAR…'), 'align', 'REQ-GAP-46', 'R8', '', N_('Matches an image with the point cloud’s intensity and hillshade, makes control from the cloud and solves the image correction with an optional datum shift of the cloud.')],
  // ---- 2.5 aerial triangulation (gap wave T0b, group aero, REQ-GAP-22) ----
  ['tri.aero', N_('Aerial Triangulation…'), 'model', 'REQ-GAP-22', 'R8', '', N_('Bundle adjustment of frame images: positions, attitudes and the camera calibration, from tie points, GCPs and GNSS/IMU data, with σ and correlations.')],
  ['tri.resect', N_('Space Resection…'), 'model', 'REQ-GAP-22', 'R8', '', N_('Position and attitude of the active frame image from four or more control points measured in it.')],
  ['tri.fiducials', N_('Film Interior Orientation…'), 'image', 'REQ-GAP-22', 'R8', '', N_('Fits the scan of a film image to its fiducial marks from the camera calibration report.')],
  // ---- 2.5 models3d (gap wave T0b, REQ-GAP-35, REQ-GAP-68) ----
  ['3d.slpk', N_('Open Scene Layer Package…'), 'model', 'REQ-GAP-35', 'R8', '', N_('Opens an I3S scene layer package (3D objects, integrated mesh, points, building) in the 3D view, streamed by level of detail.')],
  ['3d.i3s', N_('Add I3S Scene Layer…'), 'model', 'REQ-GAP-35', 'R8', '', N_('Adds an I3S scene service layer (3D objects, integrated mesh or points) from an allowed origin to the 3D view.')],
  ['3d.i3sidentify', N_('Identify Scene Layer Feature'), 'info', 'REQ-GAP-35', 'R8', '', N_('Click a building or mesh of an I3S layer in the 3D view to see its attributes.')],
  ['3d.pdf', N_('3D PDF…'), 'pdf', 'REQ-GAP-68', 'R8', '', N_('Saves the terrain, models and scene layers of the 3D view as a PDF with a 3D (PRC) model and a default view.')],
  ['hub.slpk', N_('3D Terrain (SLPK)…'), 'save', 'REQ-GAP-35', 'R8', '', N_('Saves the ground in view as a textured I3S scene layer package for ArcGIS Pro and ArcGIS Online.')],
  ['hub.flt', N_('3D Terrain (OpenFlight)…'), 'save', 'REQ-GAP-35', 'R8', '', N_('Saves the ground in view as an OpenFlight database (.flt) with its texture image, for simulation image generators.')],
  // ---- 2.5 aviation (gap wave T0b, group aviation, SDP-2.3 GR-27) ----
  ['los.airports', N_('Airports and Runways…'), 'terrain', 'REQ-GAP-73', 'R8', '', N_('Airports and their runway ends, imported from the FAA NASR files or entered and drawn by hand, for the obstruction surfaces.')],
  ['los.obstruction', N_('Obstruction Surfaces…'), 'terrain', 'REQ-GAP-73', 'R8', '', N_('Builds the FAA Part 77 or ICAO Annex 14 surfaces of an airport, with the obstacle-free zone of a precision runway, and lists the DSM posts or cloud points that penetrate them.')],
  ['gps.flightplan', N_('Flight Plan…'), 'polyline', 'REQ-GAP-74', 'R8', '', N_('Altitude and speed per leg of a route, its distances, courses and times, the altitude profile against the terrain with clearance warnings, and KML and GPX export.')],
  // ---- 2.5 streams (gap wave T0b, group streams: REQ-GAP-49 HLS, REQ-GAP-64 ArcGIS portals) ----
  ['fmv.hls', N_('Open HLS Stream…'), 'video', 'REQ-GAP-49', 'R8', '', N_('Plays a live or on-demand HLS stream with MISB KLV from an allowed origin, with the map, footprints and HUD in sync like a video file.')],
  ['net.portal', N_('ArcGIS Portal…'), 'network', 'REQ-GAP-64', 'R8', '', N_('Signs in to ArcGIS Online or ArcGIS Enterprise, searches the portal and opens feature, map and image services and web maps.')],
  ['vec.attachments', N_('Attachments…'), 'pin', 'REQ-GAP-64', 'R8', '', N_('Lists, opens, adds and deletes the attachments of the selected feature of an ArcGIS feature layer.')],
  ['vec.related', N_('Related Records…'), 'table', 'REQ-GAP-64', 'R8', '', N_('Shows and edits the records related to the selected feature of an ArcGIS feature layer, with the related table’s field checks.')],
  ['vec.versions', N_('Branch Versions…'), 'layers', 'REQ-GAP-64', 'R8', '', N_('Lists the branch versions of an ArcGIS feature service, reads or edits one, saves the edits and reconciles and posts them.')],
  ['vec.buffer', N_('Buffer…'), 'polygon', 'REQ-GAP-79', 'R10', '', N_('Draws the area within a distance of every feature of a layer, geodesic or planar, with round, flat or square line ends.')],
  ['vec.overlay', N_('Overlay…'), 'layers', 'REQ-GAP-79', 'R10', '', N_('Intersects, unions, erases or takes the symmetric difference of two polygon layers, keeping both layers’ attributes.')],
  ['vec.dissolve', N_('Dissolve…'), 'polygon', 'REQ-GAP-79', 'R10', '', N_('Merges the polygons of a layer that share a value, or all of them, into one feature each.')],
  ['vec.join', N_('Spatial Join…'), 'table', 'REQ-GAP-79', 'R10', '', N_('Adds to each feature the count and the sum, mean, minimum and maximum of another layer’s features it touches, lies in, contains or is nearest to.')],
  ['vec.lyrx', N_('Apply Layer File Style (.lyrx)…'), 'symbol', 'REQ-GAP-64', 'R8', '', N_('Reads the symbology of an ArcGIS Pro layer file into the active vector layer’s style and lists what could not be applied.')],
];


export class Commands extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.map = new Map();
    // The build's profile (OD-2.23): every command carries the profiles it belongs to (core/profile.js).
    this.profile = buildProfile(app?.gw);
    for (const [id, label, ic, req, rel, key, tip] of CATALOG) this.map.set(id, { id, label, icon: ic, req, rel, key: key || '', tip: tip || '', implemented: false, profiles: profilesOf(id) });
  }

  /** The profiles command `id` belongs to: ['full'] (Full only, the default) or ['full', 'lite']. */
  profilesOf(id) {
    return profilesOf(id);
  }

  /** Whether command `id` is in this build's profile. */
  inBuild(id) {
    return inProfile(id, this.profile);
  }

  get(id) {
    return this.map.get(id);
  }

  list() {
    return [...this.map.values()];
  }

  /** A command's label in the UI language (the id when it is not catalogued). */
  labelOf(id) {
    const c = this.map.get(id);
    return (c && tr(c.label)) || id;
  }

  /** A command's own tip in the UI language ('' when it has none). */
  tipOf(id) {
    return tr(this.map.get(id)?.tip) || '';
  }

  define(spec) {
    const prev = this.map.get(spec.id) ?? {};
    this.map.set(spec.id, { ...prev, ...spec, implemented: !!spec.run || prev.implemented, profiles: profilesOf(spec.id) });
    this.emit('change', spec.id);
  }

  /** Attach behaviour to a catalogued command. */
  implement(id, impl) {
    const c = this.map.get(id);
    if (!c) throw new Error(`unknown command ${id}`);
    Object.assign(c, impl, { implemented: !!impl.run });
    this.emit('change', id);
  }

  /** In the Lite file: why a command cannot run here (it is Full only, OD-2.23), else null. */
  liteGap(id) {
    if (this.profile !== 'lite' || inProfile(id, 'lite')) return null;
    return t('{cmd} is in the Full edition only: open GIS Workbench (Full) on a desktop computer.', { cmd: this.labelOf(id) });
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
    // In Lite a Full-only command says so, whether or not this build implements it (OD-2.23).
    const gap = this.liteGap(id);
    if (gap) return this.app.toast(gap, { kind: 'info', ms: 6000 });
    if (!c.run) {
      this.app.toast(t('{cmd} is planned for {rel} ({req}).', { cmd: this.labelOf(id), rel: c.rel, req: c.req }), { kind: 'info' });
      return;
    }
    if (!this.enabled(id)) return;
    try {
      return await c.run(args);
    } catch (e) {
      // e.message is the English text (gwError keeps it English); msgOf(e) is what the user reads.
      const english = String(e?.message || e);
      const msg = msgOf(e) || english;
      const label = this.labelOf(id);
      // "Do this first" refusals are guidance, not failures (GUI-018, GUI-019): an error with the
      // code E_STEP_FIRST, or one whose English text STEP_FIRST recognises (errors not given a code
      // yet). The test reads the English message, so it holds in every locale. The "Set up…"
      // action follows the code alone (L0).
      if (e?.code === 'E_STEP_FIRST' || e?.code === 'E_NO_AI_CONNECTION' || STEP_FIRST.test(english)) {
        const action = e?.code === 'E_NO_AI_CONNECTION' ? { label: t('Set up…'), run: () => this.run('ai.connections') } : undefined;
        this.app.toast(t('{cmd}: {msg}', { cmd: label, msg }), { kind: 'warn', ms: 6000, action });
        return;
      }
      console.error(e);
      this.app.toast(t('{cmd}: {msg}', { cmd: label, msg }), { kind: 'error', ms: 6000 });
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
