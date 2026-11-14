import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface NpmCommand {
  path: string;
  executable: string;
  args: string[];
  searchPath: string;
}

const windows = process.platform === 'win32';

function envPathKey(env: NodeJS.ProcessEnv): string {
  return (windows && Object.keys(env).find((key) => key.toUpperCase() === 'PATH')) || 'PATH';
}

function isFile(filename: string): boolean {
  return fs.statSync(filename, { throwIfNoEntry: false })?.isFile() ?? false;
}

export function* npmCommands(env: NodeJS.ProcessEnv = process.env): Generator<NpmCommand> {
  const home = os.homedir();
  // Desktop launches do not inherit directories added by a terminal's shell startup files.
  const defaults = windows ? [
    env.NVM_SYMLINK,
    ...[env.ProgramFiles, env['ProgramFiles(x86)']].map((dir) => dir && path.join(dir, 'nodejs')),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'nodejs'),
    env.APPDATA && path.join(env.APPDATA, 'npm'),
  ] : [
    path.join(home, '.local', 'node', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(env.VOLTA_HOME || path.join(home, '.volta'), 'bin'),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin'] : []),
    '/usr/local/bin', '/usr/bin', '/bin',
  ];
  const inherited = (env[envPathKey(env)] || '').split(path.delimiter);
  const dirs = [...new Set([...inherited, ...defaults].flatMap((dir) => {
    const cleaned = windows ? dir?.replace(/^"(.*)"$/, '$1') : dir;
    return cleaned && path.isAbsolute(cleaned) ? [path.normalize(cleaned)] : [];
  }))];
  const override = env.CONECODE_NPM?.trim();
  const name = override || (windows ? 'npm.cmd' : 'npm');
  const filenames = path.isAbsolute(name) || /[/\\]/.test(name)
    ? [path.resolve(name)]
    : dirs.map((dir) => path.join(dir, name));

  for (const filename of filenames) {
    try {
      if (!isFile(filename)) continue;
      const bin = path.dirname(filename);
      const searchDirs = [bin, ...dirs.filter((dir) => dir !== bin)];
      const searchPath = searchDirs.join(path.delimiter);
      if (windows && /\.(?:cmd|bat)$/i.test(filename)) {
        // npm.cmd is a batch wrapper. Launch its CLI with Node so install args never go through cmd.exe.
        const cli = path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js');
        if (!isFile(cli)) continue;
        const node = searchDirs.map((dir) => path.join(dir, 'node.exe')).find(isFile);
        if (node) yield { path: filename, executable: node, args: [cli], searchPath };
      } else {
        yield { path: filename, executable: filename, args: [], searchPath };
      }
    } catch { /* an inaccessible or stale candidate should not mask a working install */ }
  }
}

export function withNpmPath(env: NodeJS.ProcessEnv, command: NpmCommand): NodeJS.ProcessEnv {
  return { ...env, [envPathKey(env)]: command.searchPath };
}
