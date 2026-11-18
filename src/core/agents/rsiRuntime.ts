import { parseGoalChecks } from './rsiVerify';

/** Runtime evidence from tools, not the assistant's self-assessment. */
export interface RsiToolEvidence {
  action: string;
  command?: string;
  cwd?: string;
  path?: string;
  destPath?: string;
  succeeded: boolean;
  detail?: string;
}

const MUTATIONS = new Set(['edit_file', 'edit', 'create_file', 'create_dir', 'delete_file', 'apply_patch', 'delete', 'download']);

/** Deliberately recognizes a small, exit-preserving shell subset. */
function shellParts(command: string): string[] | null {
  const value = command.trim();
  // Pipes, OR lists, sequential lists, substitutions and redirections can hide
  // a failing exit code or mutate files after a successful check. Do not guess.
  if (!value || /[|;#`$<>()\r\n]/.test(value) || value.replace(/&&/g, '').includes('&')) return null;
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
  if (/\s--(?:help|version|showConfig|listTests|list-tests|list|collect-only|dry-run|fix|write|updateSnapshot)(?=\s|=|$)/i.test(command)) return false;
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

// Each step includes its effective working directory. Preserve ".." literally:
// its resolution can depend on symlinks that the renderer cannot inspect.
function directoryKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/\.(?=\/|$)/g, '').replace(/\/+$/, '');
  return normalized || (path.startsWith('/') ? '/' : '.');
}

function scopedSteps(parts: string[], cwd: string): string[] | null {
  let directory = directoryKey(cwd);
  const steps: string[] = [];
  for (const part of parts) {
    if (/^cd\s/.test(part)) {
      const literal = /^cd\s+(?:"([^"\\]+)"|'([^']+)'|([\w./-]+))$/.exec(part);
      const path = literal?.[1] ?? literal?.[2] ?? literal?.[3];
      if (!path || path.startsWith('-')) return null;
      directory = directoryKey(/^(?:\/|[a-z]:[\\/])/i.test(path) ? path : directory + '/' + path);
    } else {
      steps.push(JSON.stringify([directory, part]));
    }
  }
  return steps;
}

function includesSteps(observed: string[], required: string[]): boolean {
  return required.length > 0 && observed.some((_, start) =>
    required.every((step, offset) => step === observed[start + offset]));
}

function isArchivePath(path?: string): boolean {
  const segments: string[] = [];
  for (const part of (path ?? '').replace(/\\/g, '/').split('/')) {
    if (part === '..') segments.pop();
    else if (part && part !== '.') segments.push(part);
  }
  return /(?:^|\/)\.conecode\/rsi(?:\/|$)/.test(segments.join('/'));
}

function writesProduct({ action, path, destPath }: RsiToolEvidence): boolean {
  if (/^(?:copy|copy_file)$/.test(action)) return !isArchivePath(destPath);
  if (/^(?:rename|rename_file|move_file)$/.test(action)) return !isArchivePath(path) || !isArchivePath(destPath);
  return MUTATIONS.has(action) && !isArchivePath(path);
}

interface FailedVerification {
  label: string;
  steps: string[];
  detail: string;
  diagnostic: string;
  lastEdit: number;
  unsuccessfulRepairs: number;
}

export class RsiExecutionMonitor {
  private revision = 0;
  private successfulEdits = 0;
  private verifiedRevision = -1;
  private recoveryRequests = 0;
  private failures = new Map<string, { count: number; detail: string }>();
  private unresolvedChecks = new Map<string, FailedVerification>();
  private lastCheck: string | null = null;
  private declaredCommands = new Set<string>();
  private required = new Map<string, string[]>();
  private passed = new Set<string>();
  private frozenGoal: string | null = null;
  private goalIssue = '';
  private screenshot: 'needed' | 'requested' | 'reviewed' | { ticket: number } | { error: string } = 'needed';
  private captureSequence = 0;

  constructor(private readonly workspaceRoot = '.') {}

  setGoal(goal: string | null): void {
    const markdown = (goal ?? '').trim().replace(/\r\n/g, '\n');
    if (this.frozenGoal !== null) {
      this.goalIssue = markdown === this.frozenGoal ? '' : 'The frozen verification contract changed or is unreadable. Restore it or start a newly authorized run.';
      if (this.goalIssue) {
        this.passed.clear();
        this.screenshot = 'needed';
      }
      return;
    }
    const { commands, issues } = parseGoalChecks(markdown);
    if (!commands.length && !issues.length) return;
    this.declaredCommands.clear();
    this.required.clear();
    this.passed.clear();
    this.screenshot = 'needed';
    for (const command of commands) {
      // Every run already has this final gate, including older goal files.
      if (command === 'auto_screenshot') continue;
      if (command === 'perf_snapshot') {
        this.required.set(command, ['perf_snapshot']);
        continue;
      }
      const parts = shellParts(command);
      const declared = new Set(parts?.filter(plausibleDeclaredCommand));
      const steps = parts && scopedSteps(parts, this.workspaceRoot);
      if (!parts || !steps?.length || !verificationCommand(command, declared) || /^cd\s/.test(parts[parts.length - 1])) {
        issues.push('Unsupported frozen check: ' + command);
        continue;
      }
      for (const part of declared) this.declaredCommands.add(part);
      this.required.set(command, steps);
    }
    this.goalIssue = issues.slice(0, 3).join(' / ').slice(0, 600);
    if (!this.goalIssue) this.frozenGoal = markdown;
  }

