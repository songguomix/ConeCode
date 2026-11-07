import { FiAlertTriangle, FiFolder, FiPlus, FiX } from 'react-icons/fi';

interface RsiFolderHintProps {
  t: (key: string) => string;
  /** Open folders, primary first. */
  paths: string[];
  /** The folder the active RSI conversation is bound to. */
  activePath: string | null;
  error: string | null;
  onAdd: () => void;
  onRemove: (path: string) => void;
  onDismissError: () => void;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * RSI's only workspace control. Unlike Work — which pairs conversations with a
 * file tree — RSI never lists files: it gets a short folder hint (which folder
 * the loop runs in), an add-folder action, and nothing else. Everything below
 * this strip belongs to the conversation list.
 */
export default function RsiFolderHint({
  t, paths, activePath, error, onAdd, onRemove, onDismissError,
}: RsiFolderHintProps) {
  return (
    <section
      aria-label={t('rsiFolders')}
      className="mx-1 mb-2 shrink-0 rounded-xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-card)_55%,transparent)] overflow-hidden"
    >
      <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1.5 min-w-0">
        <FiFolder size={12} className="shrink-0 text-amber-500" />
        <span className="flex-1 min-w-0 truncate text-[11px] font-semibold tracking-wide text-[var(--text-secondary)]">
          {t('rsiFolders')}
        </span>
        <button
          type="button"
          onClick={onAdd}
          title={t('addFolder')}
          aria-label={t('addFolder')}
          className="w-5 h-5 shrink-0 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors cursor-pointer"
        >
          <FiPlus size={12} />
        </button>
      </div>

      {paths.length === 0 ? (
        <div className="px-2.5 pb-2.5 min-w-0">
          <p className="text-[11px] leading-relaxed text-[var(--text-muted)] break-words [overflow-wrap:anywhere]">
            {t('rsiFoldersEmpty')}
          </p>
          <button
            type="button"
            onClick={onAdd}
            className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--accent-soft)] text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white transition-colors cursor-pointer"
          >
            <FiPlus size={11} />
            <span>{t('addFolder')}</span>
          </button>
        </div>
      ) : (
        <ul className="px-1.5 pb-1.5 space-y-0.5">
          {paths.map((path) => {
            const active = path === activePath;
            return (
              <li key={path}>
                <div
                  title={path}
                  aria-current={active ? 'true' : undefined}
                  className={`group flex items-center gap-1.5 px-1.5 py-1 rounded-lg min-w-0 border transition-colors ${
                    active
                      ? 'bg-[var(--accent-soft)] border-[color-mix(in_srgb,var(--accent)_25%,transparent)] text-[var(--accent)]'
                      : 'border-transparent text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_50%,transparent)]'
                  }`}
                >
                  <FiFolder size={11} className={`shrink-0 ${active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-[11.5px] font-medium">{folderName(path)}</div>
                    {active && (
                      <div className="truncate text-[9.5px] text-[var(--text-muted)]">
                        {t('rsiFolderActiveHint')}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(path)}
                    title={t('closeFolder')}
                    aria-label={`${t('closeFolder')}: ${folderName(path)}`}
                    className="shrink-0 p-0.5 rounded-md text-[var(--text-muted)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-[var(--error)] hover:bg-[var(--bg-4)] transition-all cursor-pointer"
                  >
                    <FiX size={11} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-1.5 px-2.5 py-1.5 border-t border-[var(--glass-border)] text-[10.5px] leading-relaxed text-[var(--error)] bg-[color-mix(in_srgb,var(--error)_8%,transparent)]">
          <FiAlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span className="flex-1 min-w-0 break-words [overflow-wrap:anywhere]">{error}</span>
          <button type="button" onClick={onDismissError} aria-label={t('dismiss')} className="shrink-0 p-0.5 cursor-pointer">
            <FiX size={11} />
          </button>
        </div>
      )}
    </section>
  );
}
