import { useEffect, useState } from 'react';
import {
  FiPackage, FiCheck, FiTrash2, FiDownload, FiGlobe, FiFolder, FiChevronDown, FiChevronRight, FiExternalLink,
  FiPlus, FiEdit3, FiEye, FiEyeOff,
} from 'react-icons/fi';
import { useSkillsStore, useWorkspaceStore } from '../../stores';
import type { CatalogSkill } from '../../core/skills/builtin';
import type { SkillDraft } from '../../core/skills/skills';
import SkillEditor from './SkillEditor';

/**
 * The plugin library: browse skills and deploy them to this project or to every
 * project. Installed skills are plain SKILL.md files on disk, so the panel also
 * shows where each one lives and lets it be opened and edited.
 */
export default function SkillsPanel({ t }: { t: (k: string) => string }) {
  const installed = useSkillsStore((s) => s.installed);
  const loaded = useSkillsStore((s) => s.loaded);
  const busy = useSkillsStore((s) => s.busy);
  const error = useSkillsStore((s) => s.error);
  const load = useSkillsStore((s) => s.load);
  const install = useSkillsStore((s) => s.install);
  const setEnabled = useSkillsStore((s) => s.setEnabled);
  const remove = useSkillsStore((s) => s.remove);
  const isInstalled = useSkillsStore((s) => s.isInstalled);
  const catalog = useSkillsStore((s) => s.catalog)();
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const selectFile = useWorkspaceStore((s) => s.selectFile);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCatalog, setShowCatalog] = useState(true);
  // Authoring state: null = closed, otherwise the draft being written/edited.
  const [editing, setEditing] = useState<
    { draft?: SkillDraft; id?: string; scope?: 'global' | 'project' } | null
  >(null);

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);

  return (
    <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <FiPackage size={14} className="text-[var(--accent)]" />
        <span className="font-medium text-sm">{t('skills')}</span>
        {installed.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)]">
            {installed.length}
          </span>
        )}
        <button
          onClick={() => setEditing({})}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-3)] text-[10px] font-medium text-[var(--text-secondary)] hover:text-[var(--accent)] border border-[var(--border)] hover:border-[var(--accent)] transition-colors"
        >
          <FiPlus size={10} /> {t('skillNew')}
        </button>
      </div>
      <p className="text-xs text-[var(--text-muted)] mb-3">{t('skillsHint')}</p>

      {editing && (
        <div className="mb-3">
          <SkillEditor
            t={t}
            initial={editing.draft}
            editingId={editing.id}
            editingScope={editing.scope}
            onClose={() => setEditing(null)}
          />
        </div>
      )}

      {/* ---- Installed ---- */}
      {installed.length > 0 && (
        <ul className="space-y-1 mb-3">
          {installed.map((skill) => {
            const disabled = skill.enabled === false;
            const shadowed = skill.scope === 'global'
              && installed.some((other) => other.scope === 'project' && other.id === skill.id);
            return (
            <li key={`${skill.scope}:${skill.id}`} className={`group rounded-lg bg-[var(--bg-3)]/50 px-2.5 py-1.5 ${disabled ? 'opacity-60' : ''}`}>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 text-[var(--text-muted)]" title={t(skill.scope === 'global' ? 'skillGlobal' : 'skillProject')}>
                  {skill.scope === 'global' ? <FiGlobe size={11} /> : <FiFolder size={11} />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-[var(--text-primary)]">{skill.name}</span>
                    <span className="text-[10px] font-mono text-[var(--text-muted)]">{skill.id}</span>
                    {skill.source === 'custom' && (
                      <span className="text-[9px] px-1 rounded bg-[var(--warning)]/15 text-[var(--warning)]"
                        title={t('skillCustomTip')}>
                        {t('skillCustomBadge')}
                      </span>
                    )}
                    {disabled && (
                      <span className="text-[9px] px-1 rounded bg-[var(--text-muted)]/15 text-[var(--text-muted)]">
                        {t('skillDisabled')}
                      </span>
                    )}
                    {shadowed && (
                      <span className="text-[9px] px-1 rounded bg-[var(--accent-soft)] text-[var(--accent)]"
                        title={t('skillShadowedTip')}>
                        {t('skillShadowedBadge')}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-[var(--text-muted)] leading-snug line-clamp-2">{skill.description}</p>
                </div>
                {skill.source === 'custom' && (
                  <button
                    onClick={() => setEditing({
                      draft: { name: skill.name, description: skill.description, body: skill.body, tags: skill.tags },
                      id: skill.id,
                      scope: skill.scope,
                    })}
                    title={t('skillEdit')}
                    className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] transition-all">
                    <FiEdit3 size={11} />
                  </button>
                )}
                {skill.path && (
                  <button onClick={() => selectFile(`${skill.path}/SKILL.md`)} title={t('skillOpen')}
                    className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] transition-all">
                    <FiExternalLink size={11} />
                  </button>
                )}
                <button onClick={() => setEnabled(skill, disabled)} disabled={busy === skill.id}
                  title={t(disabled ? 'skillEnable' : 'skillDisable')}
                  className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] transition-all disabled:opacity-40">
                  {disabled ? <FiEyeOff size={11} /> : <FiEye size={11} />}
                </button>
                <button onClick={() => remove(skill)} disabled={busy === skill.id} title={t('skillRemove')}
                  className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--error)] transition-all disabled:opacity-40">
                  <FiTrash2 size={11} />
                </button>
              </div>
            </li>
            );
          })}
        </ul>
      )}

      {/* ---- Library ---- */}
      <button onClick={() => setShowCatalog((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
        {showCatalog ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
        {t('skillLibrary')}
        <span className="text-[var(--text-muted)]">({catalog.length})</span>
      </button>

      {showCatalog && (
        <div className="mt-2 space-y-1">
          {catalog.map((skill) => (
            <CatalogRow
              key={skill.id}
              skill={skill}
              t={t}
              installed={isInstalled(skill.id)}
              busy={busy === skill.id}
              hasProject={!!rootPath}
              expanded={expanded === skill.id}
              onToggle={() => setExpanded(expanded === skill.id ? null : skill.id)}
              onInstall={(scope) => install(skill, scope)}
            />
          ))}
        </div>
      )}

      {error && (
        <p className="mt-2 text-[11px] text-[var(--error)]">
          {error === 'no-project' ? t('skillNeedsProject') : error}
        </p>
      )}
    </div>
  );
}

function CatalogRow({
  skill, installed, busy, hasProject, expanded, onToggle, onInstall, t,
}: {
  skill: CatalogSkill;
  installed: boolean;
  busy: boolean;
  hasProject: boolean;
  expanded: boolean;
  onToggle: () => void;
  onInstall: (scope: 'global' | 'project') => void;
  t: (k: string) => string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-3)]/30">
      <div className="flex items-start gap-2 px-2.5 py-1.5">
        <button onClick={onToggle} className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-1.5">
            {expanded ? <FiChevronDown size={11} className="text-[var(--text-muted)]" /> : <FiChevronRight size={11} className="text-[var(--text-muted)]" />}
            <span className="text-xs font-medium text-[var(--text-primary)]">{skill.name}</span>
            {installed && <FiCheck size={11} className="text-[var(--success)]" />}
          </div>
          <p className="mt-0.5 ml-4 text-[11px] text-[var(--text-muted)] leading-snug line-clamp-2">{skill.description}</p>
        </button>
        {!installed && (
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => onInstall('project')} disabled={busy || !hasProject}
              title={hasProject ? t('skillDeployProject') : t('skillNeedsProject')}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-3)] text-[10px] font-medium text-[var(--text-secondary)] hover:text-[var(--accent)] border border-[var(--border)] hover:border-[var(--accent)] transition-colors disabled:opacity-40">
              <FiFolder size={10} /> {t('skillProjectShort')}
            </button>
            <button onClick={() => onInstall('global')} disabled={busy}
              title={t('skillDeployGlobal')}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--accent)] text-[10px] font-medium text-white hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40">
              <FiDownload size={10} /> {t('skillDeploy')}
            </button>
          </div>
        )}
      </div>
      {expanded && (
        <pre className="mx-2.5 mb-2 max-h-56 overflow-y-auto rounded-lg bg-[var(--bg-0)] p-2.5 text-[10px] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)] border border-[var(--border)]">
          {skill.body}
        </pre>
      )}
    </div>
  );
}
