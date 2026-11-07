/**
 * Minimum ConeCode-native plugin.
 *
 * Contract (apiVersion 1):
 *   export async function activate(api, config) -> optional dispose()
 *
 * `api` exposes only the host services declared in conecode.plugin.json. Every
 * registration returns a disposer; returning one from activate is optional but
 * recommended. The host also removes all registrations on disable/uninstall.
 */

export async function activate(api, config = {}) {
  const greeting = typeof config.greeting === 'string' && config.greeting.trim()
    ? config.greeting.trim()
    : 'Hello';

  const offTool = api.tools.register({
    name: 'hello_conecode',
    description: 'Return a deterministic greeting and prove the native plugin runtime is active.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Who to greet' },
      },
      required: ['name'],
    },
    async execute(args) {
      const name = String(args?.name || 'world').trim() || 'world';
      return {
        message: `${greeting}, ${name}!`,
        plugin: 'hello-conecode',
        version: '1.0.0',
        at: new Date().toISOString(),
      };
    },
  });

  const offCommand = api.commands.register({
    name: 'hello',
    description: 'ConeCode native plugin smoke test: /hello [name]',
    input: { hint: '[name]' },
    handler({ rawInput }) {
      const name = String(rawInput || '').trim() || 'world';
      return { kind: 'success', text: `${greeting}, ${name} — native plugin command executed.` };
    },
  });

  const offSkill = api.skills.register({
    name: 'hello-conecode',
    description: 'How the minimum ConeCode-native plugin is declared, loaded and cleaned up.',
    source: 'bundled',
    content: [
      '# Hello ConeCode',
      '',
      'This skill is registered by the bundled native plugin example.',
      '',
      '- Manifest: `conecode.plugin.json` (`conecode.plugin === true`).',
      '- Entry: `index.mjs`, `activate(api, config)`.',
      '- Contributions: one tool, one command, one skill.',
      '- All registrations are removed on disable/uninstall.',
    ].join('\n'),
  });

  return () => {
    offTool();
    offCommand();
    offSkill();
  };
}
