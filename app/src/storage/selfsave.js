// Self-saving the tool file (REQ-ARC-16, REQ-AI-05): a meta CSP cannot be widened at
// runtime, so adding a network origin writes a new copy of this HTML with the origin in
// connect-src, and the user reloads it. The template is captured at boot, before the app
// touches the DOM; every hashed script stays byte-identical, so its CSP hash stays valid.

let template = null;

export function captureTemplate() {
  if (template) return;
  // outerHTML keeps script text verbatim; the app has not touched <body> yet. Since the app runs
  // from the js-app block (REG-166), capture happens after the whole file is parsed, so two things
  // a copy must not carry are in the tree: a snapshot's data (a tool copy saved from a snapshot
  // file would hold the whole project), and any <script src="blob:…"> still there (another
  // document's blob, refused when a copy loads it). Both come out of the template, for every user.
  const root = document.documentElement.cloneNode(true);
  root.querySelector('#gw-snapshot')?.remove();
  for (const s of root.querySelectorAll('script[src^="blob:"]')) s.remove();
  template = `<!DOCTYPE html>\n${root.outerHTML}`;
}

export function hasTemplate() {
  return !!template;
}

/** The tool file as captured at start-up, without an embedded snapshot (REQ-ARC-19). */
export function templateHtml() {
  if (!template) throw new Error('the file template was not captured at start-up');
  return template.replace(/<html([^>]*?) data-runmode="[^"]*"/, '<html$1');
}

/** The HTML with connect-src = "blob:" plus `origins` (each a validated origin). */
export function htmlWithOrigins(origins) {
  if (!template) throw new Error('the file template was not captured at start-up');
  let found = false;
  const out = template.replace(/(<meta[^>]*id="csp"[^>]*content=")([^"]*)(")/, (m, a, content, c) => {
    found = /connect-src/.test(content);
    // The sidecar's loopback origins (REQ-SDC-02) stay in every copy, whatever the user lists.
    const loopback = (/connect-src([^;]*)/.exec(content)?.[1] ?? '').trim().split(/\s+/).filter((s) => /^http:\/\/127\.0\.0\.1:4782[1-3]$/.test(s));
    const list = [...new Set(['blob:', ...origins, ...loopback])].join(' ');
    const next = content.replace(/connect-src[^;]*/, `connect-src ${list}`);
    return a + next + c;
  });
  // An unchanged list gives the same file: that is not a missing CSP (GUI-052).
  if (!found && origins.length) throw new Error('could not find the CSP in the file template');
  // Clear any data-theme/data-runmode attributes the app set on <html> before capture.
  return out.replace(/<html([^>]*?) data-runmode="[^"]*"/, '<html$1');
}
