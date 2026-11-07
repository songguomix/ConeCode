import { useEffect, useState, useMemo, useRef } from 'react';
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
  FiLoader,
} from 'react-icons/fi';
import { useChatStore } from '../../stores/chat.store';
import { useLanguageStore, type Locale } from '../../stores/language.store';
import {
  EMPTY_RSI_DIRECTION,
  isRsiConversation,
  type RsiDirectionConfig,
} from '../../core/agents/rsiConversation';
import { rsiStatusLabel } from './rsiPresentation';

interface PresetTemplate {
  id: string;
  labelKey: string;
  icon: string;
  config: RsiDirectionConfig;
}

function getPresetTemplates(locale: Locale): PresetTemplate[] {
  if (locale === 'en') {
    return [
      {
        id: 'health',
        labelKey: 'rsiPresetCodeHealth',
        icon: '🛠️',
        config: {
          objective: 'Self-healing refactoring and robustness governance for core business modules, eliminating static analysis defects, uncaught exceptions, and race conditions.',
          priorities: 'P0: Ensure all test cases pass 100%\nP1: Eliminate potential type errors and implicit any\nP2: Simplify over-coupled components and functions',
          metrics: 'All unit tests pass; zero TypeScript errors; clean build without warnings; error boundaries covering critical paths',
          scope: 'src/core/, src/components/, src/stores/',
          constraints: 'Do not remove exported public APIs or core types; maintain backward compatibility; no un-audited heavy external dependencies',
        },
      },
      {
        id: 'performance',
        labelKey: 'rsiPresetPerformance',
        icon: '🚀',
        config: {
          objective: 'Identify and eliminate rendering bottlenecks and heavy computational overhead, reducing idle CPU and memory consumption and smoothing interactions.',
          priorities: 'P0: Eliminate unnecessary component re-renders and deep state cloning\nP1: Optimize DOM pooling for long lists and logs\nP2: Reduce synchronous serialization overhead on the main thread',
          metrics: 'UI redraw FPS stably maintained at 60; high-frequency memory peak reduced by >15%; critical interaction latency < 16ms',
          scope: 'src/components/, src/stores/, electron/',
          constraints: 'Keep existing business logic completely consistent; do not sacrifice error isolation or code readability for micro-benchmarks',
        },
      },
      {
        id: 'testing',
        labelKey: 'rsiPresetTesting',
        icon: '🧪',
        config: {
          objective: 'Add comprehensive automated test suites for critical business workflows and edge-case exceptions, building a high-confidence regression safety net.',
          priorities: 'P0: Add automated unit tests for core state flows and async tasks\nP1: Write fault injection tests for network interruptions and retries\nP2: Complete concurrency and race condition testing',
          metrics: 'Statement coverage for core modules >= 85%; complete edge-case coverage; test suite duration kept within safe thresholds',
          scope: 'src/**/__tests__/, src/**/*.test.ts, test/',
          constraints: 'All test cases must use mocks or virtual timers; no non-deterministic network requests or destructive disk operations',
        },
      },
    ];
  }

  if (locale === 'ja') {
    return [
      {
        id: 'health',
        labelKey: 'rsiPresetCodeHealth',
        icon: '🛠️',
        config: {
          objective: 'コアモジュールの自律修復リファクタリングと堅牢性ガバナンス。静的解析の欠陥、未捕捉例外、競合状態を排除。',
          priorities: 'P0: 全テストケース100%通過を保証\nP1: 潜在的な型エラーと暗黙のanyを排除\nP2: 密結合したコンポーネントと関数構造を簡素化',
          metrics: '単体テスト全通過、TypeScript型エラー0件、ビルド警告なし、重要フローのエラー境界網羅',
          scope: 'src/core/, src/components/, src/stores/',
          constraints: '公開APIおよび主要型定義の削除禁止、後方互換性を厳格に維持、監査されていない重い外部依存の導入禁止',
        },
      },
      {
        id: 'performance',
        labelKey: 'rsiPresetPerformance',
        icon: '🚀',
        config: {
          objective: 'レンダリングのボトルネックと計算コストの徹底調査。アイドル時のCPU・メモリ消費を削減し、快適な応答性を実現。',
          priorities: 'P0: 不要な再レンダリングとディープコピーの排除\nP1: 長大リストとログコンテナのDOM再利用を最適化\nP2: メインスレッドの同期シリアライズ負荷を軽減',
          metrics: '再描画FPS 60安定、高頻度処理時のメモリピークを15%以上削減、操作遅延16ms以内',
          scope: 'src/components/, src/stores/, electron/',
          constraints: '既存のビジネスロジックと動作を完全に維持、局所的最適化のためにエラー分離や可読性を犠牲にしない',
        },
      },
      {
        id: 'testing',
        labelKey: 'rsiPresetTesting',
        icon: '🧪',
        config: {
          objective: '主要ロジックと境界条件に対する自動テストの網羅的拡充、高信頼なリグレッション防止網を構築。',
          priorities: 'P0: コア状態遷移と非同期タスクの自動単体テスト追加\nP1: ネットワーク切断・再試行復旧のフォールトインジェクション検証\nP2: 並行処理と競合状態テストの充実',
          metrics: 'コアモジュールのステートメント網羅率85%以上、境界例外の網羅、テスト実行時間を安全閾値内に抑制',
          scope: 'src/**/__tests__/, src/**/*.test.ts, test/',
          constraints: '全テストはモックまたは仮想時間を使用、非決定的な外部通信や破壊的ファイル操作を禁止',
        },
      },
    ];
  }

  if (locale === 'zhHant') {
    return [
      {
        id: 'health',
        labelKey: 'rsiPresetCodeHealth',
        icon: '🛠️',
        config: {
          objective: '針對核心業務模組進行自癒式重構與健全性治理，修復靜態分析缺陷、未捕獲異常與競爭條件。',
          priorities: 'P0: 確保所有測試用例 100% 通過\nP1: 消除潛在類型缺陷與隱式 any\nP2: 簡化過度耦合的組件與函數結構',
          metrics: '單測全部通過；零 TypeScript 類型錯誤；構建無 warning；錯誤捕獲邊界覆蓋關鍵鏈路',
          scope: 'src/core/, src/components/, src/stores/',
          constraints: '禁止刪除已導出的公共 API 與核心類型定義；必須保持向後相容；不得引入未審計的重度外部依賴',
        },
      },
      {
        id: 'performance',
        labelKey: 'rsiPresetPerformance',
        icon: '🚀',
        config: {
          objective: '全面排查渲染瓶頸與高頻計算開銷，降低空閒 CPU 與內存佔用，提升界面交互流暢度。',
          priorities: 'P0: 消除不必要的組件重複渲染與深層狀態深拷貝\nP1: 優化長列表與日誌容器的 DOM 回收機制\nP2: 減少主線程大對象同步序列化開銷',
          metrics: '界面重繪 FPS 穩定保持 60；高頻操作內存峰值降低 15% 以上；關鍵交互延遲低於 16ms',
          scope: 'src/components/, src/stores/, electron/',
          constraints: '保持原有業務邏輯完全一致；禁止為了局部性能犧牲錯誤隔離機制或代碼可讀性',
        },
      },
      {
        id: 'testing',
        labelKey: 'rsiPresetTesting',
        icon: '🧪',
        config: {
          objective: '為核心業務鏈路與邊界異常場景補充全面的自動化測試用例，構建高置信度的回歸防護網。',
          priorities: 'P0: 為核心狀態流及異步任務補充自動化單測\nP1: 針對網絡中斷、重試恢復等邊緣場景編寫故障注入用例\nP2: 完善並發操作與競爭條件測試',
          metrics: '核心模組語句覆蓋率達到 85% 以上；邊界異常用例覆蓋完備；測試套件執行時間控制在安全閾值內',
          scope: 'src/**/__tests__/, src/**/*.test.ts, test/',
          constraints: '所有測試用例必須使用 Mock 或虛擬時鐘，禁止產生非確定性外部網絡請求或破壞性文件操作',
        },
      },
    ];
  }

  // Default: zh (Simplified Chinese)
  return [
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
}

interface RsiDirectionPanelProps {
  onSaved?: () => void;
}

/**
 * Per-conversation RSI direction guidance. Edits apply to THIS conversation
 * only (updateRsiDirection is scoped by stable id) and are persisted, so they
 * survive restarts and never leak into another session's config.
 */
export default function RsiDirectionPanel({ onSaved }: RsiDirectionPanelProps) {
  const { t, locale } = useLanguageStore();
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const updateRsiDirection = useChatStore((s) => s.updateRsiDirection);

  const conv = conversations.find((c) => c.id === activeConversationId);
  const rsi = conv && isRsiConversation(conv) ? conv.rsi : null;

  // Local draft so typing never writes to disk per keystroke; reset when the
  // conversation under the panel changes.
  const [draft, setDraft] = useState<RsiDirectionConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const conversationRef = useRef(conv?.id);
  conversationRef.current = conv?.id;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const presetTemplates = useMemo(() => getPresetTemplates(locale), [locale]);

  useEffect(() => {
    setDraft(null);
    setSaved(false);
    setSaveError(null);
  }, [conv?.id]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const editDraft = (next: RsiDirectionConfig) => {
    setDraft(next);
    setSaved(false);
    setSaveError(null);
  };

  if (!conv || !rsi) return null;

  const value = draft ?? rsi.directionConfig ?? EMPTY_RSI_DIRECTION;
  const lastRun = rsi.runs.length > 0 ? rsi.runs[rsi.runs.length - 1] : null;
  const changed = !!draft && Object.keys(EMPTY_RSI_DIRECTION).some((key) =>
    draft[key as keyof RsiDirectionConfig] !== (rsi.directionConfig ?? EMPTY_RSI_DIRECTION)[key as keyof RsiDirectionConfig]);

  const save = async () => {
    if (!draft || !changed || savingRef.current) return;
    const conversationId = conv.id;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await updateRsiDirection(conversationId, draft);
      if (!mountedRef.current || conversationRef.current !== conversationId) return;
      setDraft(null);
      setSaved(true);
      onSaved?.();
    } catch (error) {
      if (mountedRef.current && conversationRef.current === conversationId) {
        setSaveError(error instanceof Error ? error.message : t('rsiOperationFailed'));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const applyTemplate = (template: PresetTemplate) => {
    editDraft({ ...template.config });
  };

  const handleClear = () => {
    editDraft({ ...EMPTY_RSI_DIRECTION });
  };

  return (
    <fieldset disabled={saving} aria-busy={saving} className="min-w-0 rounded-2xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-surface)_80%,transparent)] overflow-hidden">
      {/* Top Header Card */}
      <div className="p-4 border-b border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-card)_50%,transparent)]">
        <div className="flex flex-col gap-3 min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[var(--accent-soft)] flex items-center justify-center text-[var(--accent)] shrink-0 shadow-2xs">
              <FiSliders size={17} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <h3 className="text-[14px] font-bold text-[var(--text-primary)] font-serif truncate">
                  {t('rsiDirectionTitle')}
                </h3>
                <span className="px-2 py-0.5 rounded-md text-[10.5px] font-medium bg-[var(--bg-3)] text-[var(--text-muted)] border border-[var(--border)] shrink-0">
                  {t('rsiDirectionHint')}
                </span>
              </div>
              <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)] mt-0.5">
                {t('rsiDirectionSub')}
                {lastRun && ` · ${t('rsiDirectionProgress')} #${lastRun.iteration}`}
              </p>
            </div>
          </div>

          {/* Quick Preset Buttons */}
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <span className="text-[11px] font-medium text-[var(--text-muted)] mr-0.5 flex items-center gap-1">
              <FiZap size={11} className="text-[var(--accent)]" />
              <span>{t('rsiPresetsTitle')}:</span>
            </span>
            {presetTemplates.map((tmpl) => (
              <button
                key={tmpl.id}
                type="button"
                onClick={() => applyTemplate(tmpl)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--glass-card)] hover:bg-[var(--glass-surface)] hover:text-[var(--text-primary)] border border-[var(--glass-border)] text-[11px] font-medium text-[var(--text-secondary)] transition-all active:scale-95 shadow-2xs cursor-pointer"
                title={t(tmpl.labelKey)}
              >
                <span>{tmpl.icon}</span>
                <span className="truncate max-w-[120px]">{t(tmpl.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Form Fields */}
      <div className="p-4 space-y-4">
        {/* Primary objective spans the form; related fields share the available width. */}
        <div className="p-3 rounded-2xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-card)_60%,transparent)] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,var(--accent)_15%,transparent)] transition-all shadow-2xs min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <span className="text-[12.5px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5 font-serif">
              <FiTarget size={14} className="text-[var(--accent)]" />
              <span>{t('rsiDirectionObjective')}</span>
            </span>
            <span className="text-[11px] text-[var(--text-muted)]">
              {t('rsiDirectionObjectiveHint')}
            </span>
          </div>
          <textarea
            aria-label={t('rsiDirectionObjective')}
            value={value.objective}
            rows={3}
            onChange={(e) => editDraft({ ...value, objective: e.target.value })}
            placeholder={t('rsiObjectivePlaceholder')}
            className="block w-full resize-y rounded-lg bg-[color-mix(in_srgb,var(--bg-1)_60%,transparent)] border border-[var(--border)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_10%,transparent)] p-2.5 text-[12.5px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none leading-relaxed break-words [overflow-wrap:anywhere]"
          />
        </div>

        {/* 2-Column Responsive Grid for Secondary RL Guidance */}
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))' }}>
          {/* Priorities & Weights */}
          <div className="p-3 rounded-2xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-card)_60%,transparent)] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,var(--accent)_15%,transparent)] transition-all shadow-2xs min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[12.5px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5 font-serif">
                <FiTrendingUp size={14} className="text-amber-500" />
                <span>{t('rsiDirectionPriorities')}</span>
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-[var(--text-muted)] mb-1.5">
              {t('rsiDirectionPrioritiesHint')}
            </p>
            <textarea
              aria-label={t('rsiDirectionPriorities')}
              value={value.priorities}
              rows={3}
              onChange={(e) => editDraft({ ...value, priorities: e.target.value })}
              placeholder={t('rsiPrioritiesPlaceholder')}
              className="block w-full resize-y rounded-lg bg-[color-mix(in_srgb,var(--bg-1)_60%,transparent)] border border-[var(--border)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_10%,transparent)] p-2.5 text-[12.5px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none leading-relaxed break-words [overflow-wrap:anywhere]"
            />
          </div>

          {/* Metrics & Benchmarks */}
          <div className="p-3 rounded-2xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-card)_60%,transparent)] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,var(--accent)_15%,transparent)] transition-all shadow-2xs min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[12.5px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5 font-serif">
                <FiAward size={14} className="text-emerald-500" />
                <span>{t('rsiDirectionMetrics')}</span>
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-[var(--text-muted)] mb-1.5">
              {t('rsiDirectionMetricsHint')}
            </p>
            <textarea
              aria-label={t('rsiDirectionMetrics')}
              value={value.metrics}
              rows={3}
              onChange={(e) => editDraft({ ...value, metrics: e.target.value })}
              placeholder={t('rsiMetricsPlaceholder')}
              className="block w-full resize-y rounded-lg bg-[color-mix(in_srgb,var(--bg-1)_60%,transparent)] border border-[var(--border)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_10%,transparent)] p-2.5 text-[12.5px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none leading-relaxed break-words [overflow-wrap:anywhere]"
            />
          </div>

          {/* Scope of Changes */}
          <div className="p-3 rounded-2xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-card)_60%,transparent)] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,var(--accent)_15%,transparent)] transition-all shadow-2xs min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[12.5px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5 font-serif">
                <FiCompass size={14} className="text-blue-500" />
                <span>{t('rsiDirectionScope')}</span>
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-[var(--text-muted)] mb-1.5">
              {t('rsiDirectionScopeHint')}
            </p>
            <textarea
              aria-label={t('rsiDirectionScope')}
              value={value.scope}
              rows={3}
              onChange={(e) => editDraft({ ...value, scope: e.target.value })}
              placeholder={t('rsiScopePlaceholder')}
              className="block w-full resize-y rounded-lg bg-[color-mix(in_srgb,var(--bg-1)_60%,transparent)] border border-[var(--border)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_10%,transparent)] p-2.5 text-[12.5px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none leading-relaxed break-words [overflow-wrap:anywhere]"
            />
          </div>

          {/* Constraints & Safeguards */}
          <div className="p-3 rounded-2xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-card)_60%,transparent)] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,var(--accent)_15%,transparent)] transition-all shadow-2xs min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[12.5px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5 font-serif">
                <FiShield size={14} className="text-rose-500" />
                <span>{t('rsiDirectionConstraints')}</span>
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-[var(--text-muted)] mb-1.5">
              {t('rsiDirectionConstraintsHint')}
            </p>
            <textarea
              aria-label={t('rsiDirectionConstraints')}
              value={value.constraints}
              rows={3}
              onChange={(e) => editDraft({ ...value, constraints: e.target.value })}
              placeholder={t('rsiConstraintsPlaceholder')}
              className="block w-full resize-y rounded-lg bg-[color-mix(in_srgb,var(--bg-1)_60%,transparent)] border border-[var(--border)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_10%,transparent)] p-2.5 text-[12.5px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none leading-relaxed break-words [overflow-wrap:anywhere]"
            />
          </div>
        </div>
      </div>

      {saveError && <p role="alert" className="mx-4 mb-3 text-xs text-[var(--error)] break-words [overflow-wrap:anywhere]">{saveError}</p>}

      {/* Action Footer */}
      <div className="px-4 py-3 border-t border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-card)_40%,transparent)] flex flex-wrap items-center justify-between gap-3 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {lastRun && (
            <span className="text-[11px] text-[var(--text-muted)] truncate">
              {t('rsiDirectionProgress')}: #{lastRun.iteration} ({t(rsiStatusLabel(lastRun.status))})
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] transition-colors cursor-pointer"
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
            disabled={!changed || saving}
            className="px-4 py-2 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12.5px] font-semibold transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none shadow-xs cursor-pointer"
          >
            {saving ? <span className="inline-flex items-center gap-1.5"><FiLoader size={12} className="animate-spin" />{t('rsiSaving')}</span> : t('rsiDirectionSave')}
          </button>
        </div>
      </div>
    </fieldset>
  );
}
