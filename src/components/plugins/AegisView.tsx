import { useEffect, useState } from 'react';

export default function AegisView({ t, enabled }: { t: (key: string) => string; enabled: boolean }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<{ url: string; decision: string; vt: string }[]>([]);
  const [error, setError] = useState('');
  const urls = input.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  const [token, setToken] = useState('');
  const [configured, setConfigured] = useState(false);
  useEffect(() => {
    window.electronAPI.aegis.hasKey().then(setConfigured).catch(err => setError(String(err)));
  }, []);

  const [connection, setConnection] = useState('');
  async function testKey() {
    setBusy(true);
    setConnection('testing');
    try {
      setConnection(await window.electronAPI.aegis.testKey(token.trim()));
    } catch {
      setConnection('unavailable');
    } finally {
      setBusy(false);
    }
  }

  async function saveKey(value: string) {
    setBusy(true);
    setError('');
    try {
      await window.electronAPI.aegis.setKey(value);
      setConfigured(Boolean(value.trim()));
      setToken('');
      setConnection('');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function scan() {
    setBusy(true);
    setRows([]);
    setError('');
    try {
      const report = await window.electronAPI.aegis.scan(urls);
      setRows(report.results.map((result, i) => ({ url: urls[i], decision: result.decision, vt: result.vt })));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-3 text-sm text-[var(--text-secondary)]">
    <p>{t('pluginDesc_aegis-search')}</p>
    <label className="block">VirusTotal API key
      <input type="password" autoComplete="off" value={token} disabled={busy || !enabled}
        placeholder={configured ? '••••••••' : ''} onChange={event => { setToken(event.target.value); setConnection(''); }}
        className="block w-full rounded-lg border border-[var(--border)] bg-[var(--bg-1)] p-2" />
    </label>
    <p className="text-xs leading-relaxed">
      <a href="https://www.virustotal.com/gui/my-apikey" target="_blank" rel="noopener noreferrer"
        className="text-[var(--accent)] underline">{t('aegisGetKey')}</a>
      {' '}{t('aegisKeyGuide')}
    </p>
    <div className="flex gap-3">
      <button disabled={busy || !enabled || !token.trim()} onClick={() => saveKey(token)}>{t('save')}</button>
      <button disabled={busy || !enabled || !token.trim()} onClick={testKey}>{t('aegisTestKey')}</button>
      {configured && <button disabled={busy} onClick={() => saveKey('')}>{t('clear')}</button>}
    </div>
    {connection && <p role="status">{t('aegisConnection_' + connection)}</p>}
    <label className="block">{t('aegisUrls')}
      <textarea value={input} disabled={busy || !enabled} rows={4}
        className="block mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-1)] p-2"
        onChange={event => { setInput(event.target.value); setRows([]); setError(''); }} />
    </label>
    <button disabled={!enabled || busy || !urls.length || urls.length > 20} onClick={scan}
      className="rounded-lg bg-[var(--accent-soft)] px-3 py-1 text-[var(--accent)] disabled:opacity-50">{t('run')}</button>
    {error && <p role="alert">{error}</p>}
    <ul aria-live="polite">{rows.map((row, i) =>
      <li key={i} className="break-all">{t(`aegis_${row.decision}`)} · VirusTotal {t('aegisVt_' + row.vt)} · {row.url}</li>)}</ul>
  </div>;
}
