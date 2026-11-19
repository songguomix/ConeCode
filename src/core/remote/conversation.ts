import type { Message } from '../../types';

const PAGE_SIZE = 50;
const MAX_PAGE_TEXT = 512_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_DATA = 4_000_000;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/]+={0,2}$/i;

export function remoteImageAttachments(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) return null;
  let size = 0;
  for (const image of value) {
    if (typeof image !== 'string' || (size += image.length) > MAX_IMAGE_DATA || !IMAGE_DATA_URL.test(image)) return null;
  }
  return value;
}

export function remoteMessage(message: Message) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    isToolResult: message.isToolResult,
    isLocalNotice: message.isLocalNotice,
    reasoningContent: message.reasoning_content || message.thinkingBlocks?.map((block) => block.thinking).filter(Boolean).join('\n\n'),
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isSummary: message.isSummary,
    isQuestion: message.isQuestion,
    questionOptions: message.questionOptions,
    summaryUpToId: message.summaryUpToId,
    toolCalls: message.toolCalls?.map(({ id, name }) => ({ id, name })),
    thinkingTime: message.thinkingTime,
    tokensUsed: message.tokensUsed,
    promptTokens: message.promptTokens,
    completionTokens: message.completionTokens,
    cacheHitTokens: message.cacheHitTokens,
    modelId: message.modelId,
    providerId: message.providerId,
    createdAt: message.createdAt,
    imageCount: Math.min(message.images?.length ?? 0, MAX_IMAGES),
  };
}

export function conversationPage(messages: Message[], beforeId?: string) {
  const end = beforeId === undefined ? messages.length : messages.findIndex((message) => message.id === beforeId);
  if (end < 0) return null;
  let start = end;
  let chars = 0;
  while (start > 0 && end - start < PAGE_SIZE) {
    const message = messages[start - 1];
    chars += message.content.length + (message.reasoning_content?.length ?? 0);
    if (start < end && chars > MAX_PAGE_TEXT) break;
    start--;
  }
  return { messages: messages.slice(start, end).map(remoteMessage), hasOlderMessages: start > 0 };
}

export function remoteMessageImage(messages: Message[], messageId: string, index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_IMAGES) return null;
  const image = messages.find((message) => message.id === messageId)?.images?.[index];
  return image && remoteImageAttachments([image]) ? image : null;
}
