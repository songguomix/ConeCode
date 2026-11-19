// The remote panel reads and changes the same stores as desktop Settings.
// List replies carry metadata only. Larger bodies are sent on explicit detail
// requests and credentials are write-only.
import { BUILTIN_PROMPTS_META } from '../prompt/defaultPrompts';
import { useChatStore } from '../../stores/chat.store';
import { useLanguageStore } from '../../stores/language.store';
import { useMemoryStore } from '../../stores/memory.store';
import { useMemoryV2Store } from '../../stores/memoryV2.store';
import { useModelStore } from '../../stores/model.store';
import { selectPlugins, usePluginStore } from '../../stores/plugin.store';
import { usePromptStore } from '../../stores/prompt.store';
import { useProviderStore } from '../../stores/provider.store';
import { useSettingsStore } from '../../stores/settings.store';
import { useSkillsStore } from '../../stores/skills.store';
import { readSubAgentHistory } from '../../stores/subAgents.store';
import { useThemeStore } from '../../stores/theme.store';
import { useUpdateStore } from '../../stores/update.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { ProviderConfig, ProviderType } from '../../types/provider.types';
import { parseLimitInput } from '../model/limitInput';
import type { MarketSnapshot } from '../dsh-market/types';
import type { Skill } from '../skills/skills';

const PAGE_SIZE = 25;
const TEXT_LIMIT = 160_000;

type Entry = {
  id: string;
  title: string;
  description?: string;
  content?: string;
  type?: string;
  enabled?: boolean;
  values?: Record<string, string>;
};

type Page = { items: Entry[]; more?: boolean };
type SettingsReply = { ok: boolean; page?: Page; item?: Entry; error?: string };
type WireObject = Record<string, unknown>;

function record(value: unknown): WireObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as WireObject;
}

function string(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function requireText(value: unknown, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid or empty input.');
  return value;
}

function requireBool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid switch value.');
  return value;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value === 'string' && (choices as readonly string[]).includes(value)) return value as T;
  throw new Error('Invalid option.');
}

function number(value: unknown, min: number, max: number): number {
  const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error('Invalid number.');
  return parsed;
}

function pageOf(items: Entry[], page: number, query: string): Page {
  const term = query.toLowerCase();
  const matches = term
    ? items.filter((entry) => [entry.title, entry.description, entry.id].some((value) => value?.toLowerCase().includes(term)))
    : items;
  const offset = (page - 1) * PAGE_SIZE;
  return { items: matches.slice(offset, offset + PAGE_SIZE), more: matches.length > offset + PAGE_SIZE };
}

const generalSwitches = [
  'sendWithEnter', 'streamEnabled', 'autoIncludeFileContext', 'fullContext',
  'notifyApprovals', 'preventSleepWhileRunning', 'costLock', 'sandboxAllowNetwork',
] as const;

const generalChoices = {
  theme: ['system', 'light', 'dark'],
  language: ['en', 'zh', 'zhHant', 'ja'],
  toolCallMode: ['auto', 'native', 'prompt'],
  notificationMode: ['never', 'background', 'always'],
  approvalMode: ['suggest', 'autoEdit', 'fullAuto'],
  sandboxMode: ['workspaceWrite', 'off'],
} as const;

function generalSettings(): Entry[] {
  const settings = useSettingsStore.getState();
  const switchEntries = generalSwitches.map((id) => ({ id, title: id, type: 'switch', enabled: settings[id] }));
  const selectedValues = {
    ...settings,
    theme: useThemeStore.getState().theme,
    language: useLanguageStore.getState().locale,
  };
  const choices = Object.entries(generalChoices).map(([id, options]) => ({
    id, title: id, type: 'choice',
    values: { value: selectedValues[id as keyof typeof generalChoices], options: options.join(',') },
  }));
  const numbers = [
    { id: 'maxEpisodeCost', title: 'maxEpisodeCost', type: 'number', values: { value: String(settings.maxEpisodeCost) } },
    { id: 'maxContextFileSize', title: 'maxContextFileSize', type: 'number', values: { value: String(settings.maxContextFileSize) } },
  ];
  return [...choices, ...switchEntries, ...numbers];
}

