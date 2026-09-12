import { useState } from 'react';
import { FiAlertTriangle, FiSave, FiUpload, FiX } from 'react-icons/fi';
import { useSettingsStore, useSkillsStore, useWorkspaceStore } from '../../stores';
import { draftFromMarkdown, validateDraft, draftHasErrors, type SkillDraft } from '../../core/skills/skills';

/**
 * Write or edit a skill by hand.
 *
 * A skill is instructions the agent will follow, so a custom one is exactly as
 * trustworthy as whoever wrote it. ConeCode does not review them — the risk
 * notice below is shown once, acknowledged explicitly, and the skill is labelled
 * as custom forever after. Approval mode and the command sandbox still apply to
 * anything a skill actually asks the agent to DO.
 */
export default function SkillEditor({
  t, initial, editingId, editingScope, onClose,
}: {
  t: (k: string) => string;
  initial?: SkillDraft;
  editingId?: string;
  editingScope?: 'global' | 'project';
  onClose: () => void;
}) {
  const saveCustom = useSkillsStore((s) => s.saveCustom);
  const busy = useSkillsStore((s) => s.busy);
  const storeError = useSkillsStore((s) => s.error);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const acknowledged = useSettingsStore((s) => s.customSkillsAcknowledged);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const [draft, setDraft] = useState<SkillDraft>(initial || { name: '', description: '', body: '' });
  const [scope, setScope] = useState<'global' | 'project'>(editingScope || (rootPath ? 'project' : 'global'));
  const [touched, setTouched] = useState(false);
  const [importError, setImportError] = useState(false);

  const errors = validateDraft(draft);
  const invalid = draftHasErrors(errors);

  // The gate: nothing can be authored until the risk is acknowledged once.
  if (!acknowledged) {
    return (
      <div className="rounded-xl border border-[var(--warning)]/50 bg-[var(--warning)]/5 p-4">
        <div className="flex items-center gap-2 mb-2">
          <FiAlertTriangle size={14} className="text-[var(--warning)]" />
          <span className="text-sm font-semibold text-[var(--text-primary)]">{t('skillRiskTitle')}</span>
        </div>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{t('skillRiskBody')}</p>
        <p className="mt-1.5 text-xs text-[var(--text-muted)] leading-relaxed">{t('skillRiskStillApplies')}</p>
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => updateSettings({ customSkillsAcknowledged: true })}
            className="px-3 py-1.5 rounded-lg bg-[var(--warning)]/20 border border-[var(--warning)]/40 text-xs font-semibold text-[var(--warning)] hover:bg-[var(--warning)]/30"
          >
            {t('skillRiskAccept')}
          </button>
          <button onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-[var(--bg-3)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-4)]">
            {t('cancel')}
          </button>
        </div>
      </div>
    );
  }

  const importFile = async () => {
    setImportError(false);
    try {
      const paths = await window.electronAPI.dialog.openFile();
      const file = paths?.[0];
      if (!file) return;
      const raw = await window.electronAPI.fs.readFile(file);
      const imported = raw ? draftFromMarkdown(raw) : null;
      if (!imported) { setImportError(true); return; }
      setDraft(imported);
    } catch {
      setImportError(true);
    }
  };

  const save = async () => {
    setTouched(true);
    if (invalid) return;
    if (await saveCustom(draft, scope, editingId)) onClose();
  };

  const field = 'w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-3)] border text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';
  const border = (bad?: string) => (touched && bad ? 'border-[var(--error)]' : 'border-[var(--border)]');

  return (
    <div className="rounded-xl border border-[var(--accent)]/40 bg-[var(--bg-2)] p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-[var(--text-primary)]">
          {editingId ? t('skillEdit') : t('skillNew')}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--warning)]/15 text-[var(--warning)]">
          {t('skillCustomBadge')}
        </span>
        <button onClick={importFile}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-3)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] border border-[var(--border)]">
          <FiUpload size={10} /> {t('skillImport')}
        </button>
        <button onClick={onClose} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          <FiX size={13} />
        </button>
      </div>

      <div>
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={t('skillNamePlaceholder')}
          className={`${field} ${border(errors.name)}`}
        />
        {touched && errors.name && <p className="mt-0.5 text-[10px] text-[var(--error)]">{t('skillNameError')}</p>}
      </div>

      <div>
        <input
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder={t('skillDescPlaceholder')}
          className={`${field} ${border(errors.description)}`}
        />
        <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">{t('skillDescHint')}</p>
        {touched && errors.description && <p className="text-[10px] text-[var(--error)]">{t('skillDescError')}</p>}
      </div>

      <div>
        <textarea
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          placeholder={t('skillBodyPlaceholder')}
          rows={10}
          spellCheck={false}
          className={`${field} ${border(errors.body)} font-mono resize-y leading-relaxed`}
        />
        {touched && errors.body && <p className="text-[10px] text-[var(--error)]">{t('skillBodyError')}</p>}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          {(['project', 'global'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              disabled={!!editingId || (s === 'project' && !rootPath)}
              className={`px-2 py-1 rounded-lg text-[10px] font-medium border transition-colors disabled:opacity-40 ${
                scope === s
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent)]'
                  : 'bg-[var(--bg-3)] text-[var(--text-secondary)] border-[var(--border)]'
              }`}
            >
              {t(s === 'project' ? 'skillProjectShort' : 'skillGlobalShort')}
            </button>
          ))}
        </div>
        <button onClick={save} disabled={!!busy}
          className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40">
          <FiSave size={11} /> {t('save')}
        </button>
      </div>

      {importError && <p className="text-[10px] text-[var(--error)]">{t('skillImportError')}</p>}
      {storeError === 'already-exists' && <p className="text-[10px] text-[var(--error)]">{t('skillExists')}</p>}
      {storeError === 'no-project' && <p className="text-[10px] text-[var(--error)]">{t('skillNeedsProject')}</p>}
    </div>
  );
}
