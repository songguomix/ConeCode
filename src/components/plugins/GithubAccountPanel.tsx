import { useEffect, useState } from 'react';
import { FiExternalLink, FiGithub, FiKey } from 'react-icons/fi';
import { useLanguageStore } from '../../stores/language.store';
import { useMarketStore } from '../../stores/market.store';

const buttonClass = 'shrink-0 cursor-pointer rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--bg-3)] disabled:cursor-not-allowed disabled:opacity-50';
const accountErrors = {
  'login-failed': 'githubAccountLoginFailed',
  'logout-failed': 'githubAccountDisconnectFailed',
  'status-failed': 'githubAccountCheckFailed',
  'timed-out': 'githubAccountTimedOut',
};

export default function GithubAccountPanel() {
  const { t } = useLanguageStore();
  const account = useMarketStore((s) => s.account);
  const refreshAccount = useMarketStore((s) => s.refreshAccount);
  const setAccount = useMarketStore((s) => s.setAccount);
  const tokenSet = useMarketStore((s) => s.tokenSet);
  const setToken = useMarketStore((s) => s.setToken);
  const [tokenDraft, setTokenDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const pending = account?.state === 'pending';
  const disconnected = account?.state === 'signed-out' || account?.state === 'error';

  useEffect(() => { void refreshAccount(); }, [refreshAccount]);
  useEffect(() => {
    if (!pending) return;
    let active = true;
    const poll = async () => {
      await refreshAccount();
      if (active) timer = window.setTimeout(poll, 1500);
    };
    let timer = window.setTimeout(poll, 1500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [pending, refreshAccount]);

  const run = async (action: 'begin' | 'cancel' | 'logout') => {
    if (busy) return;
    setBusy(true);
    setActionFailed(false);
    try {
      setAccount(await window.electronAPI.githubAccount[action]());
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-3 min-w-0 rounded-xl border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
          <FiGithub size={14} className="shrink-0" aria-hidden="true" />
          <span>{t('githubAccount')}</span>
          {account?.state === 'signed-in' && <span title={account.login} className="truncate font-mono text-[var(--accent)]">{account.login ? '@' + account.login : t('githubAccountConnected')}</span>}
        </div>
        {disconnected && <button type="button" className={buttonClass} disabled={busy} onClick={() => void run('begin')}>{t('githubAccountSignIn')}</button>}
        {pending && <button type="button" className={buttonClass} disabled={busy} onClick={() => void run('cancel')}>{t('cancel')}</button>}
        {account?.state === 'signed-in' && <button type="button" className={buttonClass} disabled={busy} onClick={() => void run('logout')}>{t('githubAccountDisconnect')}</button>}
        {account?.state === 'unavailable' && <button type="button" className={buttonClass} onClick={() => void refreshAccount()}>{t('pluginRefresh')}</button>}
      </div>
      {!account && <p role="status" className="mt-1 text-xs text-[var(--text-muted)]">{t('githubAccountChecking')}</p>}
      {disconnected && <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{t('githubAccountSignInHint')}</p>}
      {account?.state === 'unavailable' && <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
        {t('githubAccountCliNeeded')}{' '}
        <a href="https://cli.github.com/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline">
          {t('githubAccountGetCli')} <FiExternalLink size={11} aria-hidden="true" />
        </a>
      </p>}
      {pending && <div className="mt-2 space-y-2 text-xs text-[var(--text-secondary)]" role="status">
        <p>{t('githubAccountWaiting')}{' '}
          <a href="https://github.com/login/device" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline">
            {t('githubAccountOpenDevice')} <FiExternalLink size={11} aria-hidden="true" />
          </a>
        </p>
        {account.deviceCode && <div className="flex flex-wrap items-center gap-2">
          <code className="select-all rounded-md bg-[var(--bg-0)] px-2 py-1.5 font-mono text-sm tracking-wider text-[var(--text-primary)]">{account.deviceCode}</code>
          <button type="button" className={buttonClass} onClick={() => {
            const code = account.deviceCode;
            if (code) void navigator.clipboard.writeText(code).then(() => setCopiedCode(code)).catch(() => {});
          }}>{t(copiedCode === account.deviceCode ? 'githubAccountCodeCopied' : 'githubAccountCopyCode')}</button>
        </div>}
      </div>}
      {(actionFailed || account?.error) && <p role="alert" className="mt-2 text-xs text-[var(--error)]">
        {t(account?.error ? accountErrors[account.error] : 'githubAccountCheckFailed')}
      </p>}

      <details className="mt-2 border-t border-[var(--border)] pt-2">
        <summary className="cursor-pointer text-xs text-[var(--text-secondary)]">{t('githubAccountManualToken')}</summary>
        {account?.state === 'signed-in' && <p className="mt-2 text-xs text-[var(--text-muted)]">{t('githubAccountPriority')}</p>}
        <form className="mt-2 flex flex-wrap gap-1.5" onSubmit={(event) => {
          event.preventDefault();
          const token = tokenDraft.trim();
          if (token) setToken(token);
          setTokenDraft('');
        }}>
          <div className="relative min-w-0 flex-1 basis-36">
            <FiKey size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden="true" />
            <input aria-label={t('pluginTokenLabel')} value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)}
              type="password" placeholder={t(tokenSet ? 'pluginTokenSet' : 'pluginTokenPh')} spellCheck={false} autoComplete="off"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-0)] py-1.5 pl-8 pr-2.5 text-xs outline-none focus:border-[var(--accent)]" />
          </div>
          <button type="submit" className={buttonClass} disabled={!tokenDraft.trim()}>{t('pluginSave')}</button>
          {tokenSet && <button type="button" className={buttonClass} onClick={() => { setToken(null); setTokenDraft(''); }}>{t('pluginClearToken')}</button>}
        </form>
        <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">
          {t('pluginGetToken')} <FiExternalLink size={11} aria-hidden="true" />
        </a>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{t('pluginTokenStepPermissions')}</p>
      </details>
    </section>
  );
}
