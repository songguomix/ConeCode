import { describe, expect, it } from 'vitest';
import { parseMcpConfig } from './mcpConfig';

describe('MCP configuration editor', () => {
  it('saves a blank editor without running the placeholder server', () => {
    expect(parseMcpConfig('')).toEqual({ mcpServers: {} });
    expect(parseMcpConfig(' \n ')).toEqual({ mcpServers: {} });
  });
  it('preserves configured servers and supported legacy names', () => {
    const servers = { filesystem: { command: 'local-server', args: ['project'] } };
    expect(parseMcpConfig(JSON.stringify({ mcpServers: servers }))).toEqual({ mcpServers: servers });
    expect(parseMcpConfig(JSON.stringify({ servers }))).toEqual({ servers });
  });
  it.each(['null', '[]', 'false', '{', '{"mcpServers":[]}', '{"servers":null}'])(
    'does not replace a working configuration with %s', (text) => {
      expect(() => parseMcpConfig(text)).toThrow();
    },
  );
});
