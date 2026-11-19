import { describe, expect, it } from 'vitest';
import type { Message } from '../../types';
import { conversationPage, remoteImageAttachments, remoteMessageImage } from './conversation';

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
  id, conversationId: 'conversation', role: 'user', content: 'hello', createdAt: 10, ...overrides,
});

describe('remote conversation payloads', () => {
  it('paginates the complete ordered transcript without duplicating the cursor', () => {
    const messages = Array.from({ length: 106 }, (_, index) => message(String(index)));
    const recent = conversationPage(messages)!;
    const older = conversationPage(messages, recent.messages[0].id)!;
    const first = conversationPage(messages, older.messages[0].id)!;
    expect(recent.hasOlderMessages).toBe(true);
    expect(older.hasOlderMessages).toBe(true);
    expect(first.hasOlderMessages).toBe(false);
    expect([...first.messages, ...older.messages, ...recent.messages].map((item) => item.id)).toEqual(messages.map((item) => item.id));
    expect(conversationPage(messages, 'removed-cursor')).toBeNull();
  });

  it('keeps the transcript useful while returning attachment data only through an explicit request', () => {
    const dataUrl = 'data:image/png;base64,AAAA';
    const messages = [message('image', { images: [dataUrl], reasoning_content: 'reasoning', tokensUsed: 42 })];
    const snapshot = conversationPage(messages)!;
    expect(snapshot.messages[0]).toMatchObject({ imageCount: 1, reasoningContent: 'reasoning', tokensUsed: 42 });
    expect(JSON.stringify(snapshot)).not.toContain(dataUrl);
    expect(remoteMessageImage(messages, 'image', 0)).toBe(dataUrl);
    expect(remoteMessageImage(messages, 'image', -1)).toBeNull();
    expect(remoteMessageImage(messages, 'another', 0)).toBeNull();
  });

  it('bounds attachments and accepts only approved image data URL formats', () => {
    const dataUrl = 'data:image/webp;base64,AAAA';
    expect(remoteImageAttachments(undefined)).toEqual([]);
    expect(remoteImageAttachments([dataUrl])).toEqual([dataUrl]);
    expect(remoteImageAttachments(new Array(5).fill(dataUrl))).toBeNull();
    expect(remoteImageAttachments(['data:image/svg+xml;base64,AAAA'])).toBeNull();
    expect(remoteImageAttachments(['https://example.test/image.png'])).toBeNull();
    expect(remoteImageAttachments(['data:image/jpeg;base64,' + 'A'.repeat(4_000_000)])).toBeNull();
  });
});
