// The automation API through the registry (REQ-ARC-18, REQ-ARC-17): an assistant or an outside
// MCP client lists the commands and their state, and asks to run one. Running is an *action
// proposal*: nothing happens until the analyst accepts it in the Proposals list.

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function installAutomationTools(app, reg) {
  const C = app.commands;
  reg.tool({
    name: 'gw_list_commands',
    title: 'List commands',
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
    name: 'gw_run_command',
    title: 'Run a command',
    description: 'Propose running one automation command by id (see gw_list_commands). It runs only after the analyst accepts the proposal.',
    readOnly: false,
    inputSchema: obj({ command: { type: 'string' }, reason: { type: 'string' } }, ['command']),
    action: ({ command, reason = '' }) => {
      const c = C.get(command);
      if (!c) throw new Error(`no command "${command}"; call gw_list_commands`);
      if (!c.implemented) throw new Error(`"${c.label}" is not implemented in this build`);
      if (!C.enabled(command)) throw new Error(`"${c.label}" is not available now`);
      return {
        title: `Run "${c.label}"`,
        preview: `${command}${reason ? ` — ${reason}` : ''}`,
        run: async () => {
          await C.run(command);
          return `ran ${command}`;
        },
      };
    },
  });
}
