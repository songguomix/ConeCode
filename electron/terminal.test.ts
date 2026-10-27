import { describe, expect, it } from 'vitest';
import { terminalShell, TerminalTextStream } from './terminal';

describe('terminalShell', () => {
  it('switches the Windows console session to UTF-8 before the first prompt', () => {
    const { bin, args } = terminalShell('win32');
    expect(bin).toBe('cmd.exe');
    expect(args.join(' ')).toContain('chcp 65001');
  });

  it('uses the login shell on Unix with a zsh fallback', () => {
    process.env.SHELL = '/bin/bash';
    expect(terminalShell('darwin')).toEqual({ bin: '/bin/bash', args: [] });
    delete process.env.SHELL;
    expect(terminalShell('linux')).toEqual({ bin: '/bin/zsh', args: [] });
  });
});

describe('TerminalTextStream — chunk-safe decoding', () => {
  it('reassembles a multi-byte sequence split across two pipe chunks', () => {
    const stream = new TerminalTextStream();
    const bytes = Buffer.from('目录结构正常', 'utf8');
    // Split INSIDE the first 3-byte character.
    const split = 2;
    const first = stream.write(bytes.subarray(0, split));
    const second = stream.write(bytes.subarray(split));
    expect(first).toBe('');
    expect(second).toBe('目录结构正常');
    expect(stream.text()).toBe('目录结构正常');
  });

  it('completes a split character on the next chunk', () => {
    const stream = new TerminalTextStream();
    const bytes = Buffer.from('构建完成✅', 'utf8');
    // First chunk ends mid-✅ (E2 9C), second delivers the missing byte.
    const partial = stream.write(bytes.subarray(0, bytes.length - 1));
    expect(partial.endsWith('成')).toBe(true);
    expect(stream.write(bytes.subarray(bytes.length - 1)).endsWith('✅')).toBe(true);
  });

  it('flushes a genuinely truncated tail as a replacement character on end()', () => {
    const stream = new TerminalTextStream();
    const bytes = Buffer.from('完成✅', 'utf8');
    const partial = stream.write(bytes.subarray(0, bytes.length - 1)); // last byte of ✅ never arrives
    expect(partial.endsWith('成')).toBe(true);
    expect(stream.end()).toBe('\uFFFD');
  });

  it('decodes plain ASCII and ANSI escapes untouched', () => {
    const stream = new TerminalTextStream();
    expect(stream.write(Buffer.from('\x1b[32mok\x1b[0m\r\n'))).toBe('\x1b[32mok\x1b[0m\r\n');
    expect(stream.end()).toBe('');
  });
});
