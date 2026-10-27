import { useState, useMemo } from 'react';
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
  FiChevronUp,
  FiCheckCircle,
  FiTag,
  FiLayers,
} from 'react-icons/fi';
import { usePromptStore, type CustomUserPrompt } from '../../stores/prompt.store';
import { useLanguageStore } from '../../stores/language.store';
import {
  type BuiltinPromptKey,
  BUILTIN_PROMPTS_META,
  type PromptMeta,
} from '../../core/prompt/defaultPrompts';

const CATEGORIES = [
  { id: 'all', labelKey: 'promptFilterAll', defaultLabel: '全部' },
  { id: 'custom', labelKey: 'promptFilterCustom', defaultLabel: '自定义提示词' },
  { id: 'core', labelKey: 'promptFilterCore', defaultLabel: '核心指令' },
  { id: 'mode', labelKey: 'promptFilterMode', defaultLabel: '执行模式' },
  { id: 'utility', labelKey: 'promptFilterUtility', defaultLabel: '辅助功能' },
] as const;

export default function PromptsSettingsPanel() {
  const { t } = useLanguageStore();
  const overrides = usePromptStore((s) => s.overrides);
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
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() => new Set());

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
    if (window.confirm(t('promptResetAllConfirm') || '确定要将所有已修改的内置提示词一键恢复为系统默认吗？此操作不影响自定义提示词。')) {
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top Header & Actions Toolbar */}
      <div className="p-4 border-b border-[var(--border)]/70 bg-[var(--bg-1)]/50 shrink-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-[14px] font-bold text-[var(--text-primary)] font-serif">
              {t('promptSettingsTitle') || '提示词管理与自定义'}
            </h4>
            <p className="text-[11.5px] text-[var(--text-muted)] mt-0.5">
              {t('promptSettingsSubtitle') ||
                '所有系统提示词均已整理成独立编辑框，可自行微调优化，也可一键恢复默认或新建专属提示词。'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* New custom prompt button */}
            <button
              onClick={handleOpenNewModal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#e88a6a] text-white text-xs font-semibold hover:opacity-95 shadow-2xs transition-all cursor-pointer"
            >
              <FiPlus size={13} />
              <span>{t('promptNewButton') || '新建提示词'}</span>
            </button>

            {/* Reset all prompts button */}
            <button
              onClick={handleResetAll}
              disabled={!anyModified}
              title={anyModified ? (t('promptResetAllHint') || '将所有已修改的内置提示词重置为初始默认') : (t('promptAllDefaultHint') || '当前所有内置提示词均为默认状态')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                anyModified
                  ? 'bg-[var(--bg-2)] text-amber-500 hover:text-amber-600 hover:bg-[var(--bg-3)] border-amber-500/30 cursor-pointer shadow-2xs'
                  : 'bg-[var(--bg-2)]/50 text-[var(--text-muted)] border-transparent opacity-50 cursor-not-allowed'
              }`}
            >
              <FiRotateCcw size={12} />
              <span>{t('promptResetAll') || '一键恢复所有默认'}</span>
            </button>
          </div>
        </div>

        {/* Search bar & Category filters */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <div className="relative flex-1 min-w-[200px]">
            <FiSearch size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('promptSearchPlaceholder') || '搜索提示词名称、描述或正文关键词...'}
              className="w-full bg-[var(--bg-2)] border border-[var(--border)] rounded-xl pl-8 pr-7 py-1.5 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <FiX size={12} />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0 overflow-x-auto py-0.5">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                  activeCategory === cat.id
                    ? 'bg-[var(--accent)] text-white shadow-2xs font-semibold'
                    : 'bg-[var(--bg-2)] text-[var(--text-secondary)] hover:bg-[var(--bg-3)] hover:text-[var(--text-primary)] border border-[var(--border)]/70'
                }`}
              >
                {t(cat.labelKey) || cat.defaultLabel}
                {cat.id === 'custom' && customUserPrompts.length > 0 && (
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-white/20 text-white">
                    {customUserPrompts.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Prompts Content Area (Scrollable) */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Section A: Custom User Prompts */}
        {(activeCategory === 'all' || activeCategory === 'custom') && (
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <FiLayers size={14} className="text-[var(--accent)]" />
                <h5 className="text-[13px] font-bold text-[var(--text-primary)]">
                  {t('promptCustomSectionTitle') || '我的自定义提示词'}
                </h5>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-semibold border border-[var(--accent)]/30">
                  {customUserPrompts.length}
                </span>
              </div>
              <button
                onClick={handleOpenNewModal}
                className="text-xs text-[var(--accent)] hover:underline flex items-center gap-1 font-medium cursor-pointer"
              >
                <FiPlus size={12} />
                <span>{t('promptNewCustom') || '添加一条'}</span>
              </button>
            </div>

            {filteredCustom.length === 0 ? (
              <div className="border border-dashed border-[var(--border)] rounded-2xl p-5 text-center bg-[var(--bg-1)]/40">
                <p className="text-xs text-[var(--text-muted)]">
                  {customUserPrompts.length === 0
                    ? (t('promptCustomEmptyTip') || '暂无自定义提示词。点击“新建提示词”创建专属的人设角色、项目编码规范或指令模版。')
                    : (t('promptNoSearchMatch') || '没有找到匹配的自定义提示词。')}
                </p>
                {customUserPrompts.length === 0 && (
                  <button
                    onClick={handleOpenNewModal}
                    className="mt-2.5 inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[var(--bg-2)] hover:bg-[var(--bg-3)] border border-[var(--border)] text-xs text-[var(--accent)] font-medium transition-all cursor-pointer"
                  >
                    <FiPlus size={12} />
                    <span>{t('promptCreateFirst') || '立即创建第一条'}</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3.5">
                {filteredCustom.map((cp) => (
                  <div
                    key={cp.id}
                    className="border border-[var(--border)] rounded-2xl p-3.5 bg-[var(--bg-2)] shadow-2xs hover:border-[var(--border)]/80 transition-all space-y-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {/* Enabled switch pill */}
                        <button
                          onClick={() => toggleCustomPrompt(cp.id)}
                          title={cp.enabled ? '已启用（将注入智能体上下文）' : '已停用'}
                          className={`px-2 py-0.5 rounded-full text-[10.5px] font-semibold border transition-all cursor-pointer ${
                            cp.enabled
                              ? 'bg-[var(--success)]/15 text-[var(--success)] border-[var(--success)]/30'
                              : 'bg-[var(--bg-3)] text-[var(--text-muted)] border-[var(--border)]'
                          }`}
                        >
                          {cp.enabled ? (t('enabled') || '已启用') : (t('disabled') || '已停用')}
                        </button>
                        <span className="font-bold text-[13px] text-[var(--text-primary)] truncate font-serif">
                          {cp.title}
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-secondary)] border border-[var(--border)] shrink-0">
                          {cp.category}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => handleCopy(cp.id, cp.content)}
                          title="复制提示词正文"
                          className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer"
                        >
                          {copiedKey === cp.id ? <FiCheck size={13} className="text-[var(--success)]" /> : <FiCopy size={13} />}
                        </button>
                        <button
                          onClick={() => handleOpenEditModal(cp)}
                          title="编辑提示词"
                          className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer"
                        >
                          <FiEdit3 size={13} />
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`确定要删除自定义提示词“${cp.title}”吗？`)) {
                              deleteCustomPrompt(cp.id);
                            }
                          }}
                          title="删除"
                          className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--error)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer"
                        >
                          <FiTrash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {cp.description && (
                      <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">
                        {cp.description}
                      </p>
                    )}

                    <textarea
                      value={cp.content}
                      onChange={(e) => updateCustomPrompt(cp.id, { content: e.target.value })}
                      placeholder="在此输入自定义提示词正文..."
                      spellCheck={false}
                      rows={4}
                      className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl p-2.5 text-xs font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]/30 resize-y leading-relaxed shadow-inner"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Section B: Built-in System Prompts */}
        {activeCategory !== 'custom' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between px-1 border-t border-[var(--border)]/60 pt-4">
              <div className="flex items-center gap-2">
                <FiFileText size={14} className="text-[var(--text-muted)]" />
                <h5 className="text-[13px] font-bold text-[var(--text-primary)]">
                  {t('promptBuiltinSectionTitle') || '内置系统提示词'}
                </h5>
                <span className="text-[11px] text-[var(--text-muted)]">
                  ({filteredBuiltin.length} 项)
                </span>
              </div>
              <span className="text-[11px] text-[var(--text-muted)]">
                {t('promptAutoSaveHint') || '修改后即时自动保存并全局生效'}
              </span>
            </div>

            {filteredBuiltin.length === 0 ? (
              <div className="border border-dashed border-[var(--border)] rounded-2xl p-5 text-center bg-[var(--bg-1)]/40">
                <p className="text-xs text-[var(--text-muted)]">
                  {t('promptNoSearchMatch') || '没有找到匹配的内置提示词。'}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {filteredBuiltin.map((meta) => {
                  const content = getPrompt(meta.key);
                  const modified = isModified(meta.key);
                  const isCollapsed = collapsedKeys.has(meta.key);
                  return (
                    <div
                      key={meta.key}
                      className={`border rounded-2xl p-4 transition-all shadow-2xs space-y-3 ${
                        modified
                          ? 'bg-[var(--bg-2)] border-amber-500/40 shadow-xs'
                          : 'bg-[var(--bg-2)] border-[var(--border)] hover:border-[var(--border)]/90'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <button
                            onClick={() => toggleCollapse(meta.key)}
                            className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] cursor-pointer"
                            title={isCollapsed ? '展开编辑框' : '折叠'}
                          >
                            {isCollapsed ? <FiChevronDown size={14} /> : <FiChevronUp size={14} />}
                          </button>
                          <span className="font-bold text-[13.5px] text-[var(--text-primary)] truncate font-serif">
                            {t(meta.titleKey) || meta.defaultTitle}
                          </span>
                          <span
                            className={`text-[10.5px] px-2 py-0.5 rounded-full font-semibold border ${
                              modified
                                ? 'bg-amber-500/15 text-amber-500 border-amber-500/30'
                                : 'bg-[var(--bg-3)] text-[var(--text-muted)] border-[var(--border)]'
                            }`}
                          >
                            {modified ? (t('promptModifiedBadge') || '已自定义') : (t('promptDefaultBadge') || '系统默认')}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {modified && (
                            <button
                              onClick={() => resetPrompt(meta.key)}
                              title={t('promptResetThisHint') || '将此提示词恢复为系统初始默认'}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 border border-amber-500/30 transition-all cursor-pointer"
                            >
                              <FiRotateCcw size={11} />
                              <span>{t('promptResetThis') || '恢复默认'}</span>
                            </button>
                          )}
                          <button
                            onClick={() => handleCopy(meta.key, content)}
                            title="复制提示词正文"
                            className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer"
                          >
                            {copiedKey === meta.key ? <FiCheck size={13} className="text-[var(--success)]" /> : <FiCopy size={13} />}
                          </button>
                        </div>
                      </div>

                      <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">
                        {t(meta.descKey) || meta.defaultDesc}
                      </p>

                      {!isCollapsed && (
                        <div className="space-y-1.5">
                          <textarea
                            value={content}
                            onChange={(e) => setPrompt(meta.key, e.target.value)}
                            spellCheck={false}
                            rows={8}
                            className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl p-3 text-xs font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]/30 resize-y leading-relaxed shadow-inner"
                          />
                          <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] px-1">
                            <span>
                              {content.length} {t('promptChars') || '字符'} · {content.split('\n').length} {t('promptLines') || '行'}
                            </span>
                            {modified && (
                              <span className="text-amber-500 font-medium">
                                ✓ {t('promptLiveEffective') || '已保存并实时生效'}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
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
          <div className="w-[540px] max-w-[calc(100vw-32px)] bg-[var(--bg-0)] border border-[var(--border)] rounded-2xl shadow-2xl p-5 space-y-4 anim-modal ring-1 ring-black/10">
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
              <div className="flex items-center gap-2">
                <FiTag className="text-[var(--accent)]" size={16} />
                <h4 className="text-[15px] font-bold text-[var(--text-primary)] font-serif">
                  {editingCustomId ? (t('promptEditModalTitle') || '编辑提示词') : (t('promptNewModalTitle') || '新建提示词')}
                </h4>
              </div>
              <button
                onClick={() => setModalOpen(false)}
                className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)]"
              >
                <FiX size={15} />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1">
                  {t('promptNameLabel') || '提示词名称 *'}
                </label>
                <input
                  type="text"
                  value={customForm.title}
                  onChange={(e) => setCustomForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="例如：React 19 & Tailwind 规范、极端防御性编程..."
                  className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1">
                    {t('promptCategoryLabel') || '分类类别'}
                  </label>
                  <input
                    type="text"
                    value={customForm.category}
                    onChange={(e) => setCustomForm((f) => ({ ...f, category: e.target.value }))}
                    placeholder="代码规范 / 系统人设 / 任务指令..."
                    className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1">
                    {t('promptEnabledStatus') || '默认启用状态'}
                  </label>
                  <button
                    type="button"
                    onClick={() => setCustomForm((f) => ({ ...f, enabled: !f.enabled }))}
                    className={`w-full py-2 px-3 rounded-xl border text-xs font-semibold text-center transition-all cursor-pointer ${
                      customForm.enabled
                        ? 'bg-[var(--success)]/15 text-[var(--success)] border-[var(--success)]/40'
                        : 'bg-[var(--bg-2)] text-[var(--text-muted)] border-[var(--border)]'
                    }`}
                  >
                    {customForm.enabled ? '✓ 已启用（生效）' : '✕ 已停用（草稿）'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1">
                  {t('promptDescLabel') || '功能描述与适用场景 (选填)'}
                </label>
                <input
                  type="text"
                  value={customForm.description}
                  onChange={(e) => setCustomForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="说明此提示词的适用范围或作用..."
                  className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1">
                  {t('promptContentLabel') || '提示词正文内容 *'}
                </label>
                <textarea
                  value={customForm.content}
                  onChange={(e) => setCustomForm((f) => ({ ...f, content: e.target.value }))}
                  placeholder="在此写入完整的提示词指令内容..."
                  rows={7}
                  className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl p-3 text-xs font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)] resize-y leading-relaxed"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-[var(--border)]">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-2)] transition-all cursor-pointer"
              >
                {t('cancel') || '取消'}
              </button>
              <button
                type="button"
                disabled={!customForm.title.trim()}
                onClick={handleSaveModal}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#e88a6a] text-white text-xs font-semibold hover:opacity-95 disabled:opacity-50 transition-all cursor-pointer shadow-2xs"
              >
                {t('save') || '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
