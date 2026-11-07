// 2.5 streams group (gap wave T0b): HLS streams with MISB KLV (REQ-GAP-49) and ArcGIS portals
// (REQ-GAP-64: sign-in, items, attachments, related records, branch versions, .lyrx styles).
// The commands stay here; their implementation is in two lazy app blocks, js-streams
// (features/hls-player.js) and js-portal (features/portal-ui.js), loaded on first use.

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';

export const name = 'streams';

export function install(app) {
  const S = app.store;
  const hls = once(async () => (await loadBlock(app, 'js-streams')).installHls(app));
  lazyCommands(app, ['fmv.hls'], hls);
  app.streams = { sessions: new Set() };
  lazyMethods(app.streams, ['open', 'dialog'], hls, () => app.streams);

  const portal = once(async () => (await loadBlock(app, 'js-portal')).installPortal(app));
  const arcLayers = () => S.all('vlayer').filter((v) => v.source?.format === 'arcgis-fs');
  const selectedArc = () => [...(app.selection ?? [])].some((id) => {
    const f = S.get(id);
    return f?.type === 'feature' && S.get(f.vlayer)?.source?.format === 'arcgis-fs' && f.remoteId !== undefined && f.remoteId !== null;
  });
  lazyCommands(app, ['net.portal', 'vec.attachments', 'vec.related', 'vec.versions', 'vec.lyrx'], portal, {
    'vec.attachments': { enabled: selectedArc },
    'vec.related': { enabled: selectedArc },
    'vec.versions': { enabled: () => arcLayers().length > 0 },
    'vec.lyrx': { enabled: () => S.all('vlayer').length > 0 },
  });
  app.portal = {};
  lazyMethods(app.portal, ['connect', 'search', 'openItem', 'openWebMap', 'attachments', 'addAttachment', 'deleteAttachments', 'attachmentBlob', 'related', 'saveRelated', 'versions', 'useVersion', 'saveVersion', 'reconcilePost', 'applyLyrx', 'signIn', 'trustServer'], portal, () => app.portal);
}