async function updateGeneral(id: string, value: unknown): Promise<void> {
  const settings = useSettingsStore.getState();
  for (const key of generalSwitches) {
    if (key === id) {
      settings.updateSettings({ [key]: requireBool(value) });
      return;
    }
  }
  switch (id) {
    case 'theme': useThemeStore.getState().setTheme(oneOf(value, generalChoices.theme)); return;
    case 'language': useLanguageStore.getState().setLocale(oneOf(value, generalChoices.language)); return;
    case 'toolCallMode': settings.updateSettings({ toolCallMode: oneOf(value, generalChoices.toolCallMode) }); return;
    case 'notificationMode': settings.updateSettings({ notificationMode: oneOf(value, generalChoices.notificationMode) }); return;
    case 'approvalMode': settings.updateSettings({ approvalMode: oneOf(value, generalChoices.approvalMode) }); return;
    case 'sandboxMode': settings.updateSettings({ sandboxMode: oneOf(value, generalChoices.sandboxMode) }); return;
    case 'maxEpisodeCost': settings.updateSettings({ maxEpisodeCost: number(value, 0.01, 1_000) }); return;
    case 'maxContextFileSize': settings.updateSettings({ maxContextFileSize: Math.round(number(value, 1, 10_000_000)) }); return;
    default: throw new Error('Unknown setting.');
  }
}