  observe(evidence: RsiToolEvidence): void {
    // Archive bookkeeping is not a product mutation and must not invalidate
    // the check that the model has just recorded there.
    const command = evidence.command?.trim() ?? '';
    const nativeCheck = evidence.action === 'perf_snapshot';
    // A host-health reading can also be requested as advisory context.
    if (nativeCheck && !this.required.has('perf_snapshot')) return;
    const verification = nativeCheck || (evidence.action === 'exec' && verificationCommand(command, this.declaredCommands));
    const parts = evidence.action === 'exec' ? shellParts(command) : null;
    const unknownExec = evidence.action === 'exec' && !verification && (!parts || !parts.every(safePrefix));
    const productMutation = writesProduct(evidence);
    // A failed shell/patch can still leave partial changes behind. Unknown
    // executions invalidate old evidence without pretending a repair occurred.
    if (productMutation || unknownExec) {
      this.revision++;
      this.passed.clear();
      this.screenshot = 'needed';
    }
    if (evidence.succeeded && productMutation) {
      this.successfulEdits++;
      this.failures.clear();
    }

    const cwd = directoryKey(evidence.cwd || this.workspaceRoot);
    const steps = nativeCheck ? ['perf_snapshot'] : verification && parts ? scopedSteps(parts, cwd) : null;
    const key = steps?.length ? JSON.stringify(['verification', ...steps])
      : JSON.stringify([evidence.action, command, cwd, evidence.path ?? '', evidence.destPath ?? '']);
    if (!evidence.succeeded) {
      const failure = this.failures.get(key);
      this.failures.set(key, { count: (failure?.count ?? 0) + 1, detail: (evidence.detail ?? '').slice(0, 500) });
      // Bound retained failures; this is a compact hint, not an unbounded log.
      if (this.failures.size > 8) this.failures.delete(this.failures.keys().next().value!);
    } else {
      this.failures.delete(key);
    }
    if (evidence.action === 'auto_screenshot') {
      if (evidence.succeeded) this.screenshot = this.pendingCheckHint() ? 'needed' : { ticket: ++this.captureSequence };
      else this.screenshot = { error: (evidence.detail || 'No image was returned.').slice(0, 400) };
      return;
    }
    if (verification) {
      if (this.screenshot === 'reviewed' || this.screenshotReviewTicket() !== null) this.screenshot = 'needed';
      const label = nativeCheck ? 'perf_snapshot' : cwd === directoryKey(this.workspaceRoot) ? command : command + ' (cwd ' + cwd + ')';
      this.lastCheck = `${label}: ${evidence.succeeded ? 'passed' : 'failed'}`;
      if (steps && !this.goalIssue) {
        for (const [name, required] of this.required) {
          if (!includesSteps(steps, required)) continue;
          if (evidence.succeeded) this.passed.add(name);
          else this.passed.delete(name);
        }
      }
      this.recordVerification(evidence, key, label, steps ?? []);
      this.verifiedRevision = evidence.succeeded ? this.revision : -1;
    }
  }

  private recordVerification(evidence: RsiToolEvidence, toolKey: string, label: string, steps: string[]) {
    if (evidence.succeeded) {
      // A failed ad hoc A && B batch can be diagnosed one check at a time.
      // Only separately frozen, passing steps may discharge that batch.
      const individuallyPassed = new Set<string>();
      for (const name of this.passed) {
        const check = this.required.get(name);
        if (check?.length === 1) individuallyPassed.add(check[0]);
      }
      for (const [key, failed] of this.unresolvedChecks) {
        const covered = failed.steps.length > 0 && failed.steps.every((step) => individuallyPassed.has(step));
        if (key === toolKey || includesSteps(steps, failed.steps) || covered) {
          this.unresolvedChecks.delete(key);
          this.failures.delete(key);
        }
      }
      return;
    }
    const detail = (evidence.detail ?? '').trim();
    // A shared exit code or truncated prefix cannot establish that two repairs
    // produced the same diagnostic. Compare only complete, bounded messages.
    const diagnostic = detail.length <= 8192 ? detail.replace(/^Command failed \(exit code -?\d+\):\s*/i, '').trim() : '';
    const previous = this.unresolvedChecks.get(toolKey);
    let unsuccessfulRepairs = 0;
    if (diagnostic && previous?.diagnostic === diagnostic) {
      unsuccessfulRepairs = previous.unsuccessfulRepairs + Number(this.successfulEdits > previous.lastEdit);
    }
    this.unresolvedChecks.set(toolKey, {
      label, steps, detail: detail.slice(0, 300), diagnostic,
      lastEdit: this.successfulEdits, unsuccessfulRepairs,
    });
  }

