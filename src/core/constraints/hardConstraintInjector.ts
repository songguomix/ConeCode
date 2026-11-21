import type { ChatMessage, ContentPart } from '../../types';
import type { ConstraintSessionStatus } from './gptSessionState';
import { GptDetector, gptDetector } from './gptDetector';

export const SYSTEM_OVERRIDE_OPEN_TAG = '<system_override trigger="GPT_MODEL_DETECTED" priority="CRITICAL">';
export const SYSTEM_OVERRIDE_CLOSE_TAG = '</system_override>';

export const GPT_HARD_CONSTRAINTS_BLOCK = [
  '# 零容忍代码工程硬约束（Zero-Tolerance Engineering Constraints）',
  '',
  '你正在执行高可靠性工程任务。以下每条约束均为不可妥协的红线，任何一条违背都将导致整次输出作废并触发强制重做：',
  '',
  '## 1. 100% 完整实现（严禁偷懒省略）',
  '- 严禁在任何代码、配置或脚本中输出 `// TODO`、`// FIXME`、`...`、`// ... 其余代码`、`/* 省略 */`、`pass` 占位或“此处逻辑同上”等任何形式的省略。',
  '- 所有边界条件、类型定义、错误分支、清理逻辑与接口实现必须 100% 完整落地，保证复制即编译、运行即闭环。',
  '',
  '## 2. Fail-Fast 异常治理（严禁静默吞异常）',
  '- 严禁使用空 `catch {}`、`catch (_) {}` 或宽泛 `try-catch` 吞掉异常并返回 `null`/`false`/空数组掩盖故障。',
  '- 遇到超时、I/O 失败、状态反序列化损坏、非法状态跃迁或校验不通过时，必须显式抛出带上下文的具体异常（或明确返回带错误原因的失败状态）。',
  '',
  '## 3. 禁止下载时 SHA-256 校验与假哈希占位',
  '- **禁止下载时 SHA-256 校验**：严禁在文件、安装包或资源下载流程中执行 SHA-256 摘要校验，不得因缺少或未匹配 SHA-256 而阻断下载（仅校验 HTTP 状态与写入完整性即可）。',
  '- 严禁在任何场景下硬编码假哈希值、模拟校验通过，或使用空字符串 SHA-256（`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`）作为占位。',
  '',
  '## 4. 脏产物清理与事务熔断',
  '- 文件写入、下载中断或分片合并失败时，必须先删除已落盘的脏文件或临时产物，再显式抛出错误熔断后续流程，严禁将半成品或损坏文件留在目标路径。',
  '',
  '## 5. 大文件流式分块（>= 1MB）',
  '- 处理体积达到或超过 `1MB`（`1,048,576` 字节）的文件读写或网络传输时，必须采用流式分块（Streaming / Chunked I/O），严禁一次性全量读入内存。',
  '',
  '## 6. 单一权威实现（禁止 V1/V2 冗余兼容层）',
  '- 重构或升级模块时，直接替换为单一权威实现；严禁为了“向后兼容”保留双份 V1/V2 旁路逻辑、废弃开关或死代码。',
  '',
  '## 输出前强制自检（Self-Audit Gate）',
  '在结束回复前，逐项核查你即将输出的所有代码块：',
  '1. 是否存在任何 `TODO` / `...` / 省略注释？ -> 若有，立即补全。',
  '2. 是否存在静默吞异常的 `catch`？ -> 若有，改为显式抛错。',
  '3. 是否存在未实际运行的测试/校验或假哈希？ -> 若有，立即修正。',
].join('\n');

export const WRAPPED_GPT_HARD_CONSTRAINTS = `${SYSTEM_OVERRIDE_OPEN_TAG}\n${GPT_HARD_CONSTRAINTS_BLOCK}\n${SYSTEM_OVERRIDE_CLOSE_TAG}`;

