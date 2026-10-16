// RSI node:fs adapter for the Electron main process and scripts.
//
// Implements the pure `RsiFs` contract from src/core/agents/rsiTree.ts with
// real disk I/O. Lives in electron/ (NOT src/) because src/ is bundled for
// the renderer, where node:fs does not exist. Renderer-side code reaches the
// same files through its tool/bridge path instead.

import fs from 'fs';
import path from 'path';
import type { RsiFs } from '../../src/core/agents/rsiTree';

/** Synchronous disk-backed RsiFs rooted at any directory. */
export function nodeRsiFs(): RsiFs {
  return {
    readFile: (p: string) => {
      try {
        if (!fs.existsSync(p)) return null;
        return fs.readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },
    writeFile: (p: string, content: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    mkdir: (p: string) => {
      fs.mkdirSync(p, { recursive: true });
    },
    listDir: (dir: string) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}

/** Default RSI dir for a workspace root: <root>/.conecode/rsi. */
export function workspaceRsiDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.conecode', 'rsi');
}