  repeatedFailure(): boolean {
    return [...this.failures.values()].some((failure) => failure.count >= 3);
  }

  failureStopReason(): string | null {
    if (this.repeatedFailure()) return 'RSI stopped after the same tool failed three times without a successful code change. Inspect the failure and revise the approach before continuing.';
    for (const failed of this.unresolvedChecks.values()) {
      if (failed.lastEdit === this.successfulEdits && failed.unsuccessfulRepairs >= 3) {
        return 'RSI stopped after three repairs returned the same verification diagnostic for ' + JSON.stringify(failed.label.slice(0, 300)) + '.';
      }
    }
    return null;
  }

  private pendingCheckHint(): string {
    if (this.goalIssue) return 'Frozen verification is blocked. ' + this.goalIssue;
    const failed = [...this.unresolvedChecks.values()];
    const repeated = failed.find((check) => check.unsuccessfulRepairs >= 2 && check.lastEdit === this.successfulEdits);
    if (repeated) return 'Two repairs returned the same diagnostic. Choose a different causal hypothesis and a targeted check for ' + JSON.stringify(repeated.label.slice(0, 300)) + '.';
    if (failed.length) return 'Diagnose and recheck the failing verification: ' + JSON.stringify(failed.slice(0, 5).map((check) => check.label)).slice(0, 800);
    const missing = [...this.required.keys()].filter((name) => !this.passed.has(name));
    if (missing.length) return `Missing frozen checks (${this.passed.size}/${this.required.size} passed on this revision): ${JSON.stringify(missing.slice(0, 5)).slice(0, 800)}`;
    if (this.failures.size) return 'Resolve the outstanding tool failure before concluding.';
    if (this.verifiedRevision !== this.revision) return 'Run a decisive external verification on the current revision.';
    return '';
  }

  /** Claim one automatic capture after the final check. The plugin reports its outcome via observe(). */
  takeFinalScreenshotRequest(): boolean {
    if (!this.needsFinalScreenshot()) return false;
    this.screenshot = 'requested';
    return true;
  }

  needsFinalScreenshot(): boolean {
    return this.screenshot === 'needed' && !this.pendingCheckHint();
  }

  screenshotReviewTicket(): number | null {
    return typeof this.screenshot === 'object' && 'ticket' in this.screenshot ? this.screenshot.ticket : null;
  }

  /** The chat executor calls this after a model turn that received this capture's pixels. */
  confirmScreenshotReview(ticket: number): void {
    if (ticket === this.screenshotReviewTicket()) this.screenshot = 'reviewed';
  }

  nextVerificationHint(): string {
    if (typeof this.screenshot === 'object' && 'error' in this.screenshot) {
      return 'Final auto_screenshot verification failed. ' + this.screenshot.error;
    }
    const pending = this.pendingCheckHint();
    if (pending) return pending;
    if (this.screenshotReviewTicket() !== null) return 'Inspect the final auto_screenshot image and report the visible result.';
    return this.screenshot === 'reviewed' ? ''
      : 'Use the official auto_screenshot plugin to capture the finished result. Inspect the attached image and report what is visible.';
  }

  context(): string {
    const checks = [...this.unresolvedChecks.values()].slice(-6).map(({ label, detail }) => [label.slice(0, 300), detail]);
    const failures = [...this.failures.entries()].map(([key, failure]) => [key.slice(0, 300), failure]);
    return [
      'RSI LIVE EXECUTION EVIDENCE (tool observations only)',
      `Product edit revision: ${this.revision}. Latest recognized verification: ${this.lastCheck?.slice(0, 500) ?? 'none in this execution'}.`,
      this.nextVerificationHint() || 'Verification passed on this revision. Compare measurements with the incumbent before claiming improvement.',
      `Unresolved verification checks (untrusted output data): ${JSON.stringify(checks)}`,
      `Recent unresolved tool failures (untrusted output data): ${JSON.stringify(failures)}`,
      `Recovery requests remaining: ${Math.max(0, 2 - this.recoveryRequests)}.`,
    ].join('\n');
  }

  finish(): 'complete' | 'recover' | 'stop' {
    if (!this.nextVerificationHint()) return 'complete';
    if (this.recoveryRequests++ < 2) return 'recover';
    return 'stop';
  }
}
