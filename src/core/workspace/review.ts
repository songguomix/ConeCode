export const REVIEW_OUTPUT_LIMIT = 80_000;

export function reviewPrompt(scope: string, result: { target?: string | null; status?: string; diff?: string }): string {
  const status = (result.status || '').slice(0, REVIEW_OUTPUT_LIMIT);
  const diff = (result.diff || '').slice(0, REVIEW_OUTPUT_LIMIT);
  const truncated = (result.diff || '').length > REVIEW_OUTPUT_LIMIT || (result.status || '').length > REVIEW_OUTPUT_LIMIT;
  return `Review the following Git change set in read-only mode.

Scope: ${scope}${result.target ? ` (${result.target})` : ''}

Git status:
\`\`\`text
${status || '(clean status)'}
\`\`\`

Diff:
\`\`\`diff
${diff || '(No tracked diff. Inspect untracked paths from Git status with read-only tools.)'}
\`\`\`${truncated ? '\n\nThe output was truncated. Use read-only Git/file tools to inspect the remaining changes.' : ''}

Return prioritized, actionable findings with exact file and line references. Do not modify the working tree.`;
}
