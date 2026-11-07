/** Chat-facing aliases keep plugin tool names inside provider function-name limits. */

function shortHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}

function slug(value: string): string {
  return value.replace(/^@/, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 22) || 'plugin';
}

export function chatServerName(pluginId: string, kind: 'tool' | 'command'): string {
  return `${kind === 'tool' ? 'dsh' : 'dshcmd'}_${slug(pluginId)}_${shortHash(`${kind}\0${pluginId}`)}`;
}

export function isDshChatServer(server: string): boolean {
  return server.startsWith('dsh_') || server.startsWith('dshcmd_');
}
