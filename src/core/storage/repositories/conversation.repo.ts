import { readJSON, writeJSON } from '../database';
import type { Conversation, Message } from '../../../types';
import { v4 as uuidv4 } from 'uuid';

const CONV_FILE = 'conversations.json';
const MSG_FILE = 'messages.json';

export const conversationRepo = {
  findAll(): Conversation[] {
    return readJSON<Conversation[]>(CONV_FILE, []).sort((a, b) => b.updatedAt - a.updatedAt);
  },

  findById(id: string): Conversation | null {
    return this.findAll().find((c) => c.id === id) || null;
  },

  create(data: Partial<Conversation>): Conversation {
    const conversations = readJSON<Conversation[]>(CONV_FILE, []);
    const now = Date.now();
    const conv: Conversation = {
      id: uuidv4(),
      title: data.title || 'New Chat',
      providerId: data.providerId || '',
      modelId: data.modelId || '',
      rootPath: data.rootPath ?? null,
      createdAt: now,
      updatedAt: now,
    };
    conversations.push(conv);
    writeJSON(CONV_FILE, conversations);
    return conv;
  },

  update(id: string, data: Partial<Conversation>): void {
    const conversations = readJSON<Conversation[]>(CONV_FILE, []);
    const idx = conversations.findIndex((c) => c.id === id);
    if (idx >= 0) {
      conversations[idx] = { ...conversations[idx], ...data, updatedAt: Date.now() };
      writeJSON(CONV_FILE, conversations);
    }
  },

  delete(id: string): boolean {
    const conversations = readJSON<Conversation[]>(CONV_FILE, []);
    const filtered = conversations.filter((c) => c.id !== id);
    if (filtered.length === conversations.length) return false;
    writeJSON(CONV_FILE, filtered);
    const messages = readJSON<Message[]>(MSG_FILE, []).filter((m) => m.conversationId !== id);
    writeJSON(MSG_FILE, messages);
    return true;
  },
};

export const messageRepo = {
  // Replace a user turn and its tail in one write, scoped to this conversation.
  editAndTruncate(conversationId: string, messageId: string, content: string): Message {
    const messages = readJSON<Message[]>(MSG_FILE, []);
    const index = messages.findIndex((m) => m.id === messageId && m.conversationId === conversationId);
    const original = messages[index];
    if (!original || original.role !== 'user' || original.isToolResult || original.isLocalNotice || !content.trim()) {
      throw new Error('Cannot edit this message');
    }
    const replacement: Message = {
      id: uuidv4(), conversationId, role: 'user', content, createdAt: Date.now(),
    };
    writeJSON(MSG_FILE, messages.flatMap((m, i) => {
      if (i === index) return [replacement];
      return i > index && m.conversationId === conversationId ? [] : [m];
    }));
    return replacement;
  },

  findByConversation(conversationId: string): Message[] {
    return readJSON<Message[]>(MSG_FILE, []).filter((m) => m.conversationId === conversationId);
  },

  create(data: Omit<Message, 'createdAt'>): Message {
    const messages = readJSON<Message[]>(MSG_FILE, []);
    const msg: Message = { ...data, createdAt: Date.now() };
    messages.push(msg);
    writeJSON(MSG_FILE, messages);
    return msg;
  },

  delete(messageId: string): boolean {
    const messages = readJSON<Message[]>(MSG_FILE, []);
    const filtered = messages.filter((m) => m.id !== messageId);
    if (filtered.length === messages.length) return false;
    writeJSON(MSG_FILE, filtered);
    return true;
  },
};
