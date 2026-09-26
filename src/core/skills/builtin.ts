// The built-in skill library — what the "插件库" offers out of the box.
//
// These ship with the app so the library is useful before anyone writes a skill.
// Installing one copies it to disk as a normal SKILL.md, which the user can then
// edit freely; nothing here is privileged over a hand-written skill.

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  body: string;
}

export const BUILTIN_SKILLS: CatalogSkill[] = [
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Review a diff or file for real defects. Use when asked to review, audit, or check code before merging.',
    tags: ['quality'],
    body: `# Code Review

Review for defects that would actually bite, in this order. Stop at the first category that yields findings — a review that lists twenty style nits and misses the null deref is a failed review.

## 1. Correctness
- Trace the actual data flow of the change; do not review it as prose.
- Off-by-one, null/undefined, empty collection, and the boundary of every loop.
- Error paths: what happens when the call fails, the file is missing, the network times out?
- Concurrency: shared mutable state, await points where state can change underneath.

## 2. Contract
- Does the change keep the promises its callers rely on (types, return shapes, thrown errors)?
- Are all call sites updated? Search for them; do not assume.

## 3. Security
- Untrusted input reaching a shell, a query, a path, or HTML.
- Secrets in code, logs, or error messages.

## 4. Fit
- Does it match the conventions of the surrounding code?
- Is there an existing helper it should have used?

## Reporting
For each finding: the file and line, what breaks, and the concrete input that triggers it. Rank by severity. If you find nothing serious, say so plainly instead of inventing filler.`,
  },
  {
    id: 'debugging',
    name: 'Systematic Debugging',
    description: 'Find the root cause of a bug or failing test. Use when something is broken, failing, or behaving unexpectedly.',
    tags: ['quality'],
    body: `# Systematic Debugging

Never patch a symptom you cannot explain.

## Method
1. **Reproduce.** Get a command that fails reliably. If you cannot reproduce it, say so rather than guessing.
2. **Read the actual error.** The full message and stack, not the summary. Find the first frame in project code.
3. **Form ONE hypothesis** that explains ALL the evidence, including anything that looks contradictory.
4. **Test the hypothesis cheaply** — a log line, a narrow test, reading the function. Confirm before changing.
5. **Fix the cause.** If the fix does not follow obviously from the cause, you have not found it yet.
6. **Prove it.** Re-run the failing case AND the surrounding tests.

## When stuck
- Bisect: what is the smallest input that still fails?
- Check assumptions: is the code running at all? Is it the version you are reading?
- Look at what changed most recently near the failure.

Never: sprinkle try/catch to make an error disappear, loosen a type to silence a checker, or mark a failing test skipped.`,
  },
  {
    id: 'test-writing',
    name: 'Writing Tests',
    description: 'Write meaningful tests. Use when adding tests, improving coverage, or asked to prove code works.',
    tags: ['quality'],
    body: `# Writing Tests

A test earns its place by failing when the behaviour breaks.

## Rules
- Test **behaviour**, not implementation. Renaming a private helper must not break a test.
- One clear reason to fail per test. The name states the expectation ("refuses a write outside the workspace").
- Cover the boundary and the failure path, not just the happy case: empty, missing, malformed, duplicate, too large.
- Use real inputs. A test asserting on data you invented to match the code proves nothing.
- No \`assert(true)\`, no snapshot of everything, no mocking the thing under test.

## Before writing
Read the existing tests and match their structure, helpers and naming. Use the project's real runner.

## After writing
Run them. Then deliberately break the code and confirm the test actually fails — a test that passes against broken code is worse than none.`,
  },
  {
    id: 'refactoring',
    name: 'Safe Refactoring',
    description: 'Restructure code without changing behaviour. Use when cleaning up, extracting, or reorganising existing code.',
    tags: ['quality'],
    body: `# Safe Refactoring

Behaviour must be identical before and after. If behaviour changes, it is not a refactor.

## Protocol
1. **Establish the safety net first.** Are there tests covering this code? If not, write them BEFORE touching anything.
2. **One transformation at a time**: extract, rename, move, inline. Never combine a refactor with a behaviour change in the same step.
3. **Run the tests after each step**, not at the end.
4. **Update every call site** — search the whole repo, including strings and dynamic references.

## Judgement
- Refactor because it makes the next change easier, not for tidiness.
- Leave code you do not understand alone until you understand it.
- Preserve public APIs unless removing them is the explicit task.`,
  },
  {
    id: 'security-review',
    name: 'Security Review',
    description: 'Look for vulnerabilities in code. Use when reviewing auth, input handling, secrets, or asked about security.',
    tags: ['security'],
    body: `# Security Review

Follow untrusted input to where it does damage.

## Where to look
- **Injection**: input reaching a shell, SQL, a path, HTML, or an eval. Is it parameterised or escaped at the sink?
- **Path traversal**: user-controlled paths joined without normalising and confining to a root.
- **AuthZ**: is every sensitive operation checking who the caller is, server-side? Client checks are not checks.
- **Secrets**: keys in source, in logs, in error responses, in the repo history.
- **Deserialisation** of untrusted data into live objects.
- **Dependencies**: obviously unmaintained or typosquatted packages.

## Reporting
State the vulnerable path concretely: this input, reaching this sink, does this. No CVSS theatre, no generic advice. If the code is fine, say it is fine.`,
  },
  {
    id: 'api-design',
    name: 'API Design',
    description: 'Design or review an HTTP/RPC API. Use when adding endpoints, designing an interface, or reviewing API shape.',
    tags: ['design'],
    body: `# API Design

## Shape
- Resources as nouns; verbs are the methods. Consistent plurals.
- Every response has a predictable envelope; errors share one shape with a machine-readable code.
- Correct status codes: 400 (bad request), 401 vs 403, 404, 409 (conflict), 422 (semantic), 429, 5xx only for your own failures.

## Contract
- Validate every input at the boundary; never trust the client.
- Idempotent operations for anything retryable — PUT/DELETE, and POST with an idempotency key.
- Pagination on every collection, from day one. Cursor over offset for anything that changes.
- Version before you need to break it.

## Review checklist
- What happens on partial failure?
- Can a client tell a retryable failure from a fatal one?
- Does any response leak internal detail (stack traces, SQL, internal ids)?`,
  },
  {
    id: 'commit-and-pr',
    name: 'Commits and PRs',
    description: 'Write commit messages and PR descriptions. Use when committing, or preparing a change for review.',
    tags: ['workflow'],
    body: `# Commits and PRs

## Commit messages
- Conventional Commits: \`type(scope): summary\` — feat, fix, refactor, test, docs, chore, perf.
- The summary says what changed and why it matters, in the imperative, under 72 characters.
- Body (when non-obvious): the problem, the approach, and anything a reviewer would otherwise have to ask.
- One logical change per commit. Never mix a refactor with a fix.

## PR descriptions
- What this changes and why, in two sentences.
- How it was verified — the actual commands run and their result.
- Anything risky, and what you deliberately left out of scope.

Never commit or push unless explicitly asked to.`,
  },
  {
    id: 'performance',
    name: 'Performance Work',
    description: 'Make code faster. Use when something is slow, or asked to optimise or profile.',
    tags: ['quality'],
    body: `# Performance Work

## Rules
1. **Measure first.** Never optimise on suspicion. Get a number: a timing, a profile, a benchmark.
2. **Find the actual hot path.** It is almost never where it feels like it is.
3. **Fix the biggest cost first** — usually an algorithm or an N+1, not a micro-optimisation.
4. **Measure again** and state the before/after numbers. If it did not measurably improve, revert it.

## Usual suspects
- Repeated work in a loop that could be hoisted or memoised.
- N+1 queries or requests where one batched call would do.
- Accidental O(n²) from a nested scan over a list.
- Reading or serialising far more data than is needed.
- Blocking I/O on a hot path that could be concurrent.

Never trade clarity for speed without a measurement proving the trade was worth it.`,
  },

  // ---- Marketplace shelf (MiMo-style) ---------------------------------
  {
    id: 'ui-polish',
    name: '界面打磨',
    description: 'Polish UI motion, spacing, and accessibility. Use when asked to make the interface feel refined.',
    tags: ['ui', 'design', 'a11y'],
    body: `# 界面打磨\n\n1. Prefer transform/opacity animations; honor prefers-reduced-motion.\n2. Keep contrast AA+ for body text.\n3. Reuse existing design tokens — do not invent new hex colors casually.`,
  },
  {
    id: 'test-hardening',
    name: '测试加固',
    description: 'Add or repair tests without greenwashing. Use when fixing bugs or raising coverage.',
    tags: ['test', 'quality'],
    body: `# 测试加固\n\n1. Write a failing test that proves the bug first.\n2. Never weaken assertions to make CI green.\n3. Prefer behavior tests over mock-only checks.`,
  },
  {
    id: 'perf-triage',
    name: '性能分诊',
    description: 'Diagnose UI stutter and re-render storms. Use when the app feels slow.',
    tags: ['perf', 'react'],
    body: `# 性能分诊\n\n1. Profile the hot path before editing.\n2. Fix subscription identity and memo boundaries first.\n3. Measure before/after with a concrete scenario.`,
  },
  {
    id: 'secure-edit',
    name: '安全改动',
    description: 'Harden auth, secrets, and boundary checks. Use when touching security-sensitive code.',
    tags: ['security'],
    body: `# 安全改动\n\n1. Never log secrets. Validate all external input.\n2. Prefer least privilege. No disabled TLS or checks.\n3. Call out residual risk in the summary.`,
  },
  {
    id: 'i18n-ready',
    name: '多语言就绪',
    description: 'Ship en/zh/ja strings together. Use when adding any user-visible copy.',
    tags: ['i18n'],
    body: `# 多语言就绪\n\n1. Add keys for en, zh, ja together.\n2. Never hardcode UI copy in components.\n3. Keep labels short; hints can be longer.`,
  },
  {
    id: 'release-check',
    name: '发布检查',
    description: 'Pre-flight typecheck, tests, build, and smoke. Use when finishing or shipping work.',
    tags: ['release'],
    body: `# 发布检查\n\n1. Run typecheck, tests, and build.\n2. Smoke the golden path once.\n3. List what you did NOT verify.`,
  },
  {
    id: 'public-api-design',
    name: '公开 API 设计',
    description: 'Design clear, evolvable interfaces. Use when shaping public functions or IPC.',
    tags: ['api', 'architecture'],
    body: `# API 设计\n\n1. Name by caller intent, not implementation.\n2. Make illegal states unrepresentable where cheap.\n3. Version or document breaking changes explicitly.`,
  },
  {
    id: 'docs-sync',
    name: '文档同步',
    description: 'Keep README and real behavior aligned. Use when docs drift from code.',
    tags: ['docs'],
    body: `# 文档同步\n\n1. Read the public API and the README claims.\n2. Fix the lie in docs or code — not both with hand-waving.\n3. Keep examples runnable.`,
  },
];

export function findBuiltin(id: string): CatalogSkill | undefined {
  return BUILTIN_SKILLS.find((s) => s.id === id);
}
