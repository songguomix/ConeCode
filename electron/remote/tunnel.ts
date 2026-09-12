import { spawn, type ChildProcess } from 'child_process';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Tunnel diagnostics: cloudflared/ngrok output is teed here so a failing tunnel
// (e.g. Cloudflare "error 1033") can be inspected. Easy-to-find path in $HOME.
const TUNNEL_LOG = path.join(os.homedir(), '.conecode-tunnel.log');
function logTunnel(s: string) {
  try { fs.appendFileSync(TUNNEL_LOG, s); } catch {}
}

// Optional NAT-traversal (内网穿透): give the local remote server a public HTTPS
// URL so a phone can reach it over cellular / a different network. We don't run
// our own relay — instead we drive cloudflared quick-tunnels (no account). The
// binary is BUNDLED with the app (see `bundledCloudflared`), so it works out of
// the box; we fall back to a PATH `cloudflared`, then to ngrok, if needed.

// Resolve the cloudflared binary shipped in the app's resources (electron-builder
// `mac.extraResources` → `bin/`). In dev it lives under the project `resources/`.
// Returns null when no bundled binary exists for this platform/arch.
function bundledCloudflared(): string | null {
  const name =
    process.platform === 'darwin' && process.arch === 'arm64' ? 'cloudflared-darwin-arm64'
    : process.platform === 'win32' ? 'cloudflared-win-x64.exe'
    : null;
  if (!name) return null;
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(app.getAppPath(), 'resources', 'bin');
  const bin = path.join(base, name);
  if (!fs.existsSync(bin)) return null;
  // electron-builder may not preserve the executable bit; ensure it here.
  try { fs.chmodSync(bin, 0o755); } catch {}
  return bin;
}

// The ngrok agent installed via the one-click installer (userData/bin); preferred
// over a PATH `ngrok` so the install "just works" without touching the system.
function installedNgrok(): string | null {
  const bin = path.join(app.getPath('userData'), 'bin', process.platform === 'win32' ? 'ngrok.exe' : 'ngrok');
  if (!fs.existsSync(bin)) return null;
  try { fs.chmodSync(bin, 0o755); } catch {}
  return bin;
}

export interface TunnelResult {
  url?: string;
  tool?: 'cloudflared' | 'ngrok' | 'custom';
  error?: 'notInstalled' | 'timeout' | 'failed';
  /** Last lines of the tool's own output, surfaced to the UI to explain a failure. */
  detail?: string;
}

/** Last ~400 chars of a tool's output, for showing why a tunnel failed. */
function tailOut(s: string): string | undefined {
  const t = (s || '').trim();
  return t ? t.slice(-400) : undefined;
}

// How to expose the local server publicly. `cloudflared` (default) uses the
// bundled binary's quick tunnel; `ngrok` uses a PATH ngrok with the user's token
// and a chosen region (faster from Asia); `custom` runs the user's own command
// (with {port}/{url} substituted) so they can drive any tunnel / VPS relay.
export interface TunnelConfig {
  method?: 'cloudflared' | 'ngrok' | 'custom';
  ngrokToken?: string;
  ngrokRegion?: string;
  customCommand?: string;
}

let proc: ChildProcess | null = null;

export function stopTunnel(): void {
  if (proc) {
    try { proc.kill(); } catch {}
    proc = null;
  }
}

