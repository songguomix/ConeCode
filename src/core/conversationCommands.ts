import { AGENT_MODES, type AgentMode } from './agents/modePrompts';
import { BUILTIN_COMMANDS, expandTemplate, type SlashCommand } from './commands';
import { useChatStore, type SendMessageOptions } from '../stores/chat.store';
import { useGoalStore } from '../stores/goal.store';
import { useImageGenStore } from '../stores/imageGen.store';
import { useLanguageStore } from '../stores/language.store';
import { useMemoryStore } from '../stores/memory.store';
import { useModelStore } from '../stores/model.store';
import { useUIStore } from '../stores/ui.store';
import { useWorkspaceStore } from '../stores/workspace.store';

export function conversationCommandNeedsModel(command: SlashCommand): boolean {
  return command.kind === 'prompt' || ['clear', 'compact', 'goal'].includes(command.name);
}

export function conversationCommandMode(args: string): AgentMode | undefined {
  const mode = args.trim().toLowerCase() as AgentMode;
  return AGENT_MODES.includes(mode) ? mode : undefined;
}

/** Shared desktop and remote composer command execution. */
export async function runConversationCommand(command: SlashCommand, args: string, options?: SendMessageOptions) {
  const chat = useChatStore.getState();
  const workspace = useWorkspaceStore.getState();
  const ui = useUIStore.getState();
  const model = useModelStore.getState().getSelectedModel();
  const { t } = useLanguageStore.getState();
  const providerId = model?.providerId;
  const modelId = model?.id;
  const notice = (text: string) => chat.pushNotice(text, providerId, modelId);

  if (command.kind === 'prompt') {
    if (model) await chat.sendMessage(expandTemplate(command.template || '', args), model.providerId, model.id, options);
    return;
  }

  switch (command.name) {
    case 'help': {
      const lines = BUILTIN_COMMANDS.map((item) => '- `/' + item.name + '` — ' + t(item.description));
      const custom = workspace.customCommands.map((item) => '- `/' + item.name + '` — ' + item.description);
      const help = ['### ' + t('helpTitle'), ...lines];
      if (custom.length) help.push('', '**' + t('helpProjectCommands') + '**', ...custom);
      await notice(help.join('\n'));
      break;
    }
    case 'clear':
      if (model) await chat.newConversation(model.providerId, model.id);
      break;
    case 'compact':
      if (model) await chat.compactConversation(model.providerId, model.id);
      break;
    case 'plan':
      chat.togglePlanMode();
      break;
    case 'mode': {
      const mode = conversationCommandMode(args);
      if (mode) chat.setAgentMode(mode);
      break;
    }
    case 'goal': {
      const goal = args.trim();
      if (!model || !goal) break;
      const id = chat.activeConversationId || await chat.newConversation(model.providerId, model.id);
      useGoalStore.getState().setGoal(id, goal);
      await chat.sendMessage(goal, model.providerId, model.id, options);
      break;
    }
    case 'review':
      ui.toggleReview();
      break;
    case 'worktree':
      ui.toggleWorktrees();
      break;
    case 'model':
      ui.toggleModelSelector();
      break;
    case 'image':
    case 'imagine':
      useImageGenStore.getState().openModal(args.trim());
      break;
    case 'memory': {
      const target = args.trim().toLowerCase();
      if (target) {
        const match = workspace.memoryFiles.find((file) => file.path.toLowerCase().includes(target) || file.scope === target);
        if (match) await workspace.selectFile(match.path);
        else await notice(t('memoryNoSuchFile'));
        break;
      }
      const files = workspace.memoryFiles.map((file) => '- `' + file.path + '` — ' + t('memoryScope_' + file.scope));
      const learned = useMemoryStore.getState().relevant(workspace.rootPath).map((entry) => '- ' + entry.text);
      await notice([
        '### ' + t('memoryFilesTitle'), ...(files.length ? files : ['_' + t('memoryNoFiles') + '_']),
        '', '_' + t('memoryOpenHint') + '_', '', '### ' + t('memoryTitle'),
        ...(learned.length ? learned : ['_' + t('memoryNone') + '_']),
      ].join('\n'));
      break;
    }
    case 'agents':
      if (workspace.agentsMdPath) await workspace.selectFile(workspace.agentsMdPath);
      else await notice(t('noAgentsMd'));
      break;
    case 'add-dir': {
      const result = args.trim() ? await workspace.addRoot(args.trim()) : await workspace.addRootFromDialog();
      if (result.ok) await notice('📁 ' + t('addedFolder') + ': `' + result.path + '`');
      else if (result.reason && result.reason !== 'empty') {
        const detail = result.covered?.length ? ' (' + result.covered.join(', ') + ')' : '';
        await notice('⚠️ ' + t('addFolder_' + result.reason) + detail);
      }
      break;
    }
  }
}
