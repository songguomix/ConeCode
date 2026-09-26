import { useState, useRef, useEffect, useMemo } from 'react';
import { FiSquare, FiPaperclip, FiX, FiFile, FiArrowUp, FiMap, FiPlus, FiTarget, FiList, FiLayers, FiZap } from 'react-icons/fi';
import { useMemoryStore, useChatStore, useModelStore, useLanguageStore, useWorkspaceStore, useSettingsStore, useUIStore, useGoalStore } from '../../stores';
import {
  BUILTIN_COMMANDS, parseSlashInput, matchCommands, findCommand, expandTemplate,
  type SlashCommand,
} from '../../core/commands';
import ModelSelector from '../model/ModelSelector';
import { parseQuickCapture, captureMemory } from '../../core/memory/quickCapture';
import { resolveDisplayPath } from '../../core/workspace/roots';

function mentionTokenAt(value: string, caret: number): string | null {
  const before = value.slice(0, caret);
  const m = before.match(/(?:^|\s)@([^\s@]{0,80})$/);
  return m ? m[1] : null;
}

export default function ChatInput() {
  const [input, setInput] = useState('');
  const sendMessage = useChatStore((s) => s.sendMessage);
  // Only THIS conversation's run turns the input into a stop button; other
  // conversations may be streaming concurrently.
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const isStreaming = useChatStore((s) => (activeConversationId ? !!s.streamingRuns[activeConversationId] : false));
  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const isSavingEdit = useChatStore((s) => activeConversationId ? !!s.messageEdits[activeConversationId] : false);
  const compactConversation = useChatStore((s) => s.compactConversation);
  const pushNotice = useChatStore((s) => s.pushNotice);
  const createConversation = useChatStore((s) => s.createConversation);
  const planMode = useChatStore((s) => s.planMode);
  const togglePlanMode = useChatStore((s) => s.togglePlanMode);
  const [plusOpen, setPlusOpen] = useState(false);
  const selectedModel = useModelStore((s) => s.getSelectedModel());
  const { t } = useLanguageStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndAtRef = useRef(0);
  const {
    selectedFile, contextFiles, customCommands, agentsMdPath, rootPath, memoryFiles,
    selectFile, addContextFile, addPastedImage, removeContextFile, ensureFileList, reloadProjectConfig,
    addRoot, addRootFromDialog, allRoots,
  } = useWorkspaceStore();
  const { autoIncludeFileContext, sendWithEnter } = useSettingsStore();
  const toggleModelSelector = useUIStore((s) => s.toggleModelSelector);
  const toggleReview = useUIStore((s) => s.toggleReview);
  const toggleWorktrees = useUIStore((s) => s.toggleWorktrees);
  const inputContent = useUIStore((s) => s.inputContent);
  const setInputContent = useUIStore((s) => s.setInputContent);

  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  /** Text captured with "#", waiting for the user to say which file it belongs in. */
  const [pendingCapture, setPendingCapture] = useState<string | null>(null);

  const slashMatches = useMemo<SlashCommand[]>(() => {
    if (!input.startsWith('/') || input.includes(' ') || input.includes('\n')) return [];
    return matchCommands(input.slice(1), customCommands);
  }, [input, customCommands]);
  const showSlash = !slashDismissed && slashMatches.length > 0;

  const mentionMatches = useMemo<string[]>(() => {
    if (mentionQuery == null || !allFiles) return [];
    const q = mentionQuery.toLowerCase();
    return allFiles.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
  }, [mentionQuery, allFiles]);
  const showMention = !showSlash && mentionQuery != null && mentionMatches.length > 0;

  useEffect(() => { setSlashIndex(0); }, [input]);
  useEffect(() => { setMentionIndex(0); }, [mentionQuery]);

  useEffect(() => {
    if (inputContent) {
      setInput(inputContent);
      setInputContent('');
      textareaRef.current?.focus();
    }
  }, [inputContent, setInputContent]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const resetHeight = () => { if (textareaRef.current) textareaRef.current.style.height = 'auto'; };

  const refreshMention = (value: string, caretPos: number) => {
    setCaret(caretPos);
    const tok = mentionTokenAt(value, caretPos);
    setMentionQuery(tok);
    if (tok != null && allFiles == null) {
      ensureFileList().then(setAllFiles).catch(() => setAllFiles([]));
    }
  };

  const acceptMention = (rel: string) => {
    const value = input;
    const before = value.slice(0, caret).replace(/(^|\s)@([^\s@]*)$/, (_m, pre) => `${pre}@${rel} `);
    const after = value.slice(caret);
    setInput(before + after);
    setMentionQuery(null);
    // The completion may name a file in any open folder, so resolve it against
    // the whole set — pinning it to the primary root would attach a path that
    // does not exist.
    const absolute = resolveDisplayPath(rel, allRoots());
    if (absolute) addContextFile(absolute);
    textareaRef.current?.focus();
  };

  const runCommand = async (cmd: SlashCommand, args: string) => {
    setInput('');
    setSlashDismissed(false);
    resetHeight();
    const pid = selectedModel?.providerId;
    const mid = selectedModel?.id;

    if (cmd.kind === 'prompt') {
      if (!selectedModel) return;
      await sendMessage(expandTemplate(cmd.template || '', args), pid!, mid!);
      return;
    }

    switch (cmd.name) {
      case 'help': {
        const lines = BUILTIN_COMMANDS.map((c) => `- \`/${c.name}\` — ${t(c.description)}`);
        let md = `### ${t('helpTitle')}\n${lines.join('\n')}`;
        if (customCommands.length) {
          md += `\n\n**${t('helpProjectCommands')}**\n` +
            customCommands.map((c) => `- \`/${c.name}\` — ${c.description}`).join('\n');
        }
        await pushNotice(md, pid, mid);
        break;
      }
      case 'clear':
        if (selectedModel) await createConversation(pid!, mid!);
        break;
      case 'compact':
        if (selectedModel) await compactConversation(pid!, mid!);
        break;
      case 'plan':
        togglePlanMode();
        break;
      case 'mode': {
        const m = args.trim().toLowerCase();
        if (m === 'plan') { togglePlanMode(); break; }
        if (m === 'task' || m === 'goal') { setInput('/goal '); break; }
        // orchestrate / rsi: leave a typed prompt so the user can continue;
        // full overlays live behind these labels.
        const hint = m === 'rsi' ? t('modeRsi') : m === 'orchestrate' ? t('modeOrchestrate') : '';
        if (hint) {
          await pushNotice(`**${hint}** — ${m === 'rsi' ? '设定目标后自主找突破口并迭代到收敛。' : '主控拆解、子智能体调研、汇总裁决。'}`, pid, mid);
        }
        break;
      }
      case 'goal': {
        const goalText = args.trim();
        if (!goalText) {
          setInput('/goal ');
          requestAnimationFrame(() => textareaRef.current?.focus());
          break;
        }
        if (!selectedModel) break;
        const conversationId = activeConversationId || await createConversation(pid!, mid!);
        useGoalStore.getState().setGoal(conversationId, goalText);
        await sendMessage(goalText, pid!, mid!);
        break;
      }
      case 'review':
        toggleReview();
        break;
      case 'worktree':
        toggleWorktrees();
        break;
      case 'model':
        toggleModelSelector();
        break;
      case 'memory': {
        // Two things are called memory here and they behave differently, so the
        // command shows both: files the user wrote (editable, and the argument
        // opens one) and what the assistant inferred on its own.
        const target = args.trim().toLowerCase();
        if (target) {
          const match = memoryFiles.find((f) => f.path.toLowerCase().includes(target) || f.scope === target);
          if (match) { await selectFile(match.path); break; }
          await pushNotice(t('memoryNoSuchFile'), pid, mid);
          break;
        }

        const fileLines = memoryFiles.length
          ? memoryFiles.map((f) => `- \`${f.path}\` — ${t(`memoryScope_${f.scope}`)}`).join('\n')
          : `_${t('memoryNoFiles')}_`;
        const entries = useMemoryStore.getState().relevant(rootPath);
        const learned = entries.length
          ? entries.map((e) => `- ${e.text}`).join('\n')
          : `_${t('memoryNone')}_`;
        await pushNotice(
          `### ${t('memoryFilesTitle')}\n${fileLines}\n\n_${t('memoryOpenHint')}_\n\n### ${t('memoryTitle')}\n${learned}`,
          pid, mid,
        );
        break;
      }
      case 'agents':
        if (agentsMdPath) await selectFile(agentsMdPath);
        else await pushNotice(t('noAgentsMd'), pid, mid);
        break;
      case 'add-dir': {
        // With a path, add it; without one, open the picker — same command
        // either way, which is how Claude Code's /add-dir behaves.
        const result = args.trim()
          ? await addRoot(args.trim())
          : await addRootFromDialog();
        if (result.ok) {
          await pushNotice(`📁 ${t('addedFolder')}: \`${result.path}\``, pid, mid);
        } else if (result.reason && result.reason !== 'empty') {
          const detail = result.covered?.length ? ` (${result.covered.join(', ')})` : '';
          await pushNotice(`⚠️ ${t(`addFolder_${result.reason}`)}${detail}`, pid, mid);
        }
        break;
      }
    }
  };

  // Write a captured line to the chosen memory file, then reload the workspace
  // config so it reaches the very next turn rather than the next app launch.
  const commitCapture = async (scope: 'user' | 'project') => {
    const text = pendingCapture;
    setPendingCapture(null);
    if (!text) return;

    const info = await window.electronAPI.app.getSystemInfo().catch(() => null);
    const result = await captureMemory({
      text,
      scope,
      homeDir: (info as any)?.homedir || '',
      rootPath,
      existing: memoryFiles,
      readFile: (path) => window.electronAPI.fs.readFile(path),
      writeFile: (path, content) => window.electronAPI.fs.writeFile(path, content),
      createDir: (path) => window.electronAPI.fs.createDir(path),
    });
    if (result.ok) await reloadProjectConfig();
    await pushNotice(
      `${result.ok ? '🧠' : '⚠️'} ${result.message}`,
      selectedModel?.providerId, selectedModel?.id,
    );
  };

  const handleSend = async () => {
    if (isStreaming || isSavingEdit) return;
    const text = input;
    if (!text.trim()) return;

    const slash = parseSlashInput(text.trim());
    if (slash) {
      const cmd = findCommand(slash.name, customCommands);
      if (cmd) { await runCommand(cmd, slash.args); return; }
    }

    // "# always run the tests" records an instruction instead of asking a
    // question. Offer the choice of scope rather than guessing: a rule for this
    // repo and a rule for every project land in different files.
    const captured = parseQuickCapture(text.trim());
    if (captured) {
      setInput('');
      resetHeight();
      setPendingCapture(captured);
      return;
    }

    if (!selectedModel) return;
    setInput('');
    setMentionQuery(null);
    resetHeight();
    await sendMessage(text, selectedModel.providerId, selectedModel.id);
  };

  const isImeConfirm = (e: React.KeyboardEvent) => {
    const native = e.nativeEvent as any;
    const justComposed = Date.now() - compositionEndAtRef.current < 250;
    return composingRef.current || native.isComposing || native.keyCode === 229 || justComposed;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSlash) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return; }
      if (e.key === 'Tab') { e.preventDefault(); setInput('/' + slashMatches[slashIndex].name + ' '); return; }
      if (e.key === 'Enter' && !e.shiftKey && !isImeConfirm(e)) {
        e.preventDefault();
        runCommand(slashMatches[slashIndex], '');
        return;
      }
    } else if (showMention) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return; }
      if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey && !isImeConfirm(e)) {
        e.preventDefault();
        acceptMention(mentionMatches[mentionIndex]);
        return;
      }
    }

    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    if (isImeConfirm(e)) return;
    if (sendWithEnter || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    setSlashDismissed(false);
    refreshMention(value, e.target.selectionStart ?? value.length);
  };

  const handleSelect = () => {
    const el = textareaRef.current;
    if (el) refreshMention(el.value, el.selectionStart ?? el.value.length);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const images = Array.from(items).filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (images.length === 0) return;
    e.preventDefault();
    for (const item of images) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => addPastedImage(reader.result as string, file.name || undefined);
      reader.readAsDataURL(file);
    }
  };

  const handleCompositionStart = () => { composingRef.current = true; };
  const handleCompositionEnd = () => {
    composingRef.current = false;
    compositionEndAtRef.current = Date.now();
  };

  const handleAttach = async () => {
    const picked = await window.electronAPI.dialog.openFile();
    const paths: string[] = Array.isArray(picked) ? picked : picked ? [picked] : [];
    for (const path of paths) {
      await addContextFile(path);
    }
  };

  const getFileName = (path: string) => path.split('/').pop() || path;

  return (
    <div className="bg-[var(--bg-0)]">
      {/* Context files indicator */}
      {(autoIncludeFileContext && selectedFile) || contextFiles.length > 0 ? (
        <div className="max-w-[900px] mx-auto w-full px-4 pt-2 pb-1">
          <div className="flex flex-wrap gap-1.5">
            {autoIncludeFileContext && selectedFile && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] text-xs font-medium">
                <FiPaperclip size={10} />
                {getFileName(selectedFile)} (auto)
              </span>
            )}
            {contextFiles.map((file) => (
              <span key={file.path} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--bg-3)] text-[var(--text-secondary)] text-xs">
                {file.isImage && file.dataUrl ? (
                  <img src={file.dataUrl} alt={getFileName(file.path)} className="h-8 w-8 object-cover rounded" title={file.path} />
                ) : (
                  <FiPaperclip size={10} />
                )}
                {!file.isImage && getFileName(file.path)}
                <button onClick={() => removeContextFile(file.path)} className="ml-0.5 hover:text-[var(--text-primary)] transition-colors">
                  <FiX size={10} />
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* "#" capture — ask where it belongs rather than guessing. */}
      {pendingCapture && (
        <div className="max-w-[900px] mx-auto w-full px-4 pt-2">
          <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2.5">
            <div className="text-[11px] text-[var(--text-muted)] mb-1">{t('captureWhere')}</div>
            <div className="text-[13px] text-[var(--text-primary)] mb-2 break-words">{pendingCapture}</div>
            <div className="flex items-center gap-2">
              <button onClick={() => commitCapture('project')} disabled={!rootPath}
                className="px-2.5 py-1 rounded-lg bg-[var(--accent)] text-white text-xs hover:bg-[var(--accent-hover)] disabled:opacity-40">
                {t('captureProject')}
              </button>
              <button onClick={() => commitCapture('user')}
                className="px-2.5 py-1 rounded-lg bg-[var(--bg-3)] text-[var(--text-secondary)] text-xs hover:bg-[var(--bg-4)]">
                {t('captureUser')}
              </button>
              <button onClick={() => setPendingCapture(null)}
                className="ml-auto px-2 py-1 rounded-lg text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="relative max-w-[900px] mx-auto w-full px-4 pt-2 pb-1">
        {/* Slash-command palette */}
        {showSlash && (
          <div className="absolute bottom-full left-6 right-6 mb-1 max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-2)] shadow-lg z-50 py-1">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium">{t('commandsTitle')}</div>
            {slashMatches.map((c, i) => (
              <button
                key={c.name}
                onMouseEnter={() => setSlashIndex(i)}
                onMouseDown={(e) => { e.preventDefault(); runCommand(c, ''); }}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${i === slashIndex ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-3)]'}`}
              >
                <span className="font-mono text-xs text-[var(--accent)] shrink-0">/{c.name}</span>
                <span className="text-xs text-[var(--text-muted)] truncate">{c.custom ? c.description : t(c.description)}</span>
                {c.custom && <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-muted)] shrink-0">{t('custom')}</span>}
              </button>
            ))}
          </div>
        )}

        {/* @-mention file palette */}
        {showMention && (
          <div className="absolute bottom-full left-6 right-6 mb-1 max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-2)] shadow-lg z-50 py-1">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium">{t('mentionFiles')}</div>
            {mentionMatches.map((f, i) => (
              <button
                key={f}
                onMouseEnter={() => setMentionIndex(i)}
                onMouseDown={(e) => { e.preventDefault(); acceptMention(f); }}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${i === mentionIndex ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-3)]'}`}
              >
                <FiFile size={12} className="text-[var(--text-muted)] shrink-0" />
                <span className="text-xs text-[var(--text-primary)] truncate">{f}</span>
              </button>
            ))}
          </div>
        )}

        {/* Composer box */}
        <div className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-2)] pl-4 pr-2 py-2 focus-within:border-[var(--accent)]/50 transition-colors shadow-sm">
          <div className="flex items-end gap-3">
            <button
              onClick={handleAttach}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-colors shrink-0 mb-0.5"
              title={t('attachFiles')}
            >
              <FiPaperclip size={18} />
            </button>

            {/* + menu: Plan / Task / Orchestrate / RSI — keeps the composer calm. */}
            <div className="relative shrink-0 mb-0.5">
              <button
                onClick={() => setPlusOpen((v) => !v)}
                title={t('modeMenu')}
                className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${
                  plusOpen || planMode
                    ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-3)]'
                }`}
              >
                <FiPlus size={18} />
              </button>
              {plusOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setPlusOpen(false)} />
                  <div
                    className="absolute bottom-full left-0 mb-2 w-56 rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] shadow-xl z-50 py-1.5 anim-menu"
                    style={{ ['--menu-origin' as any]: 'bottom left', ['--menu-shift' as any]: '6px' }}
                  >
                    {([
                      { key: 'plan', label: t('modePlan'), icon: <FiMap size={14} />, active: planMode, on: () => togglePlanMode() },
                      { key: 'task', label: t('modeTask'), icon: <FiTarget size={14} />, active: false, on: () => setInput('/goal ') },
                      { key: 'orch', label: t('modeOrchestrate'), icon: <FiList size={14} />, active: false, on: () => setInput('/mode orchestrate ') },
                      { key: 'rsi', label: t('modeRsi'), icon: <FiZap size={14} />, active: false, on: () => setInput('/mode rsi ') },
                    ] as const).map((item) => (
                      <button
                        key={item.key}
                        onClick={() => { item.on(); setPlusOpen(false); }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] transition-colors ${
                          item.active
                            ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-3)]'
                        }`}
                      >
                        {item.icon}
                        <span className="flex-1 text-left">{item.label}</span>
                        {item.active && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onKeyUp={handleSelect}
              onClick={handleSelect}
              onPaste={handlePaste}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              placeholder={planMode ? `${t('planMode')} · ${t('typeMessage')}` : t('typeMessage')}
              rows={1}
              className="flex-1 bg-transparent border-0 py-2 text-[15px] resize-none outline-none max-h-[200px] overflow-y-auto placeholder:text-[var(--text-muted)]"
            />

            {isStreaming ? (
              <button onClick={() => stopGeneration()}
                className="w-9 h-9 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:bg-[var(--accent-hover)] transition-colors shrink-0 mb-0.5">
                <FiSquare size={14} />
              </button>
            ) : (
              <button onClick={handleSend}
                disabled={!input.trim() || isSavingEdit}
                title={sendWithEnter ? t('sendHintEnter') : t('sendHintCmd')}
                className="w-9 h-9 rounded-full flex items-center justify-center transition-all bg-[var(--accent)] text-white disabled:opacity-30 hover:bg-[var(--accent-hover)] shrink-0 mb-0.5">
                <FiArrowUp size={18} />
              </button>
            )}
          </div>
        </div>
      </div>

      <ModelSelector />
    </div>
  );
}