export function startTunnel(
  port: number,
  env: NodeJS.ProcessEnv,
  config: TunnelConfig = {},
): Promise<TunnelResult> {
  stopTunnel();
  try { fs.writeFileSync(TUNNEL_LOG, `[${new Date().toISOString()}] starting tunnel (method=${config.method || 'cloudflared'}) for https://localhost:${port}\n`); } catch {}
  return new Promise((resolve) => {
    const tryTool = (
      cmd: string,
      args: string[],
      urlRe: RegExp,
      readyRe: RegExp | null,
      tool: 'cloudflared' | 'ngrok' | 'custom',
      onFail: (err: 'notInstalled' | 'failed', detail: string) => void,
      opts: { env?: NodeJS.ProcessEnv; shell?: boolean } = {},
    ) => {
      let child: ChildProcess;
      try {
        child = spawn(cmd, args, { env: opts.env || env, shell: opts.shell || false });
      } catch {
        onFail('notInstalled', '');
        return;
      }
      proc = child;
      let lastOutput = '';
      logTunnel(`[${new Date().toISOString()}] spawn: ${cmd} ${args.join(' ')}\n`);
      let done = false;
      const finish = (r: TunnelResult) => {
        if (done) return;
        done = true;
        resolve(r);
      };

      // A quick tunnel prints its public URL a moment BEFORE its edge connections
      // finish registering. Returning the URL that early is the classic Cloudflare
      // "error 1033" (hostname routed to a tunnel, but no connection registered yet).
      // So hold the captured URL until cloudflared logs a registered connection,
      // then add a short grace for edge propagation. ngrok/custom (readyRe=null) are
      // ready as soon as they print their URL.
      let capturedUrl: string | null = null;
      const emit = () => {
        if (!capturedUrl) return;
        const url = capturedUrl;
        setTimeout(() => finish({ url, tool }), readyRe ? 2000 : 0);
      };
      const scan = (d: Buffer) => {
        const s = d.toString();
        logTunnel(s);
        lastOutput = (lastOutput + s).slice(-800);
        if (!capturedUrl) {
          const m = s.match(urlRe);
          if (m) {
            capturedUrl = m[0];
            if (!readyRe) emit();
            // Fallback: if a "registered" line never arrives, still return the URL.
            else setTimeout(() => { if (!done) emit(); }, 12000);
          }
        }
        if (readyRe && capturedUrl && readyRe.test(s)) emit();
      };
      child.stdout?.on('data', scan);
      child.stderr?.on('data', scan);
      // ENOENT (binary missing) surfaces here → the tool isn't installed.
      child.on('error', () => {
        if (proc === child) proc = null;
        if (!done) onFail('notInstalled', lastOutput);
      });
      // Exited without ever printing a URL → it ran but failed (bad token, region,
      // network, etc.); surface its last output so the user sees the real reason.
      child.on('close', () => {
        if (proc === child) proc = null;
        if (!done) onFail('failed', lastOutput);
      });
      setTimeout(() => finish({ error: 'timeout', tool, detail: tailOut(lastOutput) }), 35000);
    };

    const ngrokUrlRe = /https:\/\/[-a-z0-9.]+\.ngrok[-a-z0-9.]*/i;
    const method = config.method || 'cloudflared';

    // ngrok: needs a PATH ngrok + the user's authtoken (via NGROK_AUTHTOKEN), and
    // an optional region (ap/jp/… is far faster from Asia than Cloudflare's US edge).
    if (method === 'ngrok') {
      const ngrokEnv = { ...env };
      if (config.ngrokToken) ngrokEnv.NGROK_AUTHTOKEN = config.ngrokToken;
      const args = ['http', `https://localhost:${port}`, '--log', 'stdout'];
      if (config.ngrokRegion && config.ngrokRegion !== 'auto') args.push('--region', config.ngrokRegion);
      tryTool(installedNgrok() || 'ngrok', args, ngrokUrlRe, null, 'ngrok',
        (err, detail) => resolve({ error: err, tool: 'ngrok', detail: tailOut(detail) }), { env: ngrokEnv });
      return;
    }

    // custom: run the user's command (shell), substituting {port} / {url}. We grab
    // the first https URL it prints. Best-effort kill via the shell process.
    if (method === 'custom') {
      const tmpl = (config.customCommand || '').trim();
      if (!tmpl) { resolve({ error: 'notInstalled' }); return; }
      const cmdStr = tmpl
        .replace(/\{port\}/g, String(port))
        .replace(/\{url\}/g, `https://localhost:${port}`);
      tryTool(cmdStr, [], /https:\/\/[^\s"'<>]+/i, null, 'custom',
        (err, detail) => resolve({ error: err, tool: 'custom', detail: tailOut(detail) }), { shell: true });
      return;
    }

    // Default cloudflared (bundled): HTTPS self-signed origin so --no-tls-verify;
    // --protocol http2 avoids the QUIC/UDP block that causes "error 1033"; fall
    // back to a PATH cloudflared, then ngrok, if the bundled one is unavailable.
    tryTool(
      bundledCloudflared() || 'cloudflared',
      [
        'tunnel', '--no-tls-verify',
        '--protocol', 'http2',
        '--edge-ip-version', '4',
        '--url', `https://localhost:${port}`,
      ],
      /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i,
      /registered tunnel connection/i,
      'cloudflared',
      () => {
        tryTool(
          installedNgrok() || 'ngrok',
          ['http', `https://localhost:${port}`, '--log', 'stdout'],
          ngrokUrlRe,
          null,
          'ngrok',
          (err, detail) => resolve({ error: err, tool: 'ngrok', detail: tailOut(detail) }),
        );
      },
    );
  });
}
