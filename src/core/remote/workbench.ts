import { useAgendaStore } from '../../stores/agenda.store';
import { useAutopilotStore } from '../../stores/autopilot.store';
import { useChatStore } from '../../stores/chat.store';
import { useDshMarketStore } from '../../stores/dshMarket.store';
import { isHolding, useInstallGateStore } from '../../stores/installGate.store';
import { useLanguageStore } from '../../stores/language.store';
import { useModelStore } from '../../stores/model.store';
import { useProjectBriefStore } from '../../stores/projectBrief.store';
import { useUIStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { buildLocalTasks } from '../agenda/agenda';
import { sanitizeProviderError } from '../image/imageGen';
import { activateWorkspaceView } from '../workspace/activateView';

type Command = Record<string, unknown>;

const fail = (error: string) => ({ ok: false, error });
const ok = { ok: true };
let refreshing = false;

function workState() {
  const rootPath = useWorkspaceStore.getState().rootPath;
  const agenda = useAgendaStore.getState();
  const ideas = useAutopilotStore.getState();
  const brief = useProjectBriefStore.getState();
  const { t } = useLanguageStore.getState();
  const scan = rootPath && agenda.scan?.rootPath === rootPath ? agenda.scan : null;
  const tasks = rootPath && agenda.tasksRoot === rootPath ? agenda.tasks : scan ? buildLocalTasks(scan, t) : [];
  return {
    ...ok, rootPath,
    scan: scan ? {
      projectName: scan.projectName, fileCount: scan.fileCount, fileCountCapped: scan.fileCountCapped,
      hasTests: scan.hasTests, git: scan.git, scripts: scan.scripts, languages: scan.languages, todoComments: scan.todoComments,
    } : null,
    tasks,
    scanning: refreshing || agenda.scanning || agenda.suggesting,
    scanError: agenda.error ? sanitizeProviderError(agenda.error) : null,
    ideas: ideas.ideas,
    loadingIdeas: ideas.loadingIdeas,
    autopilot: {
      phase: ideas.phase, title: ideas.running?.title, projectDir: ideas.projectDir,
      attempt: ideas.attempt, verifyCommand: ideas.verifyCommand,
      lastOutput: ideas.lastOutput, error: ideas.error,
    },
    brief: {
      title: brief.brief?.title, idea: brief.idea, prompt: brief.prompt, generating: brief.generating,
      starting: brief.starting, directory: brief.directory, error: brief.error ? t(brief.error) : null,
    },
  };
}

export function remoteWork(cmd: Command) {
  const rootPath = useWorkspaceStore.getState().rootPath;
  const agenda = useAgendaStore.getState();
  const ideas = useAutopilotStore.getState();
  const brief = useProjectBriefStore.getState();
  const chat = useChatStore.getState();
  const model = useModelStore.getState().getSelectedModel();
  const { locale } = useLanguageStore.getState();

  switch (cmd.action) {
    case 'state':
      if (rootPath && agenda.tasksRoot !== rootPath) agenda.loadCached(locale);
      return workState();
    case 'scan':
    case 'suggest': {
      if (!rootPath || rootPath !== cmd.rootPath) return fail('Workspace changed');
      if (refreshing || agenda.scanning || agenda.suggesting) return fail('Workspace scan is in progress');
      if (cmd.action === 'suggest' && !model) return fail('Select a model');
      refreshing = true;
      const operation = cmd.action === 'suggest' && model
        ? agenda.findWork(model.providerId, model.id, true, locale)
        : agenda.scanWorkspace();
      void operation.finally(() => { refreshing = false; });
      return workState();
    }
    case 'startTask': {
      if (!rootPath || rootPath !== cmd.rootPath || chat.activeConversationId !== (cmd.conversationId || null)) {
        return fail('Workspace or conversation changed');
      }
      if (!model || chat.isStreaming || isHolding(useInstallGateStore.getState().jobs) ||
          (chat.activeConversationId && chat.messageEdits[chat.activeConversationId])) {
        return fail('Select a model and wait for the current operation');
      }
      const task = workState().tasks.find(({ id }) => id === cmd.id);
      if (!task) return fail('Task is no longer available');
      const prompt = typeof cmd.prompt === 'string' ? cmd.prompt.trim() : task.prompt;
      if (!prompt || prompt.length > 32_000) return fail('Invalid task prompt');
      void chat.sendMessage(prompt, model.providerId, model.id, { keepComposerImages: true });
      return ok;
    }
    case 'ideas':
      void ideas.loadIdeas(model?.providerId, model?.id, true, locale);
      return workState();
    case 'startIdea': {
      if (!model || Object.keys(chat.streamingRuns).length || isHolding(useInstallGateStore.getState().jobs)) {
        return fail('Select a model and wait for other work to finish');
      }
      const idea = ideas.ideas.find(({ id }) => id === cmd.id);
      if (!idea || !['idle', 'done', 'failed'].includes(ideas.phase)) return fail('Project idea is unavailable');
      void ideas.run(idea, model.providerId, model.id);
      return workState();
    }
    case 'dismissProject':
      if (ideas.phase === 'done' || ideas.phase === 'failed') ideas.reset();
      return workState();
    case 'generateBrief':
      if (!model || brief.generating || brief.starting) return fail('Select a model and wait for the current brief');
      if (typeof cmd.idea !== 'string' || !cmd.idea.trim() || cmd.idea.length > 12_000) return fail('Invalid project idea');
      brief.setIdea(cmd.idea.trim());
      void brief.generate(model.providerId, model.id, locale);
      return workState();
    case 'cancelBrief':
      brief.cancel();
      return workState();
    case 'startBrief':
      if (!model || !brief.brief || brief.generating || brief.starting) return fail('Project brief is unavailable');
      if ((rootPath || '') !== cmd.rootPath || chat.activeConversationId !== (cmd.conversationId || null) ||
          brief.brief.title !== cmd.title || brief.idea !== cmd.idea) return fail('The project brief or workspace changed');
      if (typeof cmd.prompt !== 'string' || !cmd.prompt.trim() || cmd.prompt.length > 160_000) return fail('Invalid project brief');
      brief.setPrompt(cmd.prompt);
      void brief.start(model.providerId, model.id);
      return workState();
    default:
      return fail('Unknown workbench action');
  }
}

export function remoteDesktopPanel(panel: unknown) {
  const ui = useUIStore.getState();
  switch (panel) {
    case 'app':
      break;
    case 'preview':
      void activateWorkspaceView('work').then(() => useUIStore.getState().openPreview()).catch(console.error);
      break;
    case 'terminal':
      void activateWorkspaceView('work').then(() => {
        const workbench = useUIStore.getState();
        if (!workbench.terminalOpen) workbench.toggleTerminal();
      }).catch(console.error);
      break;
    case 'agents':
      if (!ui.subAgentsOpen) ui.toggleSubAgents();
      break;
    case 'background':
      if (!ui.backgroundOpen) ui.toggleBackground();
      break;
    case 'computer':
      if (!ui.computerOpen) ui.toggleComputer();
      break;
    case 'settings':
      if (!ui.settingsOpen) ui.toggleSettings();
      break;
    case 'market':
      void useDshMarketStore.getState().openPanel().catch(console.error);
      break;
    default:
      return fail('Unknown desktop panel');
  }
  return ok;
}
