import { useEffect, useState } from 'react';
import {
  FiCheck,
  FiSliders,
  FiTarget,
  FiTrendingUp,
  FiAward,
  FiCompass,
  FiShield,
  FiZap,
  FiRotateCcw,
} from 'react-icons/fi';
import { useChatStore } from '../../stores/chat.store';
import { useLanguageStore } from '../../stores/language.store';
import {
  EMPTY_RSI_DIRECTION,
  isRsiConversation,
  type RsiDirectionConfig,
} from '../../core/agents/rsiConversation';

interface PresetTemplate {
  id: string;
  labelKey: string;
  icon: string;
  config: RsiDirectionConfig;
}

const PRESET_TEMPLATES: PresetTemplate[] = [
  {
    id: 'health',
    labelKey: 'rsiPresetCodeHealth',
    icon: '🛠️',
    config: {
      objective: '针对核心业务模块进行自愈式重构与健壮性治理，修复静态分析缺陷、未捕获异常与竞态条件。',
      priorities: 'P0: 确保所有测试用例 100% 通过\nP1: 消除潜在类型缺陷与隐式 any\nP2: 简化过度耦合的组件与函数结构',
      metrics: '单测全部通过；零 TypeScript 类型错误；构建无 warning；错误捕获边界覆盖关键链路',
      scope: 'src/core/, src/components/, src/stores/',
      constraints: '禁止删除已导出的公共 API 与核心类型定义；必须保持向后兼容；不得引入未审计的重度外部依赖',
    },
  },
  {
    id: 'performance',
    labelKey: 'rsiPresetPerformance',
    icon: '🚀',
    config: {
      objective: '全面排查渲染瓶颈与高频计算开销，降低空闲 CPU 与内存占用，提升界面交互流畅度。',
      priorities: 'P0: 消除不必要的组件重复渲染与深层状态深拷贝\nP1: 优化长列表与日志容器的 DOM 回收机制\nP2: 减少主线程大对象同步序列化开销',
      metrics: '界面重绘 FPS 稳定保持 60；高频操作内存峰值降低 15% 以上；关键交互延迟低于 16ms',
      scope: 'src/components/, src/stores/, electron/',
      constraints: '保持原有业务逻辑完全一致；禁止为了局部性能牺牲错误隔离机制或代码可读性',
    },
  },
  {
    id: 'testing',
    labelKey: 'rsiPresetTesting',
    icon: '🧪',
    config: {
      objective: '为核心业务链路与边界异常场景补充全面的自动化测试用例，构建高置信度的回归防护网。',
      priorities: 'P0: 为核心状态流及异步任务补充自动化单测\nP1: 针对网络中断、重试恢复等边缘场景编写故障注入用例\nP2: 完善并发操作与竞态条件测试',
      metrics: '核心模块语句覆盖率达到 85% 以上；边界异常用例覆盖完备；测试套件执行时间控制在安全阈值内',
      scope: 'src/**/__tests__/, src/**/*.test.ts, test/',
      constraints: '所有测试用例必须使用 Mock 或虚拟时钟，禁止产生非确定性外部网络请求或破坏性文件操作',
    },
  },
];

interface RsiDirectionPanelProps {
  onSaved?: () => void;
}

/**
 * Per-conversation RSI direction guidance. Edits apply to THIS conversation
 * only (updateRsiDirection is scoped by stable id) and are persisted, so they
 * survive restarts and never leak into another session's config.
 */
