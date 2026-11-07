import type { ModelTool } from './types.js';

const targetSelector = {
  type: 'object',
  description:
    'A target from the CURRENT observation. Prefer targetId. A role/name selector is resolved against the current observation; ambiguity is an error, never a guess.',
  properties: {
    targetId: { type: 'string' },
    role: { type: 'string' },
    name: { type: 'string' },
    ordinal: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const;

const conditionSchema = {
  type: 'object',
  description: 'A programmatic postcondition, e.g. {"kind":"text_visible","text":"Saved"} or {"kind":"record_field","url":"http://127.0.0.1:3000/api/x","path":["name"],"equals":"Demo"}.',
  additionalProperties: true,
} as const;

export const TOOL_DEFINITIONS: Array<ModelTool & { actionTool?: string }> = [
  {
    name: 'browser_observe',
    description: 'Read the current browser page again. Returns a new observation with fresh target ids.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    actionTool: 'browser.observe',
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the active tab to an allowed http(s) URL.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    actionTool: 'browser.navigate',
  },
  {
    name: 'browser_open_tab',
    description: 'Open a new tab, optionally navigating to an allowed URL.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' }, focus: { type: 'boolean' } },
      additionalProperties: false,
    },
    actionTool: 'browser.open_tab',
  },
  {
    name: 'browser_switch_tab',
    description: 'Switch the active tab by tab id from the current observation.',
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false,
    },
    actionTool: 'browser.switch_tab',
  },
  {
    name: 'browser_close_tab',
    description: 'Close a tab by tab id.',
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false,
    },
    actionTool: 'browser.close_tab',
  },
  {
    name: 'browser_click',
    description:
      'Click an element from the current observation, or a screenshot coordinate when the screenshot metadata is present. Include expected postconditions when the click changes state.',
    parameters: {
      type: 'object',
      properties: {
        target: targetSelector,
        targetId: { type: 'string' },
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        clickCount: { type: 'integer', minimum: 1, maximum: 3 },
        expected: { type: 'array', items: conditionSchema },
      },
      additionalProperties: false,
    },
    actionTool: 'browser.click',
  },
  {
    name: 'browser_fill',
    description: 'Replace the value of an input/textarea/contenteditable target. The postcondition value_equals is checked automatically.',
    parameters: {
      type: 'object',
      properties: {
        target: targetSelector,
        targetId: { type: 'string' },
        value: { type: 'string' },
        expected: { type: 'array', items: conditionSchema },
      },
      required: ['value'],
      additionalProperties: false,
    },
    actionTool: 'browser.fill',
  },
  {
    name: 'browser_type',
    description: 'Type text into the focused element or an observed target. Supports Unicode.',
    parameters: {
      type: 'object',
      properties: {
        target: targetSelector,
        targetId: { type: 'string' },
        text: { type: 'string' },
        clearFirst: { type: 'boolean' },
        expected: { type: 'array', items: conditionSchema },
      },
      required: ['text'],
      additionalProperties: false,
    },
    actionTool: 'browser.type',
  },
  {
    name: 'browser_press',
    description: 'Press a key or key combination such as Enter, Tab, Meta+S.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        target: targetSelector,
        targetId: { type: 'string' },
        expected: { type: 'array', items: conditionSchema },
      },
      required: ['key'],
      additionalProperties: false,
    },
    actionTool: 'browser.press',
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page. After scrolling, re-observe before using screenshot coordinates.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number' },
        target: targetSelector,
        targetId: { type: 'string' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
    actionTool: 'browser.scroll',
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the active tab viewport and attach it as evidence.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    actionTool: 'browser.screenshot',
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for a programmatic condition. Fails instead of assuming success.',
    parameters: {
      type: 'object',
      properties: {
        condition: conditionSchema,
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
      },
      required: ['condition'],
      additionalProperties: false,
    },
    actionTool: 'browser.wait_for',
  },
  {
    name: 'desktop_click',
    description: 'Click at screenshot coordinates from the latest desktop observation (the driver converts via recorded scale metadata).',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        clickCount: { type: 'integer', minimum: 1, maximum: 3 },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    actionTool: 'desktop.click',
  },
  {
    name: 'desktop_type',
    description: 'Type Unicode text into the focused desktop application.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    actionTool: 'desktop.type',
  },
  {
    name: 'desktop_key',
    description: 'Press a key combination such as Meta+S or Return in the focused desktop application.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
    actionTool: 'desktop.key',
  },
  {
    name: 'desktop_scroll',
    description: 'Scroll at a screen coordinate.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', minimum: 1, maximum: 50 },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
    actionTool: 'desktop.scroll',
  },
  {
    name: 'desktop_move',
    description: 'Move the pointer to screenshot coordinates from the latest desktop observation.',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    actionTool: 'desktop.move',
  },
  {
    name: 'desktop_drag',
    description: 'Drag between screenshot coordinates from the latest desktop observation.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        to: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        durationMs: { type: 'integer', minimum: 1, maximum: 10000 },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    actionTool: 'desktop.drag',
  },
  {
    name: 'desktop_screenshot',
    description: 'Capture the current desktop display and refresh coordinates.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    actionTool: 'desktop.screenshot',
  },
  {
    name: 'desktop_focus_app',
    description: 'Bring a desktop application to the front by name.',
    parameters: {
      type: 'object',
      properties: { appName: { type: 'string' } },
      required: ['appName'],
      additionalProperties: false,
    },
    actionTool: 'desktop.focus_app',
  },
  {
    name: 'desktop_open_app',
    description: 'Open a desktop application by name.',
    parameters: {
      type: 'object',
      properties: { appName: { type: 'string' } },
      required: ['appName'],
      additionalProperties: false,
    },
    actionTool: 'desktop.open_app',
  },
  {
    name: 'desktop_edit_document',
    description:
      'Fallback app-scripting channel: ask TextEdit to replace the front document text and save it to an authorized file path. This is not raw keyboard/mouse input and is logged as a separate capability.',
    parameters: {
      type: 'object',
      properties: {
        appName: { type: 'string', enum: ['TextEdit'] },
        content: { type: 'string' },
        savePath: { type: 'string' },
      },
      required: ['content', 'savePath'],
      additionalProperties: false,
    },
    actionTool: 'desktop.edit_document',
  },
  {
    name: 'run_code',
    description:
      'Run a short JavaScript snippet in the isolated persistent runtime. The only UI access is the provided `ui` object (observe/click/fill/type/press/scroll/screenshot); every UI call is revalidated and logged by the executor. Use for short combinations of already-understood actions, not for new unknown pages.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
      },
      required: ['code'],
      additionalProperties: false,
    },
    actionTool: 'code.run',
  },
  {
    name: 'ask_user',
    description:
      'Ask the user a necessary question or request approval when the task is blocked on missing information or consent. Execution pauses.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        requestId: { type: 'string' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description:
      'Propose that the task is complete. This is NOT acceptance: the runtime independently verifies the user-provided acceptance criteria. Include a short summary and optional extra checks.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        suggestedChecks: { type: 'array', items: conditionSchema },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    actionTool: 'task.finish',
  },
];

export function toolsForCapabilities(options: {
  browser: boolean;
  desktop: boolean;
  code: boolean;
  images: boolean;
}): ModelTool[] {
  return TOOL_DEFINITIONS.filter((tool) => {
    if (tool.name.startsWith('desktop_')) return options.desktop;
    if (tool.name === 'run_code') return options.code;
    if (tool.name.startsWith('browser_')) return options.browser;
    return true;
  }).map(({ actionTool: _actionTool, ...tool }) => tool);
}

export function actionToolFor(toolName: string): string | undefined {
  return TOOL_DEFINITIONS.find((t) => t.name === toolName)?.actionTool;
}
