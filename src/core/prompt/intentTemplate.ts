/**
 * Shared intent-alignment template embedded into all system main prompts.
 * Ensures the agent explicitly states its understood user intent before
 * calling tools or starting implementation.
 */
export const INTENT_ALIGNMENT_RULE = `# Intent First
Before any tool or work, output your understood intent using this template:
> **意图理解**
> - **核心目标**：<目标>
> - **关键约束**：<约束/默认规范>
> - **执行路径**：<步骤>`;