export default function RsiDirectionPanel({ onSaved }: RsiDirectionPanelProps) {
  const { t } = useLanguageStore();
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const updateRsiDirection = useChatStore((s) => s.updateRsiDirection);

  const conv = conversations.find((c) => c.id === activeConversationId);
  const rsi = conv && isRsiConversation(conv) ? conv.rsi : null;

  // Local draft so typing never writes to disk per keystroke; reset when the
  // conversation under the panel changes.
  const [draft, setDraft] = useState<RsiDirectionConfig | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(null);
    setSaved(false);
  }, [conv?.id]);

  if (!conv || !rsi) return null;

  const value = draft ?? rsi.directionConfig ?? EMPTY_RSI_DIRECTION;
  const lastRun = rsi.runs.length > 0 ? rsi.runs[rsi.runs.length - 1] : null;

  const save = async () => {
    if (!draft) return;
    await updateRsiDirection(conv.id, draft);
    setDraft(null);
    setSaved(true);
    onSaved?.();
    window.setTimeout(() => setSaved(false), 2000);
  };

  const applyTemplate = (template: PresetTemplate) => {
    setDraft({ ...template.config });
  };

  const handleClear = () => {
    setDraft({ ...EMPTY_RSI_DIRECTION });
  };

  return (
    <div className="rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-surface)]/80 backdrop-blur-2xl shadow-sm overflow-hidden transition-all">
      {/* Top Header Card */}
      <div className="p-4 sm:p-5 border-b border-[var(--glass-border)] bg-[var(--glass-card)]/50">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[var(--accent-soft)] flex items-center justify-center text-[var(--accent)] shrink-0 shadow-xs">
              <FiSliders size={17} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-[14px] font-bold text-[var(--text-primary)] truncate">
                  {t('rsiDirectionTitle')}
                </h3>
                <span className="px-2 py-0.5 rounded-md text-[10.5px] font-medium bg-[var(--bg-3)] text-[var(--text-muted)] border border-[var(--border)] shrink-0">
                  {t('rsiDirectionHint')}
                </span>
              </div>
              <p className="text-[11.5px] text-[var(--text-muted)] truncate mt-0.5">
                指导当前会话的强化学习演化目标、探索空间与安全边界
                {lastRun && ` · ${t('rsiDirectionProgress')} #${lastRun.iteration}`}
              </p>
            </div>
          </div>

          {/* Quick Preset Buttons */}
          <div className="flex items-center gap-1.5 flex-wrap shrink-0">
            <span className="text-[11px] font-medium text-[var(--text-muted)] mr-0.5 flex items-center gap-1">
              <FiZap size={11} className="text-[var(--accent)]" />
              <span>{t('rsiPresetsTitle')}:</span>
            </span>
            {PRESET_TEMPLATES.map((tmpl) => (
              <button
                key={tmpl.id}
                type="button"
                onClick={() => applyTemplate(tmpl)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--bg-2)] hover:bg-[var(--bg-3)] hover:text-[var(--text-primary)] border border-[var(--border)] text-[11px] font-medium text-[var(--text-secondary)] transition-colors active:scale-95 shadow-2xs"
                title={t(tmpl.labelKey)}
              >
                <span>{tmpl.icon}</span>
                <span className="truncate max-w-[110px]">{t(tmpl.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Form Fields */}
      <div className="p-4 sm:p-5 space-y-4">
        {/* Core Objective - Full Width Hero Field */}
        <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--bg-1)]/60 focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent)]/15 transition-all">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[12px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
              <FiTarget size={13} className="text-[var(--accent)]" />
              <span>{t('rsiDirectionObjective')}</span>
            </span>
            <span className="text-[10.5px] text-[var(--text-muted)]">
              {t('rsiDirectionObjectiveHint')}
            </span>
          </div>
          <textarea
            value={value.objective}
            rows={3}
            onChange={(e) => setDraft({ ...value, objective: e.target.value })}
            placeholder="例如：对核心业务模块进行自愈式重构，消除类型隐患、未捕获异常与竞态条件，提升代码鲁棒性..."
            className="w-full resize-y rounded-lg bg-transparent text-[12.5px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none leading-relaxed break-words [overflow-wrap:anywhere]"
          />
        </div>

        {/* 2-Column Responsive Grid for Secondary RL Guidance */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {/* Priorities & Weights */}
          <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--bg-1)]/60 focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent)]/15 transition-all">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-[12px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <FiTrendingUp size={13} className="text-amber-500" />
                <span>{t('rsiDirectionPriorities')}</span>
              </span>
            </div>
            <p className="text-[10.5px] text-[var(--text-muted)] mb-1.5">
              {t('rsiDirectionPrioritiesHint')}
            </p>
            <textarea
              value={value.priorities}
              rows={3}
              onChange={(e) => setDraft({ ...value, priorities: e.target.value })}
              placeholder="P0: 确保所有现有测试用例 100% 通过&#10;P1: 消除潜在类型缺陷与隐式 any&#10;P2: 简化过度耦合的组件与函数"
              className="w-full resize-y rounded-lg bg-transparent text-[12.5px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none leading-relaxed break-words [overflow-wrap:anywhere]"
            />
          </div>

          {/* Metrics & Benchmarks */}
          <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--bg-1)]/60 focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent)]/15 transition-all">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-[12px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <FiAward size={13} className="text-emerald-500" />
                <span>{t('rsiDirectionMetrics')}</span>
              </span>
            </div>
            <p className="text-[10.5px] text-[var(--text-muted)] mb-1.5">
              {t('rsiDirectionMetricsHint')}
            </p>
            <textarea
              value={value.metrics}
              rows={3}
              onChange={(e) => setDraft({ ...value, metrics: e.target.value })}
              placeholder="单测全部通过；零 TypeScript 类型错误；构建无 warning；错误捕获边界覆盖关键链路"
              className="w-full resize-y rounded-lg bg-transparent text-[12.5px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none leading-relaxed break-words [overflow-wrap:anywhere]"
            />
          </div>

          {/* Scope of Changes */}
          <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--bg-1)]/60 focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent)]/15 transition-all">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-[12px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <FiCompass size={13} className="text-blue-500" />
                <span>{t('rsiDirectionScope')}</span>
              </span>
            </div>
            <p className="text-[10.5px] text-[var(--text-muted)] mb-1.5">
              {t('rsiDirectionScopeHint')}
            </p>
            <textarea
              value={value.scope}
              rows={3}
              onChange={(e) => setDraft({ ...value, scope: e.target.value })}
              placeholder="src/core/, src/components/, src/stores/"
              className="w-full resize-y rounded-lg bg-transparent text-[12.5px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none leading-relaxed break-words [overflow-wrap:anywhere]"
            />
          </div>

          {/* Constraints & Safeguards */}
          <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--bg-1)]/60 focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent)]/15 transition-all">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-[12px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <FiShield size={13} className="text-rose-500" />
                <span>{t('rsiDirectionConstraints')}</span>
              </span>
            </div>
            <p className="text-[10.5px] text-[var(--text-muted)] mb-1.5">
              {t('rsiDirectionConstraintsHint')}
            </p>
            <textarea
              value={value.constraints}
              rows={3}
              onChange={(e) => setDraft({ ...value, constraints: e.target.value })}
              placeholder="禁止删除已导出的公共 API 与核心类型定义；必须保持向后兼容；不得引入未审计的重度外部依赖"
              className="w-full resize-y rounded-lg bg-transparent text-[12.5px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none leading-relaxed break-words [overflow-wrap:anywhere]"
            />
          </div>
        </div>
      </div>

      {/* Action Footer */}
      <div className="p-3 sm:px-5 sm:py-3.5 border-t border-[var(--glass-border)] bg-[var(--glass-card)]/40 flex items-center justify-between gap-3 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {lastRun && (
            <span className="text-[11px] text-[var(--text-muted)] truncate">
              {t('rsiDirectionProgress')}: #{lastRun.iteration} ({lastRun.status})
            </span>
          )}
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-colors"
          >
            <FiRotateCcw size={11} />
            <span>{t('rsiDirectionClear')}</span>
          </button>

          {saved && (
            <span className="text-[11.5px] text-[var(--success)] flex items-center gap-1 anim-fade font-medium">
              <FiCheck size={13} /> {t('rsiDirectionSaved')}
            </span>
          )}

          <button
            type="button"
            onClick={() => void save()}
            disabled={!draft}
            className="px-4 py-1.5 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12.5px] font-semibold transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none shadow-xs"
          >
            {t('rsiDirectionSave')}
          </button>
        </div>
      </div>
    </div>
  );
}
