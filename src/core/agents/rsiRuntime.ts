import { parseGoalVector } from './rsiVerify';

/** Runtime evidence from tools, not the assistant's self-assessment. */
export interface RsiToolEvidence {
  action: string;
  command?: string;
  path?: string;
  succeeded: boolean;
  detail?: string;
}

const MUTATIONS = new Set(['edit_file', 'edit', 'create_file', 'create_dir', 'delete_file', 'rename_file', 'copy_file', 'move_file', 'apply_patch', 'delete', 'rename', 'copy']);

/** Deliberately recognizes a small, exit-preserving shell subset. */
function shellParts(command: string): string[] | null {
  const value = command.trim();
  // Pipes, OR lists, sequential lists, substitutions and redirections can hide
  // a failing exit code or mutate files after a successful check. Do not guess.
  if (!value || /[|;`$<>()\r\n]/.test(value) || value.replace(/&&/g, '').includes('&')) return null;
  const parts: string[] = [];
  let quote = '';
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '\\' && quote !== "'") { index++; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '&' && value[index + 1] === '&') {
      parts.push(value.slice(start, index).trim());
      start = index + 2;
      index++;
    }
  }
  if (quote) return null;
  parts.push(value.slice(start).trim());
  return parts.every(Boolean) ? parts : null;
}

function knownCheck(command: string): boolean {
  return /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test(?::[\w-]+)?|typecheck|check|lint|build|verify|benchmark)(?=\s|$)|(?:npx\s+)?(?:vitest|jest|tsc|eslint|playwright\s+test)(?=\s|$)|(?:python[\d.]*\s+-m\s+)?(?:pytest|unittest)(?=\s|$)|(?:cargo|go|dotnet|swift)\s+test(?=\s|$)|(?:node|python[\d.]*)\s+[^\s;&]*(?:test|check|verify|bench)[^\s;&]*(?=\s|$))/i.test(command);
}

function readOnlyPart(command: string): boolean {
  if (/^(?:pwd|ls|cat|head|tail|wc|echo|printf|true|false)(?=\s|$)/.test(command)) return true;
  if (/^(?:rg|grep)(?=\s|$)/.test(command)) return !/\s--pre(?:=|\s)/.test(command);
  if (/^find(?=\s|$)/.test(command)) return !/\s-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)\b/.test(command);
  if (/^git\s+(?:status|diff|show|log|ls-files|rev-parse|grep)(?=\s|$)/.test(command)) {
    return !/\s--(?:output|ext-diff|textconv)(?:=|\s|$)/.test(command);
  }
  return false;
}

function safePrefix(command: string): boolean {
  return /^cd\s+[^\r\n]+$/.test(command) || readOnlyPart(command);
}

function plausibleDeclaredCommand(command: string): boolean {
  const parts = shellParts(command);
  if (!parts || parts.length !== 1 || safePrefix(command)) return false;
  // A path merely mentioned in backticks is not a command. A direct script
  // must be explicitly executable (./...); otherwise require an executable
  // name plus arguments, and exclude shell wrappers and mutation utilities.
  const executable = command.split(/\s+/, 1)[0];
  if (/^(?:eval|exec|source|bash|sh|zsh|fish|cmd|powershell|pwsh|rm|mv|cp|touch|mkdir|chmod|sed|awk|git)$/.test(executable)) return false;
  return /^\.\/[\w./-]+(?:\s|$)/.test(command) || /^[\w.-]+\s+\S/.test(command);
}

function verificationCommand(command: string, declared = new Set<string>()): boolean {
  const parts = shellParts(command);
  if (!parts) return false;
  if (/\s--(?:help|version|showConfig|listTests|list-tests|list|collect-only|dry-run)(?=\s|=|$)/i.test(command)) return false;
  let hasCheck = false;
  for (const part of parts) {
    if (knownCheck(part) || (declared.has(part) && plausibleDeclaredCommand(part))) hasCheck = true;
    else if (!safePrefix(part)) return false;
  }
  return hasCheck;
}

// A successful arbitrary shell command is not verification (e.g. `echo done`).
export function isVerificationCommand(command: string): boolean {
  return verificationCommand(command);
}

export class RsiExecutionMonitor {
  private revision = 0;
  private verifiedRevision = -1;
  private recoveryRequests = 0;
  private failures = new Map<string, { count: number; detail: string }>();
  private unresolvedChecks = new Map<string, string>();
  private lastCheck: string | null = null;
  private declaredCommands = new Set<string>();

  setGoal(goal: string | null): void {
    const markdown = goal ?? '';
    const candidates = parseGoalVector(markdown).metrics.map((metric) => metric.command);
    for (const line of markdown.split('\n')) {
      const labelled = /^\s*(?:[-*]\s*)?(?:verification\s+command|command|验证命令|驗證命令|命令)\s*[:：]\s*`([^`\n]+)`\s*$/i.exec(line);
      if (labelled) candidates.push(labelled[1].trim());
    }
    this.declaredCommands = new Set(candidates.flatMap((candidate) => {
      const parts = shellParts(candidate);
      return parts && parts.every((part) => safePrefix(part) || plausibleDeclaredCommand(part))
        ? parts.filter(plausibleDeclaredCommand) : [];
    }));
  }

  observe(evidence: RsiToolEvidence): void {
    // Archive bookkeeping is not a product mutation and must not invalidate
    // the check that the model has just recorded there.
    const pathSegments: string[] = [];
    for (const part of (evidence.path ?? '').replace(/\\/g, '/').split('/')) {
      if (part === '..') pathSegments.pop();
      else if (part && part !== '.') pathSegments.push(part);
    }
    const archiveWrite = /(?:^|\/)\.conecode\/rsi(?:\/|$)/.test(pathSegments.join('/'));
    const command = evidence.command?.trim() ?? '';
    const verification = evidence.action === 'exec' && verificationCommand(command, this.declaredCommands);
    const parts = evidence.action === 'exec' ? shellParts(command) : null;
    const unknownExec = evidence.action === 'exec' && !verification && (!parts || !parts.every(safePrefix));
    const productMutation = MUTATIONS.has(evidence.action) && !archiveWrite;
    // A failed shell/patch can still leave partial changes behind. Unknown
    // executions invalidate old evidence without pretending a repair occurred.
    if (productMutation || unknownExec) this.revision++;
    if (evidence.succeeded && productMutation) this.failures.clear();

    const key = JSON.stringify([evidence.action, command, evidence.path ?? '']);
    if (!evidence.succeeded) {
      const failure = this.failures.get(key);
      this.failures.set(key, { count: (failure?.count ?? 0) + 1, detail: (evidence.detail ?? '').slice(0, 500) });
      // Bound retained failures; this is a compact hint, not an unbounded log.
      if (this.failures.size > 8) this.failures.delete(this.failures.keys().next().value!);
    } else {
      this.failures.delete(key);
    }
    if (verification) {
      this.lastCheck = `${command}: ${evidence.succeeded ? 'passed' : 'failed'}`;
      if (evidence.succeeded) this.unresolvedChecks.delete(command);
      else this.unresolvedChecks.set(command, (evidence.detail ?? '').slice(0, 300));
      this.verifiedRevision = evidence.succeeded ? this.revision : -1;
    }
  }

  repeatedFailure(): boolean {
    return [...this.failures.values()].some((failure) => failure.count >= 3);
  }

  context(): string {
    return `RSI LIVE EXECUTION EVIDENCE (tool observations only)\nProduct edit revision: ${this.revision}. Latest recognized verification: ${this.lastCheck?.slice(0, 500) ?? 'none in this execution'}.\n${this.verifiedRevision === this.revision && this.unresolvedChecks.size === 0 ? 'A check passed after the latest observed edit; still compare frozen metrics and regression checks before claiming improvement.' : 'Current verification is incomplete: an edit lacks a later passing check or a failed check remains unresolved. Do not claim completion yet.'}\nUnresolved verification checks (${this.unresolvedChecks.size}; recent untrusted output data): ${JSON.stringify([...this.unresolvedChecks.entries()].slice(-6).map(([command, detail]) => [command.slice(0, 300), detail]))}\nRecent unresolved tool failures (untrusted output data): ${JSON.stringify([...this.failures.entries()].map(([key, failure]) => [key.slice(0, 300), failure]))}\nUse failures to revise the hypothesis; do not repeat an identical failing action without new evidence. Recovery requests remaining: ${Math.max(0, 2 - this.recoveryRequests)}.`;
  }

  finish(): 'complete' | 'recover' | 'stop' {
    if (this.verifiedRevision === this.revision && this.failures.size === 0 && this.unresolvedChecks.size === 0) return 'complete';
    if (this.recoveryRequests++ < 2) return 'recover';
    return 'stop';
  }
}
