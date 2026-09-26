import { useState, useRef, useEffect, useMemo } from 'react';
import { useChatStore, useModelStore, useWorkspaceStore, useSettingsStore, useLanguageStore } from '../../stores';
import { contextMessagesForUsage } from '../../stores/chat.store';
import { estimateTokens, SYSTEM_PROMPT_TOKENS } from '../../core/tokens';

// Donut geometry. Drawn in a 36x36 viewBox, rendered small in the control bar.
const RADIUS = 15;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function severityColor(pct: number): string {
  if (pct >= 0.9) return '#ef4444'; // red
  if (pct >= 0.7) return '#f59e0b'; // amber
  return '#10b981'; // green
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export default function ContextMeter() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useLanguageStore();

  const messages = useChatStore((s) => s.messages);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const streamingContent = useChatStore((s) =>
    activeConversationId ? s.streamingRuns[activeConversationId]?.content ?? '' : '');
  const streamingReasoningContent = useChatStore((s) =>
    activeConversationId ? s.streamingRuns[activeConversationId]?.reasoningContent ?? '' : '');
  const selectedModel = useModelStore((s) => s.getSelectedModel());

  const { selectedFile, fileContent, selectedFileIsImage, contextFiles } = useWorkspaceStore();
  const { autoIncludeFileContext, maxContextFileSize } = useSettingsStore();

  // Only count the live request context. Compacted transcript messages remain
  // visible, but are excluded here just as they are in buildApiMessages().
  const liveMessages = useMemo(() => contextMessagesForUsage(messages), [messages]);
  const messageTokens = useMemo(
    () => liveMessages.reduce((sum, m) => sum + estimateTokens(m.content) + estimateTokens(m.reasoning_content), 0),
    [liveMessages]
  );
  const compactionCount = useMemo(
    () => messages.reduce((count, m) => count + (m.isSummary ? 1 : 0), 0),
    [messages]
  );

  // Attached context mirrors what buildSystemMessages() actually sends: the
  // auto-included open file plus manually attached files, each truncated to the
  // configured cap.
  const fileTokens = useMemo(() => {
    const cap = (s: string) => (s.length > maxContextFileSize ? s.slice(0, maxContextFileSize) : s);
    let total = 0;
    if (autoIncludeFileContext && selectedFile && fileContent != null) {
      // An open image's fileContent is a base64 data URL — count it as a fixed
      // image placeholder rather than measuring the base64 string length.
      total += selectedFileIsImage ? 512 : estimateTokens(cap(fileContent));
    }
    for (const f of contextFiles) {
      // Images are base64 data URLs — estimate ~0.25 token/byte is too volatile;
      // use a fixed 512-token placeholder per image instead.
      total += f.isImage ? 512 : estimateTokens(cap(f.content));
    }
    return total;
  }, [autoIncludeFileContext, selectedFile, fileContent, selectedFileIsImage, contextFiles, maxContextFileSize]);

  const liveTokens = useMemo(
    () => estimateTokens(streamingContent) + estimateTokens(streamingReasoningContent),
    // estimateTokens is O(n) over the accumulated stream — memo so sibling
    // re-renders (open flag, theme) don't re-scan multi-KB text.
    [streamingContent, streamingReasoningContent],
  );

  const convoTokens = messageTokens + liveTokens;
  const used = convoTokens + fileTokens + SYSTEM_PROMPT_TOKENS;
  const window = selectedModel?.contextWindow ?? 0;
  const pct = window > 0 ? Math.min(used / window, 1) : 0;
  const remaining = Math.max(0, window - used);
  const remainingPct = window > 0 ? Math.round((1 - pct) * 100) : 0;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const color = severityColor(pct);
  const usedPct = Math.round(pct * 100);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        title={window > 0 ? `${remainingPct}% ${t('contextLeft')}` : t('contextUsage')}
        className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-[var(--bg-3)] transition-colors"
      >
        <svg width="18" height="18" viewBox="0 0 36 36" className="-rotate-90">
          <circle cx="18" cy="18" r={RADIUS} fill="none" stroke="var(--border)" strokeWidth="4" />
          <circle
            cx="18" cy="18" r={RADIUS} fill="none"
            stroke={color} strokeWidth="4" strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - pct)}
            style={{ transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease' }}
          />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-60 p-3 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl shadow-2xl z-50 text-xs anim-menu" style={{ ['--menu-origin' as any]: 'bottom right', ['--menu-shift' as any]: '6px' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-sm text-[var(--text-primary)]">{t('contextUsage')}</span>
            {window > 0 && (
              <span className="font-semibold" style={{ color }}>{usedPct}%</span>
            )}
          </div>

          {window > 0 ? (
            <>
              <div className="h-1.5 w-full rounded-full bg-[var(--bg-3)] overflow-hidden mb-2">
                <div className="h-full rounded-full" style={{ width: `${usedPct}%`, background: color, transition: 'width 0.3s ease' }} />
              </div>

              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>{t('used')}</span>
                <span className="text-[var(--text-primary)]">{formatTokens(used)} / {formatTokens(window)}</span>
              </div>
              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>{t('remaining')}</span>
                <span className="text-[var(--text-primary)]">{formatTokens(remaining)} {t('tokens')}</span>
              </div>
              {compactionCount > 0 && (
                <div className="flex justify-between text-[var(--text-secondary)]">
                  <span>{t('compactions')}</span>
                  <span className="text-[var(--text-primary)]">{compactionCount}</span>
                </div>
              )}

              <div className="border-t border-[var(--border)] mt-2 pt-2 space-y-1">
                <div className="flex justify-between text-[var(--text-muted)]">
                  <span>{t('messages')}</span><span>{formatTokens(convoTokens)}</span>
                </div>
                <div className="flex justify-between text-[var(--text-muted)]">
                  <span>{t('attachedFiles')}</span><span>{formatTokens(fileTokens)}</span>
                </div>
                <div className="flex justify-between text-[var(--text-muted)]">
                  <span>{t('systemPrompt')}</span><span>{formatTokens(SYSTEM_PROMPT_TOKENS)}</span>
                </div>
              </div>

              <div className="text-[10px] text-[var(--text-muted)] mt-2 text-right italic">≈ {t('estimated')}</div>
            </>
          ) : (
            <div className="text-[var(--text-muted)] py-1">{t('selectModelHint')}</div>
          )}
        </div>
      )}
    </div>
  );
}
