import { useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  FiPlus,
  FiRotateCcw,
  FiCopy,
  FiCheck,
  FiTrash2,
  FiEdit3,
  FiSearch,
  FiX,
  FiFileText,
  FiChevronDown,
  FiChevronRight,
  FiTag,
  FiLayers,
} from 'react-icons/fi';
import { usePromptStore, type CustomUserPrompt } from '../../stores/prompt.store';
import { useLanguageStore } from '../../stores/language.store';
import { BUILTIN_PROMPTS_META } from '../../core/prompt/defaultPrompts';

const CATEGORIES = [
  { id: 'all', labelKey: 'promptFilterAll', defaultLabel: '全部' },
  { id: 'custom', labelKey: 'promptFilterCustom', defaultLabel: '自定义提示词' },
  { id: 'core', labelKey: 'promptFilterCore', defaultLabel: '核心指令' },
  { id: 'mode', labelKey: 'promptFilterMode', defaultLabel: '执行模式' },
  { id: 'utility', labelKey: 'promptFilterUtility', defaultLabel: '辅助功能' },
] as const;

function IconAction({ label, onClick, children, danger = false }: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
        danger
          ? 'text-[var(--text-secondary)] hover:text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)]'
      }`}
    >
      {children}
    </button>
  );
}

export default function PromptsSettingsPanel() {
  const { t } = useLanguageStore();
  const customUserPrompts = usePromptStore((s) => s.customUserPrompts);
  const getPrompt = usePromptStore((s) => s.getPrompt);
  const setPrompt = usePromptStore((s) => s.setPrompt);
  const resetPrompt = usePromptStore((s) => s.resetPrompt);
  const resetAllPrompts = usePromptStore((s) => s.resetAllPrompts);
  const isModified = usePromptStore((s) => s.isModified);
  const hasAnyModified = usePromptStore((s) => s.hasAnyModified);
  const addCustomPrompt = usePromptStore((s) => s.addCustomPrompt);
  const updateCustomPrompt = usePromptStore((s) => s.updateCustomPrompt);
  const deleteCustomPrompt = usePromptStore((s) => s.deleteCustomPrompt);
  const toggleCustomPrompt = usePromptStore((s) => s.toggleCustomPrompt);

  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // Built-ins and existing custom prompts start collapsed so the catalog reads
  // as a list first and an editor second.
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(
    () => new Set([
      ...BUILTIN_PROMPTS_META.map((meta) => meta.key),
      ...customUserPrompts.map((prompt) => prompt.id),
    ]),
  );

  // Modal state for creating / editing custom prompts
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);
  const [customForm, setCustomForm] = useState({
    title: '',
    category: '代码规范',
    description: '',
    content: '',
    enabled: true,
  });

  const handleCopy = (key: string, content: string) => {
    navigator.clipboard.writeText(content).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 1800);
  };

  const toggleCollapse = (key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleResetAll = () => {
    if (window.confirm(t('promptResetAllConfirm'))) {
      resetAllPrompts();
    }
  };

  const handleOpenNewModal = () => {
    setEditingCustomId(null);
    setCustomForm({
      title: '',
      category: '代码规范',
      description: '',
      content: '',
      enabled: true,
    });
    setModalOpen(true);
  };

  const handleOpenEditModal = (prompt: CustomUserPrompt) => {
    setEditingCustomId(prompt.id);
    setCustomForm({
      title: prompt.title,
      category: prompt.category,
      description: prompt.description,
      content: prompt.content,
      enabled: prompt.enabled,
    });
    setModalOpen(true);
  };

  const handleSaveModal = () => {
    if (!customForm.title.trim()) return;
    if (editingCustomId) {
      updateCustomPrompt(editingCustomId, {
        title: customForm.title.trim(),
        category: customForm.category.trim(),
        description: customForm.description.trim(),
        content: customForm.content,
        enabled: customForm.enabled,
      });
    } else {
      addCustomPrompt({
        title: customForm.title.trim(),
        category: customForm.category.trim(),
        description: customForm.description.trim(),
        content: customForm.content,
        enabled: customForm.enabled,
      });
    }
    setModalOpen(false);
  };

  // Filtered built-in prompts
  const filteredBuiltin = useMemo(() => {
    return BUILTIN_PROMPTS_META.filter((meta) => {
      if (activeCategory === 'custom') return false;
      if (activeCategory !== 'all' && meta.category !== activeCategory) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      const content = getPrompt(meta.key);
      return (
        meta.defaultTitle.toLowerCase().includes(q) ||
        meta.defaultDesc.toLowerCase().includes(q) ||
        content.toLowerCase().includes(q)
      );
    });
  }, [activeCategory, searchQuery, getPrompt]);

  // Filtered custom prompts
  const filteredCustom = useMemo(() => {
    if (activeCategory !== 'all' && activeCategory !== 'custom') return [];
    if (!searchQuery.trim()) return customUserPrompts;
    const q = searchQuery.toLowerCase();
    return customUserPrompts.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.content.toLowerCase().includes(q),
    );
  }, [activeCategory, searchQuery, customUserPrompts]);

  const anyModified = hasAnyModified();
  const allBuiltinsCollapsed = filteredBuiltin.length > 0
    && filteredBuiltin.every((meta) => collapsedKeys.has(meta.key));

  // Built-in prompt keys may not exist in every locale; fall back to the
  // authored Chinese title/description instead of rendering the raw key.
  const translate = (key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  };

  const toggleAllBuiltins = () => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (allBuiltinsCollapsed) filteredBuiltin.forEach((meta) => next.delete(meta.key));
      else filteredBuiltin.forEach((meta) => next.add(meta.key));
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 overflow-hidden">
      {/* Compact toolbar: search, create, reset, then category filters. */}
      <div className="shrink-0 px-3 sm:px-4 py-2.5 space-y-2 border-b border-[color-mix(in_srgb,var(--border)_70%,transparent)] bg-[color-mix(in_srgb,var(--bg-1)_55%,transparent)]">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <FiSearch size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('promptSearchPlaceholder')}
              aria-label={t('promptSearchPlaceholder')}
              className="search-input w-full h-8 bg-[var(--bg-2)] border border-[var(--border)] rounded-xl pl-8 pr-8 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] transition-all"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label={t('clear')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              >
                <FiX size={12} />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={handleOpenNewModal}
            className="inline-flex items-center gap-1.5 h-8 px-2.5 sm:px-3 rounded-xl bg-[var(--accent)] text-white text-[11.5px] font-semibold hover:bg-[var(--accent-hover)] shadow-2xs transition-colors shrink-0 cursor-pointer"
          >
            <FiPlus size={13} />
            <span className="hidden sm:inline">{t('promptNewButton')}</span>
          </button>

          <button
            type="button"
            onClick={handleResetAll}
            disabled={!anyModified}
            title={anyModified ? t('promptResetAllHint') : t('promptAllDefaultHint')}
            className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-xl text-[11.5px] font-medium border transition-colors shrink-0 ${
              anyModified
                ? 'bg-[var(--bg-2)] text-amber-500 hover:bg-[var(--bg-3)] border-amber-500/30 shadow-2xs cursor-pointer'
                : 'bg-[color-mix(in_srgb,var(--bg-2)_50%,transparent)] text-[var(--text-muted)] border-transparent opacity-50 cursor-not-allowed'
            }`}
          >
            <FiRotateCcw size={12} />
            <span className="hidden lg:inline">{t('promptResetAll')}</span>
          </button>
        </div>

        <div className="flex items-center gap-2 min-w-0">
          <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto p-0.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)]">
            {CATEGORIES.map((cat) => {
              const active = activeCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setActiveCategory(cat.id)}
                  aria-pressed={active}
                  className={`shrink-0 inline-flex items-center whitespace-nowrap px-2.5 py-1 rounded-lg text-[11.5px] font-medium transition-all cursor-pointer ${
                    active
                      ? 'bg-[var(--bg-2)] text-[var(--accent)] shadow-xs font-semibold border border-[color-mix(in_srgb,var(--border)_70%,transparent)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--bg-2)_50%,transparent)] border border-transparent'
                  }`}
                >
                  {t(cat.labelKey) || cat.defaultLabel}
                  {cat.id === 'custom' && customUserPrompts.length > 0 && (
                    <span className={`ml-1 rounded-full px-1.5 text-[9.5px] font-semibold ${
                      active ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--bg-3)] text-[var(--text-muted)]'
                    }`}>
                      {customUserPrompts.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Prompts Content Area (Scrollable) */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 py-3.5 space-y-5">
        {/* Section A: Custom User Prompts */}
        {(activeCategory === 'all' || activeCategory === 'custom') && (
          <section className="space-y-2.5" aria-labelledby="custom-prompts-heading">
            <div className="flex items-center justify-between gap-2 px-0.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-6 h-6 rounded-lg flex items-center justify-center bg-[var(--accent-soft)] text-[var(--accent)] shrink-0">
                  <FiLayers size={12} />
                </span>
                <h5 id="custom-prompts-heading" className="text-[12.5px] font-bold text-[var(--text-primary)] truncate">
                  {t('promptCustomSectionTitle')}
                </h5>
                <span className="text-[10.5px] px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-secondary)] font-semibold border border-[var(--border)]">
                  {customUserPrompts.length}
                </span>
              </div>
              <button
                type="button"
                onClick={handleOpenNewModal}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors shrink-0 cursor-pointer"
              >
                <FiPlus size={12} />
                <span>{t('promptNewCustom')}</span>
              </button>
            </div>

            {filteredCustom.length === 0 ? (
              <div className="flex items-center gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-1)_45%,transparent)] px-4 py-4">
                <div className="w-9 h-9 rounded-xl bg-[var(--bg-2)] text-[var(--text-muted)] flex items-center justify-center shrink-0">
                  <FiLayers size={15} />
                </div>
                <p className="min-w-0 flex-1 text-[11.5px] text-[var(--text-muted)] leading-relaxed">
                  {customUserPrompts.length === 0 ? t('promptCustomEmptyTip') : t('promptNoSearchMatch')}
                </p>
                {customUserPrompts.length === 0 && (
                  <button
                    type="button"
                    onClick={handleOpenNewModal}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-[var(--bg-2)] hover:bg-[var(--bg-3)] border border-[var(--border)] text-[11px] text-[var(--accent)] font-medium transition-colors shrink-0 cursor-pointer"
                  >
                    <FiPlus size={12} />
                    <span>{t('promptCreateFirst')}</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {filteredCustom.map((cp) => {
                  const isCollapsed = collapsedKeys.has(cp.id);
                  return (
                    <div
                      key={cp.id}
                      className="group overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] shadow-2xs transition-colors hover:border-[color-mix(in_srgb,var(--accent)_35%,var(--border))]"
                    >
                      <div className="flex items-start gap-2 p-3">
                        <button
                          type="button"
                          onClick={() => toggleCollapse(cp.id)}
                          aria-expanded={!isCollapsed}
                          aria-label={isCollapsed ? t('promptExpand') : t('promptCollapse')}
                          className="mt-0.5 p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors shrink-0 cursor-pointer"
                        >
                          {isCollapsed ? <FiChevronRight size={14} /> : <FiChevronDown size={14} />}
                        </button>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                            <span className="max-w-full truncate text-[13px] font-bold text-[var(--text-primary)] font-serif" title={cp.title}>
                              {cp.title}
                            </span>
                            <button
                              type="button"
                              onClick={() => toggleCustomPrompt(cp.id)}
                              title={cp.enabled ? t('promptCustomEnableDesc') : t('promptCustomEnableLabel')}
                              className={`px-1.5 py-0.5 rounded-full text-[9.5px] font-semibold border transition-colors cursor-pointer ${
                                cp.enabled
                                  ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)] border-[color-mix(in_srgb,var(--success)_30%,transparent)]'
                                  : 'bg-[var(--bg-3)] text-[var(--text-muted)] border-[var(--border)]'
                              }`}
                            >
                              {cp.enabled ? t('enabled') : t('disabled')}
                            </button>
                            {cp.category && (
                              <span className="max-w-full truncate text-[9.5px] px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-secondary)] border border-[var(--border)]">
                                {cp.category}
                              </span>
                            )}
                          </div>
                          {cp.description && (
                            <p className="mt-1 text-[11px] text-[var(--text-muted)] leading-relaxed line-clamp-1">{cp.description}</p>
                          )}
                          {isCollapsed && (
                            <p className="mt-1.5 font-mono text-[11px] text-[var(--text-muted)] leading-relaxed line-clamp-2 whitespace-pre-wrap">
                              {cp.content.trim() || '—'}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-0.5 shrink-0">
                          <IconAction label={t('promptCopy')} onClick={() => handleCopy(cp.id, cp.content)}>
                            {copiedKey === cp.id ? <FiCheck size={13} className="text-[var(--success)]" /> : <FiCopy size={13} />}
                          </IconAction>
                          <IconAction label={t('promptEditCustomTitle')} onClick={() => handleOpenEditModal(cp)}>
                            <FiEdit3 size={13} />
                          </IconAction>
                          <IconAction
                            label={t('delete')}
                            danger
                            onClick={() => {
                              if (window.confirm(t('promptDeleteCustomConfirm').replace('{title}', cp.title))) {
                                deleteCustomPrompt(cp.id);
                              }
                            }}
                          >
                            <FiTrash2 size={13} />
                          </IconAction>
                        </div>
                      </div>

                      {!isCollapsed && (
                        <div className="px-3 pb-3 pt-2.5 space-y-1.5 border-t border-[color-mix(in_srgb,var(--border)_60%,transparent)]">
                          <textarea
                            value={cp.content}
                            onChange={(e) => updateCustomPrompt(cp.id, { content: e.target.value })}
                            placeholder={t('promptCustomContentPlaceholder')}
                            spellCheck={false}
                            rows={5}
                            className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl p-2.5 text-xs font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[color-mix(in_srgb,var(--accent)_30%,transparent)] resize-y leading-relaxed"
                          />
                          <div className="flex items-center justify-between gap-2 px-1 text-[10.5px] text-[var(--text-muted)]">
                            <span>{cp.content.length} {t('promptChars')}</span>
                            <span>{t('promptAutoSaveHint')}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Section B: Built-in System Prompts */}
        {activeCategory !== 'custom' && (
          <section className="space-y-2.5" aria-labelledby="builtin-prompts-heading">
            <div className="flex items-center justify-between gap-2 px-0.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-6 h-6 rounded-lg flex items-center justify-center bg-[var(--bg-3)] text-[var(--text-secondary)] shrink-0">
                  <FiFileText size={12} />
                </span>
                <h5 id="builtin-prompts-heading" className="text-[12.5px] font-bold text-[var(--text-primary)] truncate">
                  {t('promptBuiltinSectionTitle')}
                </h5>
                <span className="text-[10.5px] px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-secondary)] font-semibold border border-[var(--border)]">
                  {filteredBuiltin.length}
                </span>
              </div>
              {filteredBuiltin.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAllBuiltins}
                  className="px-2 py-1 rounded-lg text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors shrink-0 cursor-pointer"
                >
                  {allBuiltinsCollapsed ? t('promptExpandAll') : t('promptCollapseAll')}
                </button>
              )}
            </div>

            {filteredBuiltin.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-1)_45%,transparent)] px-4 py-6 text-center">
                <FiSearch size={18} className="mx-auto mb-2 text-[var(--text-muted)]" />
                <p className="text-xs font-semibold text-[var(--text-secondary)]">{t('promptEmptyTitle')}</p>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">{t('promptEmptyDesc')}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredBuiltin.map((meta) => {
                  const content = getPrompt(meta.key);
                  const modified = isModified(meta.key);
                  const isCollapsed = collapsedKeys.has(meta.key);
                  return (
                    <div
                      key={meta.key}
                      className={`overflow-hidden rounded-2xl border bg-[var(--bg-2)] shadow-2xs transition-colors ${
                        modified
                          ? 'border-amber-500/40'
                          : 'border-[var(--border)] hover:border-[color-mix(in_srgb,var(--accent)_30%,var(--border))]'
                      }`}
                    >
                      <div className="flex items-start gap-2 p-3">
                        <button
                          type="button"
                          onClick={() => toggleCollapse(meta.key)}
                          aria-expanded={!isCollapsed}
                          aria-label={isCollapsed ? t('promptExpand') : t('promptCollapse')}
                          className="mt-0.5 p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors shrink-0 cursor-pointer"
                        >
                          {isCollapsed ? <FiChevronRight size={14} /> : <FiChevronDown size={14} />}
                        </button>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="max-w-full truncate text-[13px] font-bold text-[var(--text-primary)] font-serif" title={translate(meta.titleKey, meta.defaultTitle)}>
                              {translate(meta.titleKey, meta.defaultTitle)}
                            </span>
                            <span
                              className={`text-[9.5px] px-1.5 py-0.5 rounded-full font-semibold border ${
                                modified
                                  ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
                                  : 'bg-[var(--bg-3)] text-[var(--text-muted)] border-[var(--border)]'
                              }`}
                            >
                              {modified ? t('promptModifiedBadge') : t('promptDefaultBadge')}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-[var(--text-muted)] leading-relaxed line-clamp-1">
                            {translate(meta.descKey, meta.defaultDesc)}
                          </p>
                        </div>

                        <div className="flex items-center gap-0.5 shrink-0">
                          {modified && (
                            <button
                              type="button"
                              onClick={() => resetPrompt(meta.key)}
                              title={t('promptResetThisHint')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10.5px] font-medium bg-amber-500/10 text-amber-500 hover:bg-amber-500/15 border border-amber-500/25 transition-colors cursor-pointer"
                            >
                              <FiRotateCcw size={10} />
                              <span className="hidden md:inline">{t('promptResetThis')}</span>
                            </button>
                          )}
                          <IconAction label={t('promptCopy')} onClick={() => handleCopy(meta.key, content)}>
                            {copiedKey === meta.key ? <FiCheck size={13} className="text-[var(--success)]" /> : <FiCopy size={13} />}
                          </IconAction>
                        </div>
                      </div>

                      {!isCollapsed && (
                        <div className="px-3 pb-3 pt-2.5 space-y-1.5 border-t border-[color-mix(in_srgb,var(--border)_60%,transparent)]">
                          <textarea
                            value={content}
                            onChange={(e) => setPrompt(meta.key, e.target.value)}
                            spellCheck={false}
                            rows={7}
                            className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl p-3 text-xs font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[color-mix(in_srgb,var(--accent)_30%,transparent)] resize-y leading-relaxed"
                          />
                          <div className="flex items-center justify-between gap-2 px-1 text-[10.5px] text-[var(--text-muted)]">
                            <span>
                              {content.length} {t('promptChars')} · {content.split('\n').length} {t('promptLines')}
                            </span>
                            {modified ? (
                              <span className="text-amber-500 font-medium">✓ {t('promptLiveEffective')}</span>
                            ) : (
                              <span>{t('promptAutoSaveHint')}</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>

      {/* Modal Dialog for New / Edit Custom Prompt */}
      {modalOpen && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) setModalOpen(false);
          }}
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 anim-scrim"
        >
          <div className="w-[560px] max-w-[calc(100vw-32px)] max-h-[calc(100dvh-32px)] overflow-y-auto bg-[var(--bg-0)] border border-[var(--border)] rounded-2xl shadow-2xl p-4 sm:p-5 space-y-4 anim-modal ring-1 ring-black/10">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] pb-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-8 h-8 rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center shrink-0">
                  <FiTag size={15} />
                </span>
                <div className="min-w-0">
                  <h4 className="text-[15px] font-bold text-[var(--text-primary)] font-serif truncate">
                    {editingCustomId ? t('promptEditModalTitle') : t('promptNewModalTitle')}
                  </h4>
                  <p className="text-[11px] text-[var(--text-muted)] truncate">{t('promptAutoSaveHint')}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                title={t('close')}
                aria-label={t('close')}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)] transition-colors shrink-0 cursor-pointer"
              >
                <FiX size={15} />
              </button>
            </div>

            <div className="space-y-3.5 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                    {t('promptNameLabel')}
                  </label>
                  <input
                    type="text"
                    value={customForm.title}
                    onChange={(e) => setCustomForm((f) => ({ ...f, title: e.target.value }))}
                    placeholder={t('promptCustomTitlePlaceholder')}
                    className="w-full h-9 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                    {t('promptCategoryLabel')}
                  </label>
                  <input
                    type="text"
                    value={customForm.category}
                    onChange={(e) => setCustomForm((f) => ({ ...f, category: e.target.value }))}
                    placeholder={t('promptCustomCategoryPlaceholder')}
                    className="w-full h-9 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                  {t('promptDescLabel')}
                </label>
                <input
                  type="text"
                  value={customForm.description}
                  onChange={(e) => setCustomForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder={t('promptCustomDescPlaceholder')}
                  className="w-full h-9 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors"
                />
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="block text-[11px] font-semibold text-[var(--text-secondary)]">
                    {t('promptContentLabel')}
                  </label>
                  <span className="text-[10.5px] text-[var(--text-muted)]">{customForm.content.length} {t('promptChars')}</span>
                </div>
                <textarea
                  value={customForm.content}
                  onChange={(e) => setCustomForm((f) => ({ ...f, content: e.target.value }))}
                  placeholder={t('promptCustomContentPlaceholder')}
                  rows={7}
                  className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl p-3 text-xs font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[color-mix(in_srgb,var(--accent)_30%,transparent)] resize-y leading-relaxed"
                />
              </div>

              <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)]">
                <span className="min-w-0">
                  <span className="block text-[11.5px] font-semibold text-[var(--text-primary)]">{t('promptCustomEnableLabel')}</span>
                  <span className="block mt-0.5 text-[10.5px] text-[var(--text-muted)] leading-relaxed">{t('promptCustomEnableDesc')}</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={customForm.enabled}
                  aria-label={t('promptCustomEnableLabel')}
                  onClick={() => setCustomForm((f) => ({ ...f, enabled: !f.enabled }))}
                  className={`relative w-9 h-5 rounded-full transition-colors shrink-0 cursor-pointer ${
                    customForm.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--bg-4)]'
                  }`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                    customForm.enabled ? 'left-[18px]' : 'left-0.5'
                  }`} />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-[var(--border)]">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-2)] transition-all cursor-pointer"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                disabled={!customForm.title.trim()}
                onClick={handleSaveModal}
                className="px-4 py-2 rounded-xl bg-[var(--accent)] text-white text-xs font-semibold hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer shadow-2xs"
              >
                {t('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
