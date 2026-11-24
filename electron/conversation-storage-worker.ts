import { parentPort, workerData } from 'node:worker_threads';
import { configureStorageDirectory } from '../src/core/storage/database';
import { conversationRepo, messageRepo } from '../src/core/storage/repositories/conversation.repo';

// The worker owns both repositories and runs every IPC operation in arrival
// order. Each repository operation is synchronous within this worker only.
const operations = {
  'conversation:list': conversationRepo.findAll.bind(conversationRepo),
  'conversation:create': conversationRepo.create.bind(conversationRepo),
  'conversation:update': conversationRepo.update.bind(conversationRepo),
  'conversation:setArchived': conversationRepo.setArchived.bind(conversationRepo),
  'conversation:delete': conversationRepo.delete.bind(conversationRepo),
  'message:list': messageRepo.findByConversation.bind(messageRepo),
  'message:subAgentHistory': messageRepo.subAgentHistory.bind(messageRepo),
  'message:recordSubAgent': messageRepo.recordSubAgent.bind(messageRepo),
  'message:counts': messageRepo.countsByConversation.bind(messageRepo),
  'message:create': messageRepo.create.bind(messageRepo),
  'message:delete': messageRepo.delete.bind(messageRepo),
  'message:editAndTruncate': messageRepo.editAndTruncate.bind(messageRepo),
};

export type ConversationStorageOperations = typeof operations;

const port = parentPort;
if (!port || typeof workerData !== 'string') throw new Error('Conversation storage requires a worker data directory');
configureStorageDirectory(workerData);

port.on('message', (message: { id: number; channel: string; args: unknown[] }) => {
  if (!message || !Number.isSafeInteger(message.id)) return;
  const { id, channel, args } = message;
  try {
    if (typeof channel !== 'string' || !Object.prototype.hasOwnProperty.call(operations, channel) || !Array.isArray(args)) {
      throw new Error('Unsupported conversation storage request');
    }
    const result = Reflect.apply(operations[channel as keyof typeof operations], undefined, args);
    port.postMessage({ id, ok: true, result });
  } catch (error) {
    port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
