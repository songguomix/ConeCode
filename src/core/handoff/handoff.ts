import type { Message } from '../../types/chat.types';

/**
 * One-click conversation handoff: the active transcript plus a "read this
 * first" prompt, rendered as a .md file the user drags into another agent.
 * Pure — the view supplies the localized prompt, Electron writes the file.
 */

export interface HandoffInput {
  title: string;
  modelLabel: string;
  projectPath: string;
  exportedAt: number;
  /** Localized instruction block for the receiving agent (top of file). */
  prompt: string;
  /** Localized one-liner telling the human what to do with the file. */
  howTo: string;
  messages: Message[];
  /** Include tool calls on assistant turns (default true). */
  includeTools?: boolean;
  /** Include tool-result bodies, capped (default true). */
  includeToolResults?: boolean;
}

const TOOL_ARG_CAP = 1000;
const TOOL_RESULT_CAP = 3000;

function cut(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n…(truncated, ${s.length} chars total)`;
}

function stamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

export function slugifyTitle(title: string): string {
  const s = title.trim().replace(/\s+/g, '-').replace(/[/\\?%*:|"<>]/g, '').slice(0, 40);
  return s || 'untitled';
}

export function handoffFilename(title: string, at = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stampStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `conecode-handoff-${slugifyTitle(title)}-${stampStr}.md`;
}

/** Transcript turns worth handing over; local app notices stay behind. */
export function handoffMessages(messages: Message[]): Message[] {
  return messages.filter((m) => {
    if (m.isLocalNotice) return false;
    if (m.role === 'system') return false;
    if (m.role === 'tool') return true;
    if ((m.content || '').trim()) return true;
    return !!(m.toolCalls && m.toolCalls.length > 0);
  });
}

export function buildHandoffMarkdown(input: HandoffInput): string {
  const turns = handoffMessages(input.messages);
  const includeTools = input.includeTools !== false;
  const includeResults = input.includeToolResults !== false;
  const shown = turns.filter((m) => {
    if (m.role === 'tool' || m.isToolResult) return includeResults;
    return true;
  });
  const lines: string[] = [
    `# ${input.title || 'Untitled'} — handoff`,
    ``,
    `> exported ${stamp(input.exportedAt)} · model ${input.modelLabel} · project ${input.projectPath || '—'}`,
    `> ${input.howTo}`,
    ``,
    `## HANDOFF — READ THIS FIRST`,
    ``,
    input.prompt,
    ``,
    `---`,
    ``,
    `## TRANSCRIPT (${shown.length} turns)`,
    ``,
  ];
  for (const m of shown) {
    if (m.role === 'user') {
      lines.push(`### User · ${stamp(m.createdAt)}`, ``, m.content.trim(), ``);
    } else if (m.role === 'assistant') {
      lines.push(`### Assistant · ${stamp(m.createdAt)}`, ``);
      if ((m.content || '').trim()) lines.push(m.content.trim(), ``);
      if (includeTools) {
        for (const c of m.toolCalls || []) {
          const args = cut(JSON.stringify(c.arguments ?? {}), TOOL_ARG_CAP);
          lines.push(`- Tool \`${c.name}\`: \`${args}\``, ``);
        }
        if (!(m.content || '').trim() && !(m.toolCalls || []).length && m.toolName) {
          lines.push(`- Tool \`${m.toolName}\``, ``);
        }
      }
    } else {
      // role 'tool' or flagged tool result: evidence, capped.
      const label = m.toolName ? `Tool result (${m.toolName})` : 'Tool result';
      lines.push(`### ${label} · ${stamp(m.createdAt)}`, ``, cut((m.content || '').trim(), TOOL_RESULT_CAP), ``);
    }
  }
  return lines.join('\n');
}
