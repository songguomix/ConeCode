import type { ConstraintSessionStatus } from './gptSessionState';

export interface ConstraintViolation {
  ruleId: string;
  description: string;
  matchedText: string;
  index: number;
}

export class ConstraintViolationError extends Error {
  readonly violations: ConstraintViolation[];

  constructor(violations: ConstraintViolation[]) {
    const summary = violations
      .map((v) => `[${v.ruleId}] ${v.description} (matched: ${JSON.stringify(v.matchedText)})`)
      .join('; ');
    super(`GPT hard constraint violation detected: ${summary}`);
    this.name = 'ConstraintViolationError';
    this.violations = violations;
  }
}

const EMPTY_STRING_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const CODE_BLOCK_RE = /```[\w-]*\r?\n([\s\S]*?)```/g;

const CODE_VIOLATION_PATTERNS: ReadonlyArray<{
  ruleId: string;
  description: string;
  regex: RegExp;
}> = [
  {
    ruleId: 'NO_EMPTY_SHA256',
    description: 'Empty-string SHA-256 placeholder hash is forbidden',
    regex: new RegExp(EMPTY_STRING_SHA256, 'i'),
  },
  {
    ruleId: 'NO_ELLIPSIS_COMMENT',
    description: 'Code omission placeholder comment is forbidden',
    regex: /(?:\/\/|#|\/\*)\s*\.\.\.\s*(?:其余代码|其余部分|省略|rest of|remaining|more code|etc\.?)/i,
  },
  {
    ruleId: 'NO_STANDALONE_TODO',
    description: 'Unimplemented TODO/FIXME placeholder in generated code is forbidden',
    regex: /(?:\/\/|#)\s*(?:TODO|FIXME)\b/i,
  },
  {
    ruleId: 'NO_BARE_ELLIPSIS_LINE',
    description: 'Standalone `...` omission line inside code block is forbidden',
    regex: /^\s*\.\.\.\s*$/m,
  },
];

/**
 * Millisecond-level post-generation static gate.
 * Active strictly when the session constraint state is ENABLED.
 */
export class PostGenerationGuard {
  scan(content: string, sessionState: ConstraintSessionStatus): ConstraintViolation[] {
    if (sessionState !== 'ENABLED' || !content) {
      return [];
    }

    const violations: ConstraintViolation[] = [];

    // Always check full content for the forbidden empty SHA-256 constant
    const hashIdx = content.toLowerCase().indexOf(EMPTY_STRING_SHA256);
    if (hashIdx >= 0) {
      violations.push({
        ruleId: 'NO_EMPTY_SHA256',
        description: 'Empty-string SHA-256 placeholder hash is forbidden',
        matchedText: content.slice(hashIdx, hashIdx + EMPTY_STRING_SHA256.length),
        index: hashIdx,
      });
    }

    CODE_BLOCK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CODE_BLOCK_RE.exec(content)) !== null) {
      const codeBody = match[1];
      const blockStart = match.index;
      for (const pattern of CODE_VIOLATION_PATTERNS) {
        if (pattern.ruleId === 'NO_EMPTY_SHA256') continue;
        const hit = pattern.regex.exec(codeBody);
        if (hit) {
          violations.push({
            ruleId: pattern.ruleId,
            description: pattern.description,
            matchedText: hit[0],
            index: blockStart + hit.index,
          });
        }
      }
    }

    return violations;
  }

  enforce(content: string, sessionState: ConstraintSessionStatus): void {
    const violations = this.scan(content, sessionState);
    if (violations.length > 0) {
      throw new ConstraintViolationError(violations);
    }
  }

  async guardWithRetry(params: {
    sessionState: ConstraintSessionStatus;
    generate: (correctionHint?: string) => Promise<string>;
    maxRetries?: number;
  }): Promise<string> {
    const maxRetries = params.maxRetries ?? 1;
    let lastContent = await params.generate();
    let violations = this.scan(lastContent, params.sessionState);

    for (let attempt = 0; attempt < maxRetries && violations.length > 0; attempt++) {
      const hint = `Your previous output violated zero-tolerance constraints (${violations.map((v) => v.ruleId).join(', ')}). Regenerate 100% complete code with zero placeholders or fake hashes.`;
      lastContent = await params.generate(hint);
      violations = this.scan(lastContent, params.sessionState);
    }

    if (violations.length > 0) {
      throw new ConstraintViolationError(violations);
    }
    return lastContent;
  }
}

export const postGenerationGuard = new PostGenerationGuard();
