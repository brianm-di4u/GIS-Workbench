// Developer static server for live GUI testing in a browser pane. Serves the folder above the
// repo (so dist/, fixtures/ and ../Research/samples are all reachable) byte for byte, plus a
// /__loader page without the app's CSP that hands fixture bytes to an open app tab over a
// BroadcastChannel (the app's connect-src only allows blob:).
//   node tests/tools/serve.mjs [--port 8765] [--root ..]
//   app:    http://127.0.0.1:8765/gis-workbench/dist/gis-workbench.html
//   loader: http://127.0.0.1:8765/__loader  → in it: load(['/gis-workbench/fixtures/fx01/x.ntf'])
//   app tab, once:  new BroadcastChannel('gw-test').onmessage = (e) =>
//     gisworkbench.openFiles(e.data.map((f) => new File([f.buf], f.name)));

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const port = Number(opt('--port', '8765'));
const root = resolve(opt('--root', '..'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const LOADER = `<!DOCTYPE html><html lang="en"><meta charset="utf-8"><title>GW test loader</title>
<body style="font:14px system-ui;padding:16px"><h1 style="font-size:18px">GIS Workbench test loader</h1>
<p>Call <code>load([url, …])</code> here; an app tab listening on BroadcastChannel "gw-test" opens the files.</p>
<pre id="log"></pre><script>
const ch = new BroadcastChannel('gw-test');
async function load(urls) {
  const files = [];
  for (const u of urls) {
    const r = await fetch(u);
    if (!r.ok) throw new Error(u + ': ' + r.status);
    files.push({ name: decodeURIComponent(u.split('/').pop()), buf: await r.arrayBuffer() });
  }
  ch.postMessage(files);
  document.getElementById('log').textContent += 'sent ' + files.map((f) => f.name + ' (' + f.buf.byteLength + ' B)').join(', ') + '\\n';
  return files.map((f) => f.name);
}
</script></body></html>`;

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__loader') {
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
    return res.end(LOADER);
  }
  const path = join(root, decodeURIComponent(url.pathname));
  if (path !== root && !path.startsWith(root + sep)) {
    res.writeHead(403);
    return res.end();
  }
  let st;
  try {
    st = statSync(path);
  } catch {
    res.writeHead(404);
    return res.end();
  }
  if (st.isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}/`));
