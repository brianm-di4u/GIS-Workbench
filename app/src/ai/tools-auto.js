// The automation API through the registry (REQ-ARC-18, REQ-ARC-17): an assistant or an outside
// MCP client lists the commands and their state, and asks to run one. Running is an *action
// proposal*: nothing happens until the analyst accepts it in the Proposals list.

import { t, tr } from '../i18n/index.js';
import { METHODS, API_VERSION, mcpName } from '../automation/v2-spec.js';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** A result an MCP client can read: Blobs become a note (binary files are for JavaScript callers or save: true). */
export function mcpSafe(v, depth = 0) {
  if (depth > 8) return null;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return { binary: true, size: v.size, type: v.type, note: 'binary file: call from JavaScript (gisworkbench.api.v2) or pass save: true' };
  if (ArrayBuffer.isView(v)) return { binary: true, size: v.byteLength };
  if (Array.isArray(v)) return v.map((x) => mcpSafe(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mcpSafe(x, depth + 1)]));
  return v;
}

/** Flags of a read-only API v2 method that make it write: a file (`save`) or a layer (`show`). */
const EFFECT_FLAGS = ['save', 'show'];

/**
 * API v2 as MCP tools (REQ-GAP-01): one gw2_* tool per v2 method that takes JSON (methods that
 * take File objects are JavaScript only). Read-only methods run directly; the others become
 * action proposals that run only when the analyst accepts them, as every MCP write does. So does
 * a read-only method called with an effect flag (REQ-GAP-02: nothing bypasses a proposal). The
 * tools are listed to MCP clients, not to the in-app assistant (its own gw_* tools stay).
 */
export function installApiV2Tools(app, reg) {
  for (const [method, m] of Object.entries(METHODS)) {
    const name = mcpName(method);
    if (!name) continue;
    const call = (args) => app.api.v2.call(method, args);
    const action = (args) => ({
      title: t('Automation: {method}', { method }),
      preview: JSON.stringify(args).slice(0, 400),
      run: async () => mcpSafe(await call(args)),
    });
    const flags = EFFECT_FLAGS.filter((k) => m.params?.properties?.[k]?.type === 'boolean');
    reg.tool({
      name,
      title: `API v2 ${method}`, // i18n-ignore: MCP tool title (DN-62 rule 7)
      description: `${m.summary} (gisworkbench.api.v2 ${method}, since ${m.since})`,
      inputSchema: m.params,
      readOnly: !!m.readOnly,
      mcpOnly: true,
      _meta: { 'gisworkbench/apiMethod': method, 'gisworkbench/apiVersion': API_VERSION },
      ...(m.readOnly ? { run: async (args) => mcpSafe(await call(args)), ...(flags.length ? { action, proposeWhen: (args) => flags.some((k) => args[k] === true) } : {}) } : { action }),
    });
  }
}

export function installAutomationTools(app, reg) {
  installApiV2Tools(app, reg);
  const C = app.commands;
  reg.tool({
    name: 'gw_list_commands',
    title: 'List commands', // i18n-ignore: MCP tool title (DN-62 rule 7)
    description: 'The automation commands (id, label, requirement, whether enabled and checked now). Filter by a substring of the id or label.',
    readOnly: true,
    inputSchema: obj({ filter: { type: 'string' } }),
    run: ({ filter = '' } = {}) => {
      const f = filter.toLowerCase();
      return C.list()
        .filter((c) => !f || c.id.toLowerCase().includes(f) || String(c.label).toLowerCase().includes(f))
        .slice(0, 300)
        .map((c) => ({ id: c.id, label: c.label, req: c.req ?? null, enabled: C.enabled(c.id), checked: C.checked(c.id), implemented: !!c.implemented }));
    },
  });
  reg.tool({
    name: 'gw_proposal_status',
    title: 'Proposal status', // i18n-ignore: MCP tool title (DN-62 rule 7)
    description: 'Where a proposal this client made stands: pending, running, accepted, rejected, stale or failed, with the outcome when it ran. Only the analyst decides a proposal.',
    readOnly: true,
    mcpOnly: true,
    inputSchema: obj({ id: { type: 'string' } }, ['id']),
    run: ({ id }, ctx = {}) => {
      const p = app.proposals.items.find((x) => x.id === id && x.provenance?.source === ctx.source && x.provenance?.model === ctx.model);
      if (!p) throw new Error(`no proposal "${id}" from this client`);
      return { id: p.id, status: p.status, title: p.title, outcome: p.outcome ?? null };
    },
  });
  reg.tool({
    name: 'gw_run_command',
    title: 'Run a command', // i18n-ignore: MCP tool title (DN-62 rule 7)
    description: 'Propose running one automation command by id (see gw_list_commands). It runs only after the analyst accepts the proposal.',
    readOnly: false,
    inputSchema: obj({ command: { type: 'string' }, reason: { type: 'string' } }, ['command']),
    action: ({ command, reason = '' }) => {
      const c = C.get(command);
      if (!c) throw new Error(`no command "${command}"; call gw_list_commands`);
      if (!c.implemented) throw new Error(`"${c.label}" is not implemented in this build`);
      if (!C.enabled(command)) throw new Error(`"${c.label}" is not available now`);
      return {
        title: t('Run "{command}"', { command: tr(c.label) }),
        preview: `${command}${reason ? ` — ${reason}` : ''}`,
        run: async () => {
          await C.run(command);
          return `ran ${command}`;
        },
      };
    },
  });
}