const providerTypes = ['openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'custom'] as const satisfies readonly ProviderType[];

function providerEntry(provider: ProviderConfig): Entry {
  let host = '';
  try { host = new URL(provider.baseUrl).hostname; } catch {}
  return {
    id: provider.id, title: provider.name, description: host, type: provider.type, enabled: provider.enabled,
    values: { defaultModel: provider.defaultModel, timeout: String(provider.timeout) },
  };
}

function getProvider(id: string): ProviderConfig {
  const provider = useProviderStore.getState().providers.find((item) => item.id === id);
  if (!provider) throw new Error('Provider not found.');
  return provider;
}

async function saveProvider(id: string, values: WireObject): Promise<void> {
  const store = useProviderStore.getState();
  const current = id ? getProvider(id) : null;
  if (current?.type === 'conecode-free') throw new Error('The built-in provider manages its own configuration.');
  const name = requireText(values.name, 120).trim();
  const type = oneOf(values.type, providerTypes);
  const baseUrl = string(values.baseUrl, 4_096).trim() || current?.baseUrl;
  if (!baseUrl) throw new Error('Enter an API endpoint.');
  const endpoint = new URL(baseUrl);
  if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('The API endpoint must use HTTP or HTTPS.');
  const timeout = Math.round(number(values.timeout, 1, 3_600_000));
  const config = { name, type, baseUrl, timeout, defaultModel: string(values.defaultModel, 500).trim() };
  const apiKey = string(values.apiKey, 16_384).trim();
  if (current?.apiKey && !apiKey && (current.baseUrl !== baseUrl || current.type !== type)) {
    throw new Error('Enter an API key for the new endpoint or provider type.');
  }
  useProviderStore.setState({ error: null });
  if (current) {
    await store.updateProvider(id, { ...config, ...(apiKey ? { apiKey } : {}) });
  } else {
    await store.addProvider({ ...config, apiKey, enabled: true });
  }
  if (useProviderStore.getState().error) throw new Error('Could not save the provider.');
}

function modelEntries(): Entry[] {
  const store = useModelStore.getState();
  const providers = useProviderStore.getState().providers;
  return Array.from(store.models.values()).flat().map((model) => ({
    id: model.id, title: model.name,
    description: providers.find((provider) => provider.id === model.providerId)?.name,
    enabled: store.favorites.includes(model.id),
    values: {
      providerId: model.providerId,
      selected: String(model.id === store.selectedModelId && model.providerId === store.selectedProviderId),
      recent: String(store.recentModels.includes(model.id)),
      reasoning: String(model.supportsReasoning || !!model.userEnabledReasoning),
      canToggleReasoning: String(!model.supportsReasoning),
      capabilities: [
        model.supportsVision && 'vision', model.supportsImageGeneration && 'image',
        (model.supportsAudioInput || model.supportsAudioOutput) && 'audio',
        model.supportsFunctionCalling && 'tools',
      ].filter(Boolean).join(','),
      contextWindow: String(model.contextWindow || ''),
      maxOutputTokens: String(model.maxOutputTokens || ''),
      autoContextWindow: String(model.autoContextWindow ?? model.contextWindow ?? ''),
      priceInput: model.pricing ? String(model.pricing.input) : '',
      priceOutput: model.pricing ? String(model.pricing.output) : '',
    },
  }));
}

function promptEntries(t: (key: string) => string): Entry[] {
  const store = usePromptStore.getState();
  return [
    ...store.customUserPrompts.map((item) => ({
      id: item.id, title: item.title, description: item.description, type: 'custom', enabled: item.enabled,
      values: { category: item.category },
    })),
    ...BUILTIN_PROMPTS_META.map((item) => ({
      id: item.key, title: t(item.titleKey) === item.titleKey ? item.defaultTitle : t(item.titleKey),
      description: t(item.descKey) === item.descKey ? item.defaultDesc : t(item.descKey), type: 'builtin',
      values: { category: item.category, modified: String(store.isModified(item.key)) },
    })),
  ];
}

async function loadSkills() {
  const store = useSkillsStore.getState();
  if (!store.loaded || store.loadedRootPath !== useWorkspaceStore.getState().rootPath) await store.load();
  return useSkillsStore.getState();
}

function skillEntry(skill: Skill): Entry {
  return {
    id: skill.id, title: skill.name, description: skill.description, type: skill.scope, enabled: skill.enabled !== false,
    values: { source: skill.source, tags: skill.tags.join(', ') },
  };
}

async function memoryState() {
  const root = useWorkspaceStore.getState().rootPath;
  const state = useMemoryV2Store.getState();
  if (!state.initialized) await state.init(root);
  return useMemoryV2Store.getState();
}

function visibleMemories(state: Awaited<ReturnType<typeof memoryState>>) {
  return state.records.filter((item) => item.deletedAt === null && (
    item.layer === 'global' || (!!state.projectId && item.projectId === state.projectId)
  )).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function memoryEntries(): Promise<Entry[]> {
  const state = await memoryState();
  if (!state.active) {
    const legacy = useMemoryStore.getState();
    if (!legacy.loaded) await legacy.load();
    return useMemoryStore.getState().relevant(useWorkspaceStore.getState().rootPath).map((item) => ({
      id: item.id, title: item.text.slice(0, 90), description: item.kind, type: 'legacy', values: { scope: item.scope },
    }));
  }
  return visibleMemories(state).map((item) => ({
    id: item.id, title: item.title, description: item.content.slice(0, 180), type: item.layer,
    values: { status: item.status, tags: item.tags.join(', ') },
  }));
}

function marketEntries(state: MarketSnapshot, kind: string): Entry[] {
  if (kind === 'marketInstalled') return state.installed.map((item) => ({
    id: item.id, title: item.title, description: item.name, type: item.status, enabled: item.enabled,
    values: { profileId: state.profile.id, version: item.version, installed: 'true' },
  }));
  if (kind === 'marketProfiles') return state.profiles.map((item) => ({
    id: item.id, title: item.name, description: String(item.pluginCount), enabled: item.active,
  }));
  if (kind === 'marketSources') return state.sources.map((item) => ({
    id: item.id, title: item.title, type: item.kind,
    enabled: item.enabled, values: { cachedEntries: String(item.cachedEntries) },
  }));
  return state.catalog.items.map((item) => ({
    id: item.id, title: string(item.title, 200), description: string(item.description, 1_000),
    type: item.compatibility.state, enabled: item.installed?.enabled,
    values: { profileId: state.profile.id, installed: String(!!item.installed) },
  }));
}

async function list(section: string, page: number, query: string): Promise<Page> {
  const api = window.electronAPI;
  switch (section) {
    case 'general': return { items: generalSettings() };
    case 'providers': return pageOf(useProviderStore.getState().providers.map(providerEntry), page, query);
    case 'models': return pageOf(modelEntries(), page, query);
    case 'prompts': return pageOf(promptEntries(useLanguageStore.getState().t), page, query);
    case 'skills': {
      const store = await loadSkills();
      return pageOf(store.installed.map(skillEntry).concat(store.catalog().map((item) => ({
        id: item.id, title: item.name, description: item.description, type: 'catalog',
        values: {
          source: 'builtin', tags: item.tags.join(', '),
          scopes: store.installed.filter((skill) => skill.id === item.id).map((skill) => skill.scope).join(','),
        },
      }))), page, query);
    }
    case 'plugins': return pageOf(selectPlugins().map((item) => ({
      id: item.id, title: item.name, description: item.description, type: item.kind, enabled: item.enabled,
      values: { skillId: item.skillId || '' },
    })), page, query);
    case 'mcp': {
      const [config, tools] = await Promise.all([api.mcp.getConfig(), api.mcp.list()]);
      const serverNames = Object.keys(record(record(config).mcpServers ?? record(config).servers));
      const entries = tools.map((tool) => ({
        id: tool.name, title: tool.name, description: string(tool.description, 1_000), type: tool.server,
      }));
      for (const id of serverNames) {
        if (!tools.some((tool) => tool.server === id)) entries.push({ id, title: id, description: '', type: 'noTools' });
      }
      return pageOf(entries, page, query);
    }
    case 'memory': return pageOf(await memoryEntries(), page, query);
    case 'wiki': {
      const memory = await memoryState();
      await memory.loadWikiEntries();
      if (useMemoryV2Store.getState().wikiError) throw new Error('Could not read the Dream wiki.');
      return pageOf(useMemoryV2Store.getState().wikiEntries.map((item) => ({
        id: item.slug, title: item.name, description: item.description,
      })), page, query);
    }
    case 'agents': return pageOf((await readSubAgentHistory()).sort((a, b) => b.startedAt - a.startedAt).map((item) => ({
      id: item.id, title: item.task.slice(0, 300), type: item.status,
      description: new Date(item.startedAt).toLocaleString(),
    })), page, query);
    case 'market': {
      const state = await api.dshMarket.snapshot({ query, page, pageSize: PAGE_SIZE });
      return { items: marketEntries(state, section), more: state.catalog.total > state.catalog.page * state.catalog.pageSize };
    }
    case 'marketInstalled':
    case 'marketProfiles':
    case 'marketSources': return pageOf(marketEntries(await api.dshMarket.snapshot(), section), page, query);
    case 'updates': {
      const state = useUpdateStore.getState();
      const offer = state.result?.latest;
      const progress = state.download;
      const percent = progress && progress.state !== 'error' && progress.total
        ? String(Math.round(100 * progress.received / progress.total)) : '';
      return { items: [{
        id: 'update', title: state.appVersion || await api.app.getVersion(),
        description: offer?.summary, content: offer?.changelogItems.join('\n'),
        enabled: state.result?.updateAvailable === true,
        values: {
          offer: offer?.version || '',
          download: state.downloadError ? 'error' : progress?.state || '',
          percent,
        },
      }] };
    }
    default: throw new Error('Unknown settings section.');
  }
}

async function detail(section: string, id: string, type: string): Promise<Entry> {
  const api = window.electronAPI;
  switch (section) {
    case 'prompts': {
      const store = usePromptStore.getState();
      const custom = store.customUserPrompts.find((item) => item.id === id);
      if (custom) return {
        id, title: custom.title, description: custom.description, content: custom.content.slice(0, TEXT_LIMIT),
        type: 'custom', enabled: custom.enabled, values: { category: custom.category, editable: String(custom.content.length <= TEXT_LIMIT) },
      };
      const builtin = BUILTIN_PROMPTS_META.find((item) => item.key === id);
      if (builtin) {
        const content = store.getPrompt(builtin.key);
        return {
          id, title: useLanguageStore.getState().t(builtin.titleKey), description: builtin.defaultDesc,
          content: content.slice(0, TEXT_LIMIT), type: 'builtin',
          values: { editable: String(content.length <= TEXT_LIMIT) },
        };
      }
      break;
    }
    case 'skills': {
      const store = await loadSkills();
      if (type === 'catalog') {
        const item = store.catalog().find((skill) => skill.id === id);
        if (item) return { id, title: item.name, description: item.description, content: item.body.slice(0, TEXT_LIMIT), type };
      }
      const item = store.installed.find((skill) => skill.id === id && skill.scope === type);
      if (item) {
        const entry = skillEntry(item);
        return {
          ...entry, content: item.body.slice(0, TEXT_LIMIT),
          values: { ...entry.values, editable: String(item.body.length <= TEXT_LIMIT) },
        };
      }
      break;
    }
    case 'memory': {
      const state = await memoryState();
      if (!state.active) {
        const item = useMemoryStore.getState().relevant(useWorkspaceStore.getState().rootPath).find((entry) => entry.id === id);
        if (item) return { id, title: item.text.slice(0, 90), description: item.why, content: item.text, type: 'legacy' };
      }
      const item = visibleMemories(state).find((entry) => entry.id === id);
      if (item) return {
        id, title: item.title, description: item.why, content: item.content.slice(0, TEXT_LIMIT), type: item.layer,
        values: { status: item.status, tags: item.tags.join(', '), version: String(item.version), editable: String(item.content.length <= TEXT_LIMIT) },
      };
      break;
    }
    case 'wiki': {
      const memory = await memoryState();
      await memory.openWikiEntry(id);
      const item = useMemoryV2Store.getState().wikiSelected;
      if (item?.slug === id && !useMemoryV2Store.getState().wikiError) return {
        id, title: item.name, description: item.description, content: item.body.slice(0, TEXT_LIMIT),
      };
      break;
    }
    case 'agents': {
      const item = (await readSubAgentHistory()).find((run) => run.id === id);
      if (item) return {
        id, title: item.task, description: item.detail, type: item.status,
        content: item.messages.map((message) => [
          message.name || message.role, message.content, message.toolCalls?.map((call) => call.name).join(', '),
        ].filter(Boolean).join('\n')).join('\n\n').slice(0, TEXT_LIMIT),
      };
      break;
    }
    case 'market':
    case 'marketInstalled': {
      const result = await api.dshMarket.detail(id, type || undefined);
      return {
        id, title: result.plugin.title, description: result.plugin.description,
        content: result.readme?.slice(0, TEXT_LIMIT), type: result.plugin.format,
        enabled: result.installed?.enabled,
        values: {
          installed: String(!!result.installed), version: result.version.version,
          installedVersion: result.installed?.version || '',
          versions: result.versions.map((version) => version.version).join(','),
          compatibility: result.versions.find((version) => version.version === result.version.version)?.compatibility.state || '',
        },
      };
    }
  }
  throw new Error('Item not found.');
}

function requireWorkspace(request: WireObject): void {
  if (string(request.root, 16_384) !== (useWorkspaceStore.getState().rootPath || '')) {
    throw new Error('The desktop workspace changed. Refresh and try again.');
  }
}

async function promptAction(id: string, op: string, values: WireObject): Promise<void> {
  const store = usePromptStore.getState();
  if (op === 'resetAll') { store.resetAllPrompts(); return; }
  const builtin = BUILTIN_PROMPTS_META.find((item) => item.key === id);
  if (builtin && op === 'reset') { store.resetPrompt(builtin.key); return; }
  if (builtin && op === 'save') {
    store.setPrompt(builtin.key, requireText(values.content, TEXT_LIMIT));
    return;
  }
  if (id && !store.customUserPrompts.some((item) => item.id === id)) throw new Error('Prompt not found.');
  if (id && op === 'toggle') { store.toggleCustomPrompt(id); return; }
  if (id && op === 'delete') { store.deleteCustomPrompt(id); return; }
  if (op === 'save') {
    const data = {
      title: requireText(values.title, 120).trim(), description: string(values.description, 1_000).trim(),
      category: string(values.category, 120).trim(), content: requireText(values.content, TEXT_LIMIT),
    };
    if (id) store.updateCustomPrompt(id, data);
    else store.addCustomPrompt({ ...data, enabled: true });
    return;
  }
  throw new Error('Unknown prompt action.');
}

async function skillAction(id: string, op: string, values: WireObject, request: WireObject): Promise<void> {
  requireWorkspace(request);
  const store = await loadSkills();
  requireWorkspace(request);
  const scope = oneOf(values.scope, ['global', 'project']);
  const skill = store.installed.find((item) => item.id === id && item.scope === scope);
  if (op === 'install') {
    if (skill) throw new Error('This skill is already installed in the selected scope.');
    const item = store.catalog().find((candidate) => candidate.id === id);
    if (!item || !(await store.install(item, scope))) throw new Error('Could not install skill.');
    return;
  }
  if (op === 'save') {
    if (id && skill?.source !== 'custom') throw new Error('Only custom skills can be edited.');
    if (!useSettingsStore.getState().customSkillsAcknowledged) {
      throw new Error('Open the skill editor on the desktop to acknowledge custom skill permissions first.');
    }
    const draft = {
      name: requireText(values.name, 80), description: requireText(values.description, 400),
      tags: string(values.tags, 1_000).split(',').map((tag) => tag.trim()).filter(Boolean),
      body: requireText(values.body, TEXT_LIMIT),
    };
    if (!(await store.saveCustom(draft, scope, id || undefined))) throw new Error(useSkillsStore.getState().error || 'Could not save the skill.');
    return;
  }
  if (!skill) throw new Error('Skill not found.');
  if (op === 'delete') {
    useSkillsStore.setState({ error: null });
    await store.remove(skill);
    if (useSkillsStore.getState().error) throw new Error('Could not remove the skill.');
    return;
  }
  if (op === 'enable') {
    if (!(await store.setEnabled(skill, requireBool(values.enabled)))) throw new Error('Could not change the skill.');
    return;
  }
  if (op === 'run') {
    if (!store.effective.some((item) => item.id === id && item.scope === scope)) throw new Error('This skill is disabled or shadowed.');
    const chat = useChatStore.getState();
    const conversationId = requireText(values.conversationId);
    if (chat.activeConversationId !== conversationId || chat.streamingRuns[conversationId]) throw new Error('The selected conversation changed or is busy.');
    const model = useModelStore.getState().getSelectedModel();
    if (!model) throw new Error('Select a model first.');
    const task = string(values.task, 5_000).trim();
    void chat.sendMessage(`Use the installed skill ${skill.id}.${task ? `\n\n${task}` : ''}`, model.providerId, model.id);
    return;
  }
  throw new Error('Unknown skill action.');
}

async function memoryAction(id: string, op: string, values: WireObject, request: WireObject): Promise<void> {
  requireWorkspace(request);
  const state = await memoryState();
  requireWorkspace(request);
  if (!state.active) throw new Error('Memory 2.0 is unavailable on this desktop.');
  if (op === 'dreamAuto') { state.setDreamAuto(requireBool(values.enabled)); return; }
  if (op === 'dream') {
    if (state.dreaming) throw new Error('A Dream pass is already running.');
    if (!useModelStore.getState().getSelectedModel()) throw new Error('Select a model first.');
    void state.runDream();
    return;
  }
  if (op === 'sync') {
    await state.syncNow();
    if (useMemoryV2Store.getState().error) throw new Error('Could not sync memories.');
    return;
  }
  const existing = id ? visibleMemories(state).find((item) => item.id === id) : null;
  if (id && !existing) throw new Error('Memory not found.');
  if (existing && existing.version !== number(values.version, 1, Number.MAX_SAFE_INTEGER)) {
    throw new Error('The memory changed on the desktop. Refresh and try again.');
  }
  if (op === 'save') {
    const data = {
      title: string(values.title, 300),
      content: requireText(values.content, TEXT_LIMIT),
      tags: string(values.tags, 1_000).split(',').map((tag) => tag.trim()).filter(Boolean),
      why: string(values.why, 5_000).trim(),
    };
    if (id) await state.updateMemory(id, data);
    else {
      const layer = oneOf(values.layer, ['global', 'project']);
      if (layer === 'project' && !state.projectId) throw new Error('Open a project first.');
      const saved = await state.saveMemory({ ...data, layer, origin: 'user', status: 'confirmed' });
      if (!saved) throw new Error('Could not save the memory.');
    }
  } else if (id && op === 'archive') await state.archiveMemory(id);
  else if (id && op === 'delete') await state.deleteMemory(id);
  else if (id && op === 'undo') await state.undo(id);
  else throw new Error('Unknown memory action.');
  if (useMemoryV2Store.getState().error) throw new Error(useMemoryV2Store.getState().error || 'Memory action failed.');
}

async function marketAction(section: string, id: string, op: string, values: WireObject): Promise<void> {
  const api = window.electronAPI.dshMarket;
  const state = await api.snapshot();
  if (section === 'marketProfiles') {
    if (op === 'create') {
      await api.createProfile(requireText(values.id, 90), string(values.name, 120) || undefined);
      return;
    }
    if (op === 'switch' && state.profiles.some((profile) => profile.id === id)) {
      await api.switchProfile(id);
      return;
    }
  } else if (section === 'marketSources') {
    if (op === 'refresh') { await api.refreshSources(id || undefined); return; }
    if (op === 'remove' && state.sources.some((source) => source.id === id && source.kind !== 'bundled')) {
      if (!(await api.removeSource(id))) throw new Error('Could not remove the market source.');
      return;
    }
  } else {
    if (op === 'restart') { await api.restartRuntime(); return; }
    const profileId = requireText(values.profileId);
    if (profileId !== state.profile.id) throw new Error('The desktop market profile changed. Refresh and try again.');
    const version = string(values.version, 100) || undefined;
    if (op === 'install') { await api.install(profileId, requireText(id), version); return; }
    if (state.installed.some((item) => item.id === id)) {
      if (op === 'enable') { await api.setEnabled(profileId, id, requireBool(values.enabled)); return; }
      if (op === 'rollback') { await api.rollback(profileId, id, version); return; }
      if (op === 'uninstall') { await api.uninstall(profileId, id, false); return; }
    }
  }
  throw new Error('Unknown market action.');
}

async function action(section: string, op: string, id: string, values: WireObject, request: WireObject): Promise<void> {
  switch (section) {
    case 'general':
      if (op === 'save') return updateGeneral(id, values.value);
      break;
    case 'providers': {
      if (op === 'save') return saveProvider(id, values);
      const provider = getProvider(id);
      if (op === 'refresh') {
        if (!(await useModelStore.getState().fetchModels(provider.id))) throw new Error('Could not refresh models.');
        return;
      }
      if (provider.type === 'conecode-free') throw new Error('The built-in provider manages its own configuration.');
      const store = useProviderStore.getState();
      useProviderStore.setState({ error: null });
      if (op === 'delete') await store.deleteProvider(id);
      else if (op === 'enable') {
        if (provider.enabled !== requireBool(values.enabled)) await store.toggleProvider(id);
      } else break;
      if (useProviderStore.getState().error) throw new Error('Could not change the provider.');
      return;
    }
    case 'models': {
      const store = useModelStore.getState();
      const providerId = requireText(values.providerId);
      if (!store.getModelsByProvider(providerId).some((model) => model.id === id)) throw new Error('Model not found.');
      if (op === 'select') store.selectModel(id, providerId);
      else if (op === 'favorite') await store.toggleFavorite(id);
      else if (op === 'reasoning') store.toggleReasoning(providerId, id);
      else if (op === 'limits') {
        const raw = string(values.contextWindow).trim();
        const contextWindow = raw ? parseLimitInput(raw) : null;
        if (raw && !Number.isSafeInteger(contextWindow)) throw new Error('Invalid context window.');
        store.setModelLimits(providerId, id, { contextWindow });
      } else break;
      return;
    }
    case 'prompts': return promptAction(id, op, values);
    case 'skills': return skillAction(id, op, values, request);
    case 'memory':
    case 'wiki': return memoryAction(id, op, values, request);
    case 'mcp':
      if (op === 'reload') {
        requireWorkspace(request);
        await window.electronAPI.mcp.reload(useWorkspaceStore.getState().rootPath || undefined);
        return;
      }
      break;
    case 'plugins': {
      const store = usePluginStore.getState();
      if (op === 'add') {
        const skillId = string(values.skillId, 90).trim();
        if (skillId && !(await loadSkills()).installed.some((skill) => skill.id === skillId)) throw new Error('Linked skill not found.');
        if (!store.addCustom({ name: requireText(values.name, 120), description: requireText(values.description, 1_000), skillId })) {
          throw new Error('Could not add the plugin.');
        }
        return;
      }
      if (op === 'enable' && selectPlugins().some((item) => item.id === id)) {
        store.setEnabled(id, requireBool(values.enabled));
        return;
      }
      if (op === 'delete' && store.custom.some((item) => item.id === id)) { store.removeCustom(id); return; }
      break;
    }
    case 'market':
    case 'marketInstalled':
    case 'marketProfiles':
    case 'marketSources': return marketAction(section, id, op, values);
    case 'updates': {
      const store = useUpdateStore.getState();
      if (op === 'check') {
        await store.check();
        if (useUpdateStore.getState().errorCode) throw new Error('Could not check for desktop updates.');
        return;
      }
      if (op === 'download' && store.result?.updateAvailable && store.result.latest?.version === values.version) {
        await store.startDownload();
        if (useUpdateStore.getState().downloadError) throw new Error('Could not download the desktop update.');
        return;
      }
      if (op === 'reveal' && store.download?.state === 'completed') { await store.reveal(); return; }
      break;
    }
  }
  throw new Error('Unknown settings action.');
}

export async function handleRemoteSettings(input: unknown): Promise<SettingsReply> {
  const request = record(input);
  const section = string(request.section, 40);
  const op = string(request.action, 40);
  const id = string(request.id);
  try {
    const workspaceScoped = ['skills', 'memory', 'wiki', 'mcp'].includes(section);
    if (workspaceScoped) requireWorkspace(request);
    if (op === 'list') {
      const page = request.page === undefined ? 1 : Math.floor(number(request.page, 1, 40_000));
      const result = await list(section, page, string(request.query, 200).trim());
      if (workspaceScoped) requireWorkspace(request);
      return { ok: true, page: result };
    }
    if (op === 'detail') {
      const item = await detail(section, requireText(id), string(request.itemType, 100));
      if (workspaceScoped) requireWorkspace(request);
      return { ok: true, item };
    }
    await action(section, op, id, record(request.values), request);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 1_000) : 'The desktop could not finish the request.' };
  }
}
