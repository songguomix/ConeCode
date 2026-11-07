/** The example is a hint only. Saving an empty editor disables global servers. */
export function parseMcpConfig(text: string): Record<string, unknown> {
  if (!text.trim()) return { mcpServers: {} };
  const config: unknown = JSON.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('MCP configuration must be a JSON object.');
  }
  const result = config as Record<string, unknown>;
  for (const key of ['mcpServers', 'servers']) {
    if (key in result && (!result[key] || typeof result[key] !== 'object' || Array.isArray(result[key]))) {
      throw new Error(`${key} must be a JSON object.`);
    }
  }
  return result;
}
