import { useEffect, useState } from 'react';
import { FiX, FiSmartphone, FiCopy, FiCheck, FiGlobe, FiLock } from 'react-icons/fi';
import { useUIStore, useLanguageStore } from '../../stores';
import { qrSvg } from '../../core/remote/qr';

interface RemoteState {
  running: boolean;
  port: number | null;
  lanUrls: string[];
  tunnelUrl: string | null;
  clients: number;
  devices?: { id: string; ip: string; since: number }[];
  tunnelError?: string;
  tunnelDetail?: string;
  hasPassword?: boolean;
}

const EMPTY: RemoteState = { running: false, port: null, lanUrls: [], tunnelUrl: null, clients: 0 };
const PASSWORD_KEY = 'remotePassword';
const TUNNEL_KEY = 'remoteTunnel';

interface TunnelCfg {
  method: 'cloudflared' | 'ngrok' | 'custom';
  ngrokToken: string;
  ngrokRegion: string;
  customCommand: string;
}
const DEFAULT_TUNNEL: TunnelCfg = { method: 'cloudflared', ngrokToken: '', ngrokRegion: 'jp', customCommand: '' };
function loadTunnel(): TunnelCfg {
  try { return { ...DEFAULT_TUNNEL, ...JSON.parse(localStorage.getItem(TUNNEL_KEY) || '{}') }; }
  catch { return DEFAULT_TUNNEL; }
}

// Public mode requires a strong password: ≥6 chars with an uppercase letter, a
// digit, and a symbol. Only a complying password is pushed to the server.
function passwordValid(pw: string): boolean {
  return pw.length >= 6 && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}