export interface InjectConstraintsParams {
  messages: ChatMessage[];
  sessionState: ConstraintSessionStatus;
  modelName: string;
  /**
   * Whether the target endpoint accepts `system` / `developer` roles.
   * When false for reasoning models (`o1`/`o3`/`o4`), degrades by merging into the first message.
   */
  supportsSystem?: boolean;
  detector?: GptDetector;
}

function appendToContent(existing: string | ContentPart[], block: string): string | ContentPart[] {
  if (typeof existing === 'string') {
    const trimmed = existing.trim();
    return trimmed ? `${trimmed}\n\n${block}` : block;
  }
  return [...existing, { type: 'text', text: block }];
}

function prependToContent(existing: string | ContentPart[], block: string): string | ContentPart[] {
  if (typeof existing === 'string') {
    const trimmed = existing.trim();
    return trimmed ? `${block}\n\n${trimmed}` : block;
  }
  return [{ type: 'text', text: block }, ...existing];
}

function contentContainsOverride(content: string | ContentPart[]): boolean {
  if (typeof content === 'string') {
    return content.includes(WRAPPED_GPT_HARD_CONSTRAINTS);
  }
  return content.some((part) => part.type === 'text' && part.text.includes(WRAPPED_GPT_HARD_CONSTRAINTS));
}

function contentStartsWithOverride(content: string | ContentPart[]): boolean {
  if (typeof content === 'string') {
    return content === WRAPPED_GPT_HARD_CONSTRAINTS || content.startsWith(`${WRAPPED_GPT_HARD_CONSTRAINTS}\n\n`);
  }
  const first = content[0];
  return first?.type === 'text' && first.text === WRAPPED_GPT_HARD_CONSTRAINTS;
}

/**
 * Dynamically injects GPT_HARD_CONSTRAINTS_BLOCK into system/developer messages
 * strictly when the session state is ENABLED, with idempotency and o1/o3/o4
 * reasoning-model role adaptation.
 */
export class HardConstraintInjector {
  hasInjectedConstraints(messages: ChatMessage[]): boolean {
    return messages.some(({ role, content }) =>
      (role === 'system' || role === 'developer') && contentContainsOverride(content));
  }

  inject(params: InjectConstraintsParams): ChatMessage[] {
    if (params.sessionState !== 'ENABLED') {
      return params.messages;
    }

    const detector = params.detector ?? gptDetector;
    const isReasoning = detector.isReasoningSeriesModel(params.modelName);
    const useFirstMessage = isReasoning && params.supportsSystem === false;
    const first = params.messages[0];
    if (this.hasInjectedConstraints(params.messages) || (useFirstMessage && first && contentStartsWithOverride(first.content))) {
      return params.messages;
    }

    const cloned = params.messages.map((m) => ({ ...m }));

    if (isReasoning) {
      if (useFirstMessage) {
        if (cloned.length === 0) {
          return [{ role: 'user', content: WRAPPED_GPT_HARD_CONSTRAINTS }];
        }
        cloned[0] = {
          ...cloned[0],
          content: prependToContent(cloned[0].content, WRAPPED_GPT_HARD_CONSTRAINTS),
        };
        return cloned;
      }

      const devIndex = cloned.findIndex((m) => m.role === 'developer');
      if (devIndex >= 0) {
        cloned[devIndex] = {
          ...cloned[devIndex],
          content: appendToContent(cloned[devIndex].content, WRAPPED_GPT_HARD_CONSTRAINTS),
        };
        return cloned;
      }

      return [
        { role: 'developer', content: WRAPPED_GPT_HARD_CONSTRAINTS },
        ...cloned,
      ];
    }

    const systemIndex = cloned.findIndex((m) => m.role === 'system');
    if (systemIndex >= 0) {
      cloned[systemIndex] = {
        ...cloned[systemIndex],
        content: appendToContent(cloned[systemIndex].content, WRAPPED_GPT_HARD_CONSTRAINTS),
      };
      return cloned;
    }

    return [
      { role: 'system', content: WRAPPED_GPT_HARD_CONSTRAINTS },
      ...cloned,
    ];
  }
}

export const hardConstraintInjector = new HardConstraintInjector();
