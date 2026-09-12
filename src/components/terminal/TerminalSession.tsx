import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useWorkspaceStore } from '../../stores';
import { parseAnsi } from './ansi';

// One interactive shell, keyed by a unique `id`. Stays mounted while its tab is
// backgrounded (hidden via `active`) so the underlying process keeps running.
export default function TerminalSession({ id, active }: { id: string; active: boolean }) {
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const [lines, setLines] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [alive, setAlive] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cleanupRef = useRef<(() => void)[]>([]);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
    });
  }, []);

  const spawnShell = useCallback(() => {
    cleanupRef.current.forEach((fn) => fn());
    cleanupRef.current = [];

    const cwd = rootPath || undefined;
    window.electronAPI.terminal.spawn(id, cwd);
    setAlive(true);
    setLines([]);

    const unsub1 = window.electronAPI.terminal.onData((p: { id: string; data: string }) => {
      if (p.id !== id) return;
      setLines((prev) => [...prev, p.data]);
      scrollToBottom();
    });
    const unsub2 = window.electronAPI.terminal.onExit((p: { id: string; code: number }) => {
      if (p.id !== id) return;
      setLines((prev) => [...prev, `\n[Process exited with code ${p.code}]\n`]);
      setAlive(false);
      scrollToBottom();
    });
    cleanupRef.current = [unsub1, unsub2];
  }, [id, rootPath, scrollToBottom]);

  useEffect(() => {
    spawnShell();
    return () => {
      cleanupRef.current.forEach((fn) => fn());
      window.electronAPI.terminal.kill(id);
    };
  }, []);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active, alive]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!alive) {
      spawnShell();
      return;
    }
    // Echo the command into the scrollback so the session reads like a real
    // terminal (the piped, non-TTY shell does not echo input itself).
    setLines((prev) => [...prev, `$ ${input}\n`]);
    window.electronAPI.terminal.write(id, input + '\n');
    setInput('');
    scrollToBottom();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      window.electronAPI.terminal.write(id, '\x03');
    }
  };

  // Join the streamed chunks and parse ANSI color/style codes into styled spans.
  const segments = useMemo(() => parseAnsi(lines.join('')), [lines]);

  return (
    <div
      ref={scrollRef}
      className={`h-full overflow-y-auto px-4 py-2 font-mono text-[13px] leading-[1.6] text-[var(--text-primary)] whitespace-pre-wrap break-all ${active ? '' : 'hidden'}`}
      onClick={() => inputRef.current?.focus()}
    >
      {segments.map((seg, i) => (
        <span key={i} style={seg.style}>{seg.text}</span>
      ))}
      {alive ? (
        <form onSubmit={handleSubmit} className="flex items-center gap-1.5">
          <span className="text-[var(--accent)] shrink-0">$</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent font-mono text-[13px] outline-none caret-[var(--accent)]"
            spellCheck={false}
            autoComplete="off"
          />
        </form>
      ) : (
        <button
          onClick={spawnShell}
          className="mt-1 text-[13px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
        >
          Press to restart shell...
        </button>
      )}
    </div>
  );
}
