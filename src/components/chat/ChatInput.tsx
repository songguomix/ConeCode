import { useState, useRef, useEffect, useMemo } from 'react';
import { FiSquare, FiPaperclip, FiX, FiFile, FiArrowUp, FiPlus, FiTool, FiChevronRight, FiCamera, FiClock, FiPlay } from 'react-icons/fi';
import { AGENT_MODES, type AgentMode } from '../../core/agents/modePrompts';
import { useMemoryStore, useChatStore, useModelStore, useLanguageStore, useWorkspaceStore, useSettingsStore, useUIStore, useGoalStore, useSkillsStore, useImageGenStore } from '../../stores';
import { useMemoryV2Store, isMemoryV2Active } from '../../stores/memoryV2.store';
import { useScreenshotStore } from '../../stores/screenshot.store';
import { useBackgroundStore } from '../../stores/background.store';
import { prettyShortcut } from '../../core/screenshot/shortcut';
import { useInstallGateStore, isHolding } from '../../stores/installGate.store';
import {
  BUILTIN_COMMANDS, parseSlashInput, matchCommands, findCommand, expandTemplate,
  type SlashCommand,
} from '../../core/commands';
import ModelSelector from '../model/ModelSelector';
import QueuedMessages from './QueuedMessages';
import { parseQuickCapture, captureMemory } from '../../core/memory/quickCapture';
import { resolveDisplayPath } from '../../core/workspace/roots';

function mentionTokenAt(value: string, caret: number): string | null {
  const before = value.slice(0, caret);
  const m = before.match(/(?:^|\s)@([^\s@]{0,80})$/);
  return m ? m[1] : null;
}

interface ChatInputProps {
  centered?: boolean;
}

