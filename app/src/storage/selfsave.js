// Self-saving the tool file (REQ-ARC-16, REQ-AI-05): a meta CSP cannot be widened at
// runtime, so adding a network origin writes a new copy of this HTML with the origin in
// connect-src, and the user reloads it. The template is captured at boot, before the app
// touches the DOM; every hashed script stays byte-identical, so its CSP hash stays valid.

let template = null;
let snapshotEl = null;

export function captureTemplate() {
  if (template) return;
  // outerHTML keeps script text verbatim; nothing has been added to <body> yet.
  template = `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
  // A snapshot's data element, removed later by its exact markup (the app's code mentions the tag).
  snapshotEl = document.getElementById('gw-snapshot')?.outerHTML ?? null;
}

export function hasTemplate() {
  return !!template;
}

/** The tool file as captured at start-up, without an embedded snapshot (REQ-ARC-19). */
export function templateHtml() {
  if (!template) throw new Error('the file template was not captured at start-up');
  let t = template;
  if (snapshotEl) {
    const i = t.lastIndexOf(snapshotEl);
    if (i >= 0) t = t.slice(0, i) + t.slice(i + snapshotEl.length);
  }
  return t.replace(/<html([^>]*?) data-runmode="[^"]*"/, '<html$1');
}

/** The HTML with connect-src = "blob:" plus `origins` (each a validated origin). */
export function htmlWithOrigins(origins) {
  if (!template) throw new Error('the file template was not captured at start-up');
  const list = ['blob:', ...origins].join(' ');
  let found = false;
  const out = template.replace(/(<meta[^>]*id="csp"[^>]*content=")([^"]*)(")/, (m, a, content, c) => {
    found = /connect-src/.test(content);
    const next = content.replace(/connect-src[^;]*/, `connect-src ${list}`);
    return a + next + c;
  });
  // An unchanged list gives the same file: that is not a missing CSP (GUI-052).
  if (!found && origins.length) throw new Error('could not find the CSP in the file template');
  // Clear any data-theme/data-runmode attributes the app set on <html> before capture.
  return out.replace(/<html([^>]*?) data-runmode="[^"]*"/, '<html$1');
}
