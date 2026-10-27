import { StringDecoder } from 'string_decoder';

/**
 * Windows console programs emit text in the OEM code page (GBK/CP936 on
 * Chinese Windows) unless the session's code page is switched to UTF-8 —
 * piping those bytes through a UTF-8 decode is the classic terminal
 * mojibake. `chcp 65001` flips the spawned cmd session (and every program
 * it runs) to UTF-8 before the first prompt; `>nul` keeps the switch banner
 * out of the transcript. Unix shells already speak UTF-8.
 */
export function terminalShell(platform: string): { bin: string; args: string[] } {
  if (platform === 'win32') {
    return { bin: 'cmd.exe', args: ['/k', 'chcp 65001 >nul'] };
  }
  return { bin: process.env.SHELL || '/bin/zsh', args: [] };
}

/**
 * Chunk-safe text decoding for piped shell output. A multi-byte UTF-8
 * sequence split across two stdout chunks (chunk boundaries land wherever
 * the pipe buffer says, not between characters) would otherwise render as
 * U+FFFD garbage. StringDecoder holds the incomplete tail until the next
 * chunk completes it.
 */
export class TerminalTextStream {
  private decoder = new StringDecoder('utf8');
  private pieces: string[] = [];

  write(data: Buffer): string {
    const text = this.decoder.write(data);
    this.pieces.push(text);
    return text;
  }

  /** Flush any held partial sequence (call when the process exits). */
  end(): string {
    const text = this.decoder.end();
    this.pieces.push(text);
    return text;
  }

  /** Everything decoded so far (tests / inspection). */
  text(): string {
    return this.pieces.join('');
  }
}