export default function ChatInput({ centered = false }: ChatInputProps) {
  const [input, setInput] = useState('');
  const sendMessage = useChatStore((s) => s.sendMessage);
  const enqueueMessage = useChatStore((s) => s.enqueueMessage);
  // Only THIS conversation's run turns the input into a stop button; other
  // conversations may be streaming concurrently.
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const isStreaming = useChatStore((s) => (activeConversationId ? !!s.streamingRuns[activeConversationId] : false));
  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const isSavingEdit = useChatStore((s) => activeConversationId ? !!s.messageEdits[activeConversationId] : false);
  const continuableConvId = useChatStore((s) => s.continuableConvId);
  const continueGeneration = useChatStore((s) => s.continueGeneration);
  const compactConversation = useChatStore((s) => s.compactConversation);
  const pushNotice = useChatStore((s) => s.pushNotice);
  const newConversation = useChatStore((s) => s.newConversation);
  const planMode = useChatStore((s) => s.planMode);
  const installHolding = useInstallGateStore((s) => isHolding(s.jobs));
  const togglePlanMode = useChatStore((s) => s.togglePlanMode);
  const [plusOpen, setPlusOpen] = useState(false);
  /** Skill picker popup inside the + menu (one row → full list). */
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const agentMode = useChatStore((s) => s.agentMode);
  const setAgentMode = useChatStore((s) => s.setAgentMode);
  /** Skill armed from the + menu — its instructions lead the next message. */
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const effectiveSkills = useSkillsStore((s) => s.effective);
  const skillBody = useSkillsStore((s) => s.body);
  const activeSkill = activeSkillId ? effectiveSkills.find((s) => s.id === activeSkillId) ?? null : null;
  const selectedModel = useModelStore((s) => s.getSelectedModel());
  const { t } = useLanguageStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndAtRef = useRef(0);
  const {
    selectedFile, contextFiles, customCommands, agentsMdPath, rootPath, memoryFiles, fileList,
    selectFile, addContextFile, addPastedImage, removeContextFile, ensureFileList, reloadProjectConfig,
    addRoot, addRootFromDialog, allRoots,
  } = useWorkspaceStore();
  const { autoIncludeFileContext, sendWithEnter } = useSettingsStore();
  const toggleModelSelector = useUIStore((s) => s.toggleModelSelector);
  const toggleReview = useUIStore((s) => s.toggleReview);
  const toggleWorktrees = useUIStore((s) => s.toggleWorktrees);
  const inputContent = useUIStore((s) => s.inputContent);
  const setInputContent = useUIStore((s) => s.setInputContent);
  const startScreenshot = useScreenshotStore((s) => s.start);
  const screenshotStarting = useScreenshotStore((s) => s.starting);
  const screenshotShortcut = useScreenshotStore((s) => s.shortcut);
  const launchBackground = useBackgroundStore((s) => s.launch);

  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  /** Text captured with "#", waiting for the user to say which file it belongs in. */
  const [pendingCapture, setPendingCapture] = useState<string | null>(null);

  const slashMatches = useMemo<SlashCommand[]>(() => {
    if (!input.startsWith('/') || input.includes(' ') || input.includes('\n')) return [];
    return matchCommands(input.slice(1), customCommands);
  }, [input, customCommands]);
  const showSlash = !slashDismissed && slashMatches.length > 0;

  const mentionMatches = useMemo<string[]>(() => {
    if (mentionQuery == null || !fileList) return [];
    const q = mentionQuery.toLowerCase();
    return fileList.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
  }, [mentionQuery, fileList]);
  const showMention = !showSlash && mentionQuery != null && mentionMatches.length > 0;
  const hasSendableContent = !!input.trim() || contextFiles.some((file) => file.isImage && !!file.dataUrl);

  useEffect(() => { setSlashIndex(0); }, [input]);
  useEffect(() => { setMentionIndex(0); }, [mentionQuery]);

  useEffect(() => {
    if (mentionQuery != null && fileList == null) {
      void ensureFileList().catch(() => { /* A later edit can retry the lookup. */ });
    }
  }, [mentionQuery, fileList, ensureFileList]);

  useEffect(() => {
    if (inputContent) {
      // Append, never overwrite: a pin or picked element lands after whatever
      // the user already typed.
      setInput((prev) => (prev ? `${prev}\n${inputContent}` : inputContent));
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

  useEffect(() => {
    if (centered) {
      textareaRef.current?.focus();
    }
  }, [centered]);

  const resetHeight = () => { if (textareaRef.current) textareaRef.current.style.height = 'auto'; };

  const refreshMention = (value: string, caretPos: number) => {
    setCaret(caretPos);
    const tok = mentionTokenAt(value, caretPos);
    setMentionQuery(tok);
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
    if (isSavingEdit || installHolding) return;
    const needsModel = cmd.kind === 'prompt' || ['clear', 'compact', 'goal'].includes(cmd.name);
    if (needsModel && !selectedModel) {
      if (!useUIStore.getState().modelSelectorOpen) toggleModelSelector();
      return;
    }
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
        if (selectedModel) await newConversation(pid!, mid!);
        break;
      case 'compact':
        if (selectedModel) await compactConversation(pid!, mid!);
        break;
      case 'plan':
        togglePlanMode();
        break;
      case 'mode': {
        const wanted = args.trim().toLowerCase() as AgentMode;
        if (!wanted || !AGENT_MODES.includes(wanted)) {
          setInput('/mode ');
          requestAnimationFrame(() => textareaRef.current?.focus());
          break;
        }
        setAgentMode(wanted);
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
        const conversationId = activeConversationId || await newConversation(pid!, mid!);
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
      case 'image':
      case 'imagine':
        useImageGenStore.getState().openModal(args.trim());
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
    if (result.ok) {
      await reloadProjectConfig();
      // Memory 2.0 should see an explicitly captured rule too. The file write
      // above remains the human-editable source of truth; this adds the
      // structured, searchable record without replacing it.
      if (isMemoryV2Active()) {
        await useMemoryV2Store.getState().saveMemory({
          content: text,
          type: 'constraint',
          layer: scope === 'project' ? 'project' : 'global',
          projectId: scope === 'project' ? undefined : null,
          tags: ['quick-capture', scope],
          importance: 0.8,
          status: 'confirmed',
          origin: 'user',
        });
      }
    }
    await pushNotice(
      `${result.ok ? '🧠' : '⚠️'} ${result.message}`,
      selectedModel?.providerId, selectedModel?.id,
    );
  };

  const handleSend = async () => {
    if (isSavingEdit || installHolding) return;
    const text = input;
    // A pasted/attached image can carry a textless turn ("paste, hit send").
    if (!hasSendableContent) return;

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

    if (!selectedModel) {
      if (!useUIStore.getState().modelSelectorOpen) toggleModelSelector();
      return;
    }
    // An armed skill leads the message with its full instructions (same shape
    // as the use_skill tool result, so the agent treats it identically), then
    // disarms — one skill, one message.
    const skill = activeSkill;
    let full = text;
    if (skill) {
      const body = skillBody(skill.id);
      if (body) full = `Skill "${skill.id}" — follow these instructions for this task:\n\n${body}\n\n${text}`;
      setActiveSkillId(null);
    }
    // Mid-run typing queues behind the live run (opencode-style) instead of
    // being swallowed: it becomes the next turn when this one ends.
    if (isStreaming && activeConversationId) {
      enqueueMessage(activeConversationId, full, selectedModel.providerId, selectedModel.id);
      setInput('');
      setMentionQuery(null);
      resetHeight();
      return;
    }
    setInput('');
    setMentionQuery(null);
    resetHeight();
    await sendMessage(full, selectedModel.providerId, selectedModel.id);
  };

  // OpenCode-style: keep chatting here, run this text in a fresh background
  // conversation (skill prefix applies the same as a normal send).
  const handleBackgroundSend = async () => {
    if (isStreaming || isSavingEdit || installHolding) return;
    const text = input;
    if (!text.trim() || !selectedModel) return;
    const skill = activeSkill;
    let full = text;
    if (skill) {
      const body = skillBody(skill.id);
      if (body) full = `Skill "${skill.id}" — follow these instructions for this task:\n\n${body}\n\n${text}`;
      setActiveSkillId(null);
    }
    setInput('');
    setMentionQuery(null);
    resetHeight();
    await launchBackground(full);
  };

  const isImeConfirm = (e: React.KeyboardEvent) => {
    const native = e.nativeEvent as any;
    const justComposed = Date.now() - compositionEndAtRef.current < 250;
    return composingRef.current || native.isComposing || native.keyCode === 229 || justComposed;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Candidate navigation and confirmation belong to the IME until composition
    // finishes, including its Arrow keys and Tab key.
    if (isImeConfirm(e) && e.key !== 'Escape') return;
    if (e.key === 'Escape' && skillPickerOpen) {
      e.preventDefault();
      setSkillPickerOpen(false);
      return;
    }
    if (e.key === 'Escape' && plusOpen) {
      e.preventDefault();
      setPlusOpen(false);
      return;
    }
    if (showSlash) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return; }
      const command = slashMatches[slashIndex] ?? slashMatches[0];
      if (e.key === 'Tab') { e.preventDefault(); setInput('/' + command.name + ' '); return; }
      if (e.key === 'Enter' && !e.shiftKey && !isImeConfirm(e)) {
        e.preventDefault();
        void runCommand(command, '');
        return;
      }
    } else if (showMention) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return; }
      if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey && !isImeConfirm(e)) {
        e.preventDefault();
        acceptMention(mentionMatches[mentionIndex] ?? mentionMatches[0]);
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

  const getFileName = (path: string) => path.split(/[\\/]/).pop() || path;
  const columnClass = 'max-w-[900px] mx-auto w-full px-4';

  return (
    <div className={centered
      ? "w-full max-w-[840px] mx-auto min-w-0 transition-colors"
      : "bg-[color-mix(in_srgb,var(--glass-surface)_60%,transparent)] backdrop-blur-2xl border-t border-[var(--glass-border)] transition-colors"
    }>
      {/* Interrupted-run resume: one click picks up where the reply stopped. */}
      {continuableConvId === activeConversationId && !!activeConversationId && !isStreaming && !isSavingEdit && !installHolding && (
        <div className={`${columnClass} pt-2.5 flex justify-center`}>
          <button
            onClick={() => void continueGeneration()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium bg-[var(--accent-soft)] text-[var(--accent)] border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] hover:bg-[var(--accent)] hover:text-white transition-all shadow-2xs cursor-pointer"
          >
            <FiPlay size={11} />
            {t('continueOutput')}
          </button>
        </div>
      )}
      {/* Context files indicator */}
      {(autoIncludeFileContext && selectedFile) || contextFiles.length > 0 || activeSkill ? (
        <div className={`${columnClass} pt-2.5 pb-1`}>
          <div className="flex flex-wrap gap-1.5">
            {activeSkill && (
              <span title={activeSkill.description || activeSkill.name}
                className="inline-flex max-w-full min-w-0 items-center gap-1.5 px-3 py-1 rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] text-xs font-medium border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] backdrop-blur-md shadow-2xs">
                <FiTool size={11} className="shrink-0" />
                <span className="truncate">{activeSkill.name}</span>
                <button onClick={() => setActiveSkillId(null)} aria-label={`${t('dismiss')} ${activeSkill.name}`} className="ml-0.5 shrink-0 hover:opacity-70 transition-opacity cursor-pointer">
                  <FiX size={11} />
                </button>
              </span>
            )}
            {autoIncludeFileContext && selectedFile && (
              <span title={selectedFile} className="inline-flex max-w-full min-w-0 items-center gap-1.5 px-3 py-1 rounded-xl bg-[var(--glass-card)] text-[var(--accent)] text-xs font-medium border border-[var(--glass-border)] backdrop-blur-md shadow-2xs">
                <FiPaperclip size={11} className="shrink-0" />
                <span className="truncate">{getFileName(selectedFile)} (auto)</span>
              </span>
            )}
            {contextFiles.map((file) => (
              <span key={file.path} title={file.path} className="inline-flex max-w-full min-w-0 items-center gap-1.5 px-3 py-1 rounded-xl bg-[var(--glass-card)] text-[var(--text-secondary)] text-xs border border-[var(--glass-border)] backdrop-blur-md shadow-2xs">
                {file.isImage && file.dataUrl ? (
                  <img src={file.dataUrl} alt={getFileName(file.path)} className="h-8 w-8 object-cover rounded-lg shadow-2xs" title={file.path} />
                ) : (
                  <FiPaperclip size={11} className="shrink-0" />
                )}
                {!file.isImage && <span className="truncate">{getFileName(file.path)}</span>}
                <button onClick={() => removeContextFile(file.path)} aria-label={`${t('dismiss')} ${getFileName(file.path)}`} className="ml-0.5 shrink-0 hover:text-[var(--text-primary)] transition-colors cursor-pointer">
                  <FiX size={11} />
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* "#" capture — ask where it belongs rather than guessing. */}
      {pendingCapture && (
        <div className={`${columnClass} pt-2`}>
          <div className="rounded-2xl border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[var(--glass-card)] backdrop-blur-xl px-4 py-3 shadow-lg">
            <div className="text-[11px] text-[var(--text-muted)] mb-1 font-medium">{t('captureWhere')}</div>
            <div className="text-[13px] text-[var(--text-primary)] mb-2.5 break-words font-medium">{pendingCapture}</div>
            <div className="flex items-center gap-2">
              <button onClick={() => commitCapture('project')} disabled={!rootPath}
                className="px-3 py-1.5 rounded-xl bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40 shadow-xs cursor-pointer">
                {t('captureProject')}
              </button>
              <button onClick={() => commitCapture('user')}
                className="px-3 py-1.5 rounded-xl bg-[var(--glass-card)] border border-[var(--glass-border)] text-[var(--text-secondary)] text-xs font-medium hover:bg-[var(--bg-3)] cursor-pointer">
                {t('captureUser')}
              </button>
              <button onClick={() => setPendingCapture(null)}
                className="ml-auto px-2.5 py-1.5 rounded-xl text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer">
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={`relative ${columnClass} pt-2 pb-1.5`}>
        {/* Slash-command palette */}
        {showSlash && (
          <div className="absolute bottom-full left-6 right-6 mb-2 max-h-64 overflow-y-auto rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-surface)] backdrop-blur-2xl shadow-2xl z-50 py-1.5 anim-menu ring-1 ring-black/5 dark:ring-white/10" style={{ ['--menu-origin' as any]: 'bottom left', ['--menu-shift' as any]: '6px' }}>
            <div className="px-3.5 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">{t('commandsTitle')}</div>
            {slashMatches.map((c, i) => (
              <button
                key={c.name}
                onMouseEnter={() => setSlashIndex(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void runCommand(c, '')}
                disabled={isSavingEdit || installHolding}
                className={`w-full text-left px-3.5 py-2 flex items-center gap-2.5 transition-colors ${i === slashIndex ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium' : 'hover:bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] text-[var(--text-secondary)]'}`}
              >
                <span className="font-mono text-xs text-[var(--accent)] shrink-0">/{c.name}</span>
                <span className="text-xs truncate">{c.custom ? c.description : t(c.description)}</span>
                {c.custom && <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-muted)] shrink-0">{t('custom')}</span>}
              </button>
            ))}
          </div>
        )}

        {/* @-mention file palette */}
        {showMention && (
          <div className="absolute bottom-full left-6 right-6 mb-2 max-h-64 overflow-y-auto rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-surface)] backdrop-blur-2xl shadow-2xl z-50 py-1.5 anim-menu ring-1 ring-black/5 dark:ring-white/10" style={{ ['--menu-origin' as any]: 'bottom left', ['--menu-shift' as any]: '6px' }}>
            <div className="px-3.5 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">{t('mentionFiles')}</div>
            {mentionMatches.map((f, i) => (
              <button
                key={f}
                onMouseEnter={() => setMentionIndex(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => acceptMention(f)}
                className={`w-full text-left px-3.5 py-2 flex items-center gap-2.5 transition-colors ${i === mentionIndex ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium' : 'hover:bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] text-[var(--text-secondary)]'}`}
              >
                <FiFile size={13} className="text-[var(--text-muted)] shrink-0" />
                <span className="text-xs truncate">{f}</span>
              </button>
            ))}
          </div>
        )}

        {activeConversationId && <QueuedMessages key={activeConversationId} conversationId={activeConversationId} />}
        {/* Composer box */}
        <div className={`chat-composer relative rounded-[20px] border border-[var(--glass-border)] bg-[var(--glass-card)] backdrop-blur-2xl pl-3 pr-2.5 py-2 focus-within:border-[color-mix(in_srgb,var(--accent)_50%,transparent)] focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,var(--accent)_15%,transparent)] transition-all ${
          centered
            ? 'shadow-[0_12px_44px_rgba(0,0,0,0.08)] dark:shadow-[0_16px_50px_rgba(0,0,0,0.4)]'
            : 'shadow-[0_8px_32px_rgba(0,0,0,0.06)] dark:shadow-[0_12px_44px_rgba(0,0,0,0.35)]'
        }`}>
          <div className="flex items-end gap-2.5">
            {/* + menu: upload + agent modes (no standalone plan/attach clutter). */}
            <div className="relative shrink-0 mb-0.5">
              <button
                onClick={() => { setPlusOpen((v) => !v); setSkillPickerOpen(false); }}
                title={t('modeMenu')}
                aria-label={t('modeMenu')}
                aria-expanded={plusOpen}
                className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all cursor-pointer ${
                  plusOpen || agentMode !== 'standard' || activeSkill
                    ? 'text-[var(--accent)] bg-[var(--accent-soft)] shadow-2xs border border-[color-mix(in_srgb,var(--accent)_30%,transparent)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_70%,transparent)]'
                }`}
              >
                <FiPlus size={18} />
              </button>
              {plusOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setPlusOpen(false)} />
                  <div
                    className="absolute bottom-full left-0 mb-2.5 w-64 rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-surface)] backdrop-blur-2xl shadow-2xl z-50 py-1.5 anim-menu ring-1 ring-black/5 dark:ring-white/10"
                    style={{ ['--menu-origin' as any]: 'bottom left', ['--menu-shift' as any]: '6px' }}
                  >
                    <button
                      onClick={() => { void handleAttach(); setPlusOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                    >
                      <FiPaperclip size={14} className="text-[var(--text-muted)]" />
                      <span className="flex-1 text-left font-medium">{t('attachFiles')}</span>
                    </button>
                    <button
                      onClick={() => { setPlusOpen(false); setSkillPickerOpen(false); void startScreenshot(); }}
                      disabled={screenshotStarting}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      <FiCamera size={14} className="text-[var(--text-muted)]" />
                      <span className="flex-1 text-left font-medium">{t('screenshot')}</span>
                      {screenshotShortcut && (
                        <kbd className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--glass-card)] border border-[var(--glass-border)] text-[var(--text-muted)] font-sans shrink-0">
                          {prettyShortcut(screenshotShortcut)}
                        </kbd>
                      )}
                    </button>
                    <button
                      onClick={() => { void handleBackgroundSend(); setPlusOpen(false); }}
                      disabled={!input.trim() || !selectedModel || isStreaming || isSavingEdit || installHolding}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      <FiClock size={14} className="text-[var(--text-muted)]" />
                      <span className="flex-1 text-left font-medium">{t('backgroundSend')}</span>
                    </button>
                    <div className="my-1.5 border-t border-[var(--glass-border)]" />
                    {/* One row → popup with the full skill list. */}
                    <button
                      onClick={() => setSkillPickerOpen((v) => !v)}
                      className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] transition-colors cursor-pointer ${
                        skillPickerOpen || activeSkill
                          ? 'text-[var(--accent)] bg-[var(--accent-soft)] font-medium'
                          : 'text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <FiTool size={14} />
                      <span className="flex-1 text-left truncate font-medium">
                        {activeSkill ? activeSkill.name : t('selectSkill')}
                      </span>
                      <FiChevronRight size={13} className="shrink-0 text-[var(--text-muted)]" />
                    </button>
                    {skillPickerOpen && (
                      <div
                        className="absolute left-full bottom-0 ml-2.5 w-64 rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-surface)] backdrop-blur-2xl shadow-2xl z-50 py-1.5 anim-menu ring-1 ring-black/5 dark:ring-white/10"
                        style={{ ['--menu-origin' as any]: 'bottom left', ['--menu-shift' as any]: '6px' }}
                      >
                        <div className="px-3.5 pb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">
                          {t('skills')}
                        </div>
                        {effectiveSkills.length === 0 ? (
                          <div className="px-3.5 py-2 text-[12px] text-[var(--text-muted)] leading-snug">
                            {t('noSkillsYet')}
                          </div>
                        ) : (
                          <div className="max-h-48 overflow-y-auto">
                            {effectiveSkills.map((skill) => (
                              <button
                                key={`${skill.scope}:${skill.id}`}
                                onClick={() => { setActiveSkillId(skill.id); setSkillPickerOpen(false); setPlusOpen(false); textareaRef.current?.focus(); }}
                                title={skill.description || skill.name}
                                className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors cursor-pointer ${
                                  activeSkillId === skill.id
                                    ? 'text-[var(--accent)] bg-[var(--accent-soft)] font-medium'
                                    : 'text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] hover:text-[var(--text-primary)]'
                                }`}
                              >
                                <FiTool size={13} className="shrink-0" />
                                <span className="flex-1 text-left truncate">{skill.name}</span>
                                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--glass-card)] border border-[var(--glass-border)] text-[var(--text-muted)] shrink-0">
                                  {skill.scope === 'project' ? t('skillProjectShort') : t('skillGlobalShort')}
                                </span>
                                {activeSkillId === skill.id && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
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
              placeholder={
                isStreaming
                  ? t('queueHint')
                  : agentMode !== 'standard'
                    ? `${t(agentMode === 'goal' ? 'agentModeGoal' : agentMode === 'orchestrate' ? 'modeOrchestrate' : agentMode === 'rsi' ? 'modeRsi' : 'agentModeStandard')} · ${t('typeMessage')}`
                    : t('typeMessage')
              }
              rows={1}
              aria-label={t('typeMessage')}
              className="flex-1 min-w-0 bg-transparent border-0 py-2 text-[16px] font-[450] leading-relaxed resize-none outline-none max-h-[200px] overflow-y-auto placeholder:text-[var(--text-muted)]"
            />

            {isStreaming ? (
              <button onClick={() => stopGeneration()}
                aria-label={t('cancel')}
                title={t('cancel')}
                className="w-9 h-9 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:bg-[var(--accent-hover)] transition-all shadow-[0_4px_14px_rgba(201,100,66,0.35)] hover:scale-105 active:scale-95 shrink-0 mb-0.5 anim-press cursor-pointer">
                <FiSquare size={14} />
              </button>
            ) : (
              <button onClick={handleSend}
                disabled={!hasSendableContent || isSavingEdit || installHolding}
                aria-label={t('send')}
                title={sendWithEnter ? t('sendHintEnter') : t('sendHintCmd')}
                className="w-9 h-9 rounded-full flex items-center justify-center transition-all bg-gradient-to-tr from-[var(--accent)] to-[#e88a6a] text-white shadow-[0_4px_14px_rgba(201,100,66,0.35)] disabled:opacity-30 disabled:shadow-none hover:shadow-[0_6px_20px_rgba(201,100,66,0.45)] hover:scale-105 active:scale-95 shrink-0 mb-0.5 anim-press cursor-pointer disabled:cursor-not-allowed">
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