// Codex-style "connect your phone" popover, toggled from the sidebar. Shows a
// scannable QR for the LAN URL, the address(es) to type manually, and a button
// to open a public tunnel (内网穿透). Mirrors the floating-card pattern of
// ChangedFilesPanel.
export default function RemotePanel() {
  const closeRemote = useUIStore((s) => s.closeRemote);
  const { t } = useLanguageStore();
  const [st, setSt] = useState<RemoteState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [password, setPassword] = useState<string>(() => localStorage.getItem(PASSWORD_KEY) || '');
  const [tunnel, setTunnel] = useState<TunnelCfg>(loadTunnel);
  const [ngrokInstalling, setNgrokInstalling] = useState(false);
  const [ngrokMsg, setNgrokMsg] = useState<string | null>(null);
  const [cfdInstalling, setCfdInstalling] = useState(false);
  const [cfdMsg, setCfdMsg] = useState<string | null>(null);

  const installCloudflared = async () => {
    setCfdInstalling(true);
    setCfdMsg(null);
    try {
      const r = await api()?.installCloudflared?.();
      setCfdMsg(r?.ok ? t('cfdInstalled') : `${t('cfdInstallFailed')}: ${r?.error || ''}`);
    } catch (e: any) {
      setCfdMsg(`${t('cfdInstallFailed')}: ${e?.message || ''}`);
    }
    setCfdInstalling(false);
  };

  const api = () => (window as any).electronAPI?.remote;

  const installNgrok = async () => {
    setNgrokInstalling(true);
    setNgrokMsg(null);
    try {
      const r = await api()?.installNgrok();
      setNgrokMsg(r?.ok ? t('ngrokInstalled') : `${t('ngrokInstallFailed')}: ${r?.error || ''}`);
    } catch (e: any) {
      setNgrokMsg(`${t('ngrokInstallFailed')}: ${e?.message || ''}`);
    } finally {
      setNgrokInstalling(false);
    }
  };

  const updateTunnel = (patch: Partial<TunnelCfg>) => {
    setTunnel((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(TUNNEL_KEY, JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    // Re-apply the saved password to the server (it isn't persisted in main) —
    // only if it still meets the complexity rule.
    const saved = localStorage.getItem(PASSWORD_KEY) || '';
    if (passwordValid(saved)) api()?.setPassword(saved);
    api()?.status().then((s: RemoteState) => setSt(s || EMPTY));
    // On any device connect/disconnect, re-fetch full status to refresh the list.
    const off = api()?.onClients(() => {
      api()?.status().then((s: RemoteState) => { if (s) setSt(s); });
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  const kick = (id: string) => {
    api()?.kick(id).then((s: RemoteState) => { if (s) setSt(s); });
  };

  const updatePassword = (pw: string) => {
    setPassword(pw);
    if (pw) localStorage.setItem(PASSWORD_KEY, pw);
    else localStorage.removeItem(PASSWORD_KEY);
    // Only a complying password protects the server; a partial/weak one counts as none.
    api()?.setPassword(passwordValid(pw) ? pw : null).then((s: RemoteState) => { if (s) setSt(s); });
  };

  const toggleServer = async () => {
    setBusy(true);
    try {
      const next = st.running ? await api()?.stop() : await api()?.start();
      setSt(next || EMPTY);
    } finally {
      setBusy(false);
    }
  };

  const openTunnel = async () => {
    if (!passwordValid(password)) return; // public mode requires a strong password
    setTunnelBusy(true);
    try {
      const next = await api()?.start({ tunnel: true, tunnelConfig: tunnel });
      setSt(next || EMPTY);
    } finally {
      setTunnelBusy(false);
    }
  };

  const copy = (url: string) => {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(url);
      setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
    });
  };

  const primaryUrl = st.tunnelUrl || st.lanUrls[0] || '';

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={closeRemote} />
      <div className="fixed left-4 bottom-4 top-[96px] z-50 w-[340px] flex flex-col bg-[var(--bg-1)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 shrink-0 border-b border-[var(--border)]">
          <FiSmartphone size={16} className="text-[var(--accent)]" />
          <span className="flex-1 text-[13px] font-medium text-[var(--text-primary)]">{t('remoteControl')}</span>
          <span className={`flex items-center gap-1.5 text-[11px] ${st.running ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: st.running ? 'var(--accent)' : 'var(--text-muted)' }} />
            {st.running ? t('serverOnline') : t('serverOff')}
          </span>
          <button onClick={closeRemote}
            className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors">
            <FiX size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">{t('remoteDesc')}</p>

          {/* Start / stop */}
          <button onClick={toggleServer} disabled={busy}
            className={`w-full py-2.5 rounded-xl text-[13px] font-medium transition-colors disabled:opacity-50 ${
              st.running
                ? 'bg-[var(--bg-3)] text-[var(--text-secondary)] hover:bg-[var(--bg-4)]'
                : 'bg-[var(--accent)] text-white hover:opacity-90'
            }`}>
            {busy ? t('serverStarting') : st.running ? t('stopServer') : t('startServer')}
          </button>

          {/* Optional connection password (extra login factor; not in the QR). */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              <FiLock size={11} /> {t('remotePassword')}
            </div>
            <input
              type="password"
              value={password}
              onChange={(e) => updatePassword(e.target.value)}
              placeholder={t('remotePasswordPlaceholder')}
              className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            {password && !passwordValid(password) ? (
              <p className="text-[11px] text-[var(--error)] leading-relaxed">{t('remotePasswordReq')}</p>
            ) : (
              <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{t('remotePasswordHint')}</p>
            )}
          </div>

          {st.running && primaryUrl && (
            <>
              {/* QR */}
              <div className="flex flex-col items-center gap-2">
                <div className="bg-white p-2.5 rounded-xl w-[180px] h-[180px]"
                  dangerouslySetInnerHTML={{ __html: qrSvg(primaryUrl) }} />
                <span className="text-[11px] text-[var(--text-muted)]">{t('scanToConnect')}</span>
              </div>

              {/* LAN addresses */}
              {st.lanUrls.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{t('lanAddress')}</div>
                  {st.lanUrls.map((url) => (
                    <button key={url} onClick={() => copy(url)}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--bg-2)] hover:bg-[var(--bg-3)] transition-colors text-left">
                      <span className="flex-1 truncate font-[var(--font-mono)] text-[11px] text-[var(--text-secondary)]">{url}</span>
                      {copied === url ? <FiCheck size={13} className="text-[var(--accent)]" /> : <FiCopy size={13} className="text-[var(--text-muted)]" />}
                    </button>
                  ))}
                </div>
              )}

              {/* Tunnel method (only before a tunnel is open) */}
              {!st.tunnelUrl && (
                <div className="space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{t('tunnelMethod')}</div>
                  <select
                    value={tunnel.method}
                    onChange={(e) => updateTunnel({ method: e.target.value as TunnelCfg['method'] })}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
                    <option value="cloudflared">{t('tunnelCloudflare')}</option>
                    <option value="ngrok">ngrok</option>
                    <option value="custom">{t('tunnelCustom')}</option>
                  </select>
                  {tunnel.method === 'cloudflared' && (
                    <>
                      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{t('cfdAdaptiveHint')}</p>
                      <button onClick={installCloudflared} disabled={cfdInstalling}
                        className="w-full flex items-center justify-center gap-2 py-1.5 rounded-lg bg-[var(--bg-3)] hover:bg-[var(--bg-4)] text-[12px] text-[var(--text-secondary)] transition-colors disabled:opacity-50">
                        {cfdInstalling ? t('cfdInstalling') : t('cfdInstall')}
                      </button>
                      {cfdMsg && <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{cfdMsg}</p>}
                    </>
                  )}
                  {tunnel.method === 'ngrok' && (
                    <>
                      <input
                        type="password"
                        value={tunnel.ngrokToken}
                        onChange={(e) => updateTunnel({ ngrokToken: e.target.value })}
                        placeholder="ngrok authtoken"
                        className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                      <select
                        value={tunnel.ngrokRegion}
                        onChange={(e) => updateTunnel({ ngrokRegion: e.target.value })}
                        className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
                        <option value="jp">日本 · Japan (jp)</option>
                        <option value="ap">新加坡 · Singapore (ap)</option>
                        <option value="in">印度 · India (in)</option>
                        <option value="au">澳洲 · Australia (au)</option>
                        <option value="us">美国 · US (us)</option>
                        <option value="eu">欧洲 · EU (eu)</option>
                        <option value="auto">{t('auto')}</option>
                      </select>
                      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{t('ngrokHint')}</p>
                      <button onClick={installNgrok} disabled={ngrokInstalling}
                        className="w-full flex items-center justify-center gap-2 py-1.5 rounded-lg bg-[var(--bg-3)] hover:bg-[var(--bg-4)] text-[12px] text-[var(--text-secondary)] transition-colors disabled:opacity-50">
                        {ngrokInstalling ? t('ngrokInstalling') : t('ngrokInstall')}
                      </button>
                      {ngrokMsg && <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{ngrokMsg}</p>}
                    </>
                  )}
                  {tunnel.method === 'custom' && (
                    <>
                      <input
                        value={tunnel.customCommand}
                        onChange={(e) => updateTunnel({ customCommand: e.target.value })}
                        placeholder="e.g. cloudflared tunnel run --url {url} my-tunnel"
                        className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] font-[var(--font-mono)] text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{t('tunnelCustomHint')}</p>
                    </>
                  )}
                </div>
              )}

              {/* Public link / tunnel */}
              {st.tunnelUrl ? (
                <button onClick={() => copy(st.tunnelUrl!)}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg bg-[var(--accent-soft)] border border-[var(--accent)] transition-colors text-left">
                  <FiGlobe size={13} className="text-[var(--accent)] shrink-0" />
                  <span className="flex-1 truncate font-[var(--font-mono)] text-[11px] text-[var(--accent)]">{st.tunnelUrl}</span>
                  {copied === st.tunnelUrl ? <FiCheck size={13} className="text-[var(--accent)]" /> : <FiCopy size={13} className="text-[var(--accent)]" />}
                </button>
              ) : (
                <>
                  <button onClick={openTunnel} disabled={tunnelBusy || !passwordValid(password)}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-xl border border-[var(--border)] text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-colors disabled:opacity-50">
                    <FiGlobe size={13} />
                    {tunnelBusy ? t('tunnelStarting') : t('publicLink')}
                  </button>
                  {!passwordValid(password) && (
                    <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{t('remotePublicNeedsPassword')}</p>
                  )}
                </>
              )}
              {st.tunnelError && (
                <div className="space-y-1">
                  <p className="text-[11px] text-[var(--error)] leading-relaxed">
                    {st.tunnelError === 'notInstalled'
                      ? t('tunnelNotInstalled')
                      : st.tunnelError === 'timeout'
                        ? t('tunnelTimeout')
                        : t('tunnelFailed')}
                  </p>
                  {st.tunnelDetail && (
                    <pre className="text-[10px] font-[var(--font-mono)] text-[var(--text-muted)] whitespace-pre-wrap break-all max-h-24 overflow-y-auto bg-[var(--bg-2)] rounded-lg p-2">{st.tunnelDetail}</pre>
                  )}
                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{t('tunnelHint')}</p>
                </div>
              )}

              {/* Connected devices: IP + kick. */}
              <div className="space-y-1.5 pt-1">
                <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                  {t('connectedDevices')} · {st.clients}
                </div>
                {(st.devices && st.devices.length > 0) ? (
                  st.devices.map((d) => (
                    <div key={d.id}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--bg-2)]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />
                      <span className="flex-1 truncate font-[var(--font-mono)] text-[11px] text-[var(--text-secondary)]">{d.ip}</span>
                      <button onClick={() => kick(d.id)}
                        className="text-[11px] text-[var(--error)] hover:underline shrink-0">{t('kickDevice')}</button>
                    </div>
                  ))
                ) : (
                  <p className="text-[11px] text-[var(--text-muted)]">{t('noDevices')}</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
