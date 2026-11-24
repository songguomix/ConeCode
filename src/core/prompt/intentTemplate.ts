/**
 * Shared intent-alignment template embedded into all system main prompts.
 * Requests one intent statement before work on each new user request.
 */
export const INTENT_ALIGNMENT_RULE = `# Intent First
State intent once per new user request, before work or tools.
> **意图理解**
> - **核心目标**：<目标>
> - **关键约束**：<约束/默认规范>
> - **执行路径**：<步骤>`;
