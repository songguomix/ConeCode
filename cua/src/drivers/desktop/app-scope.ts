import { CuaError } from '../../protocol/errors.js';
import type { Target } from '../../protocol/schemas.js';

/**
 * Pure helpers for single-application desktop computer use.
 *
 * The desktop driver used to photograph the whole main display and post mouse
 * events in screen coordinates. That forces every step to read pixels that
 * belong to other applications and lets a stray click land outside the app the
 * task is about. Everything in this module exists so one window of one app can
 * be observed and operated: window selection, window-local coordinates and the
 * conversion of an app's accessibility tree into structured targets.
 *
 * Nothing here talks to macOS, so it is unit-testable on any platform.
 */

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One layer-0 window reported by the native helper. */
export interface WindowInfo {
  windowId: number;
  pid: number;
  appName: string;
  bundleId?: string;
  /** Bundle display name without .app (stable across localised app names). */
  bundleName?: string;
  title?: string;
  bounds: WindowBounds;
  scale?: number;
}

export interface WindowScope {
  appName?: string;
  bundleId?: string;
  windowTitle?: string;
  windowId?: number;
}

export const MIN_WINDOW_SIDE = 8;
/** Tolerance, in points, for clicks that land on the window frame edge. */
export const WINDOW_POINT_TOLERANCE = 2;

const ACTIONABLE_ROLES: Record<string, string> = {
  AXButton: 'button',
  AXCheckBox: 'checkbox',
  AXRadioButton: 'radio',
  AXPopUpButton: 'combobox',
  AXComboBox: 'combobox',
  AXTextField: 'textbox',
  AXTextArea: 'textbox',
  AXSearchField: 'searchbox',
  AXMenuItem: 'menuitem',
  AXMenuBarItem: 'menuitem',
  AXLink: 'link',
  AXSlider: 'slider',
  AXIncrementor: 'spinbutton',
  AXTab: 'tab',
  AXDisclosureTriangle: 'disclosure',
  AXColorWell: 'colorwell',
  AXSwitch: 'switch',
  AXToggle: 'switch',
  AXToolbarButton: 'button',
};

const STRUCTURAL_TAGS: Record<string, string> = {
  AXApplication: 'application',
  AXWindow: 'window',
  AXSheet: 'dialog',
  AXGroup: 'group',
  AXScrollArea: 'scrollarea',
  AXSplitGroup: 'splitgroup',
  AXTabGroup: 'tablist',
  AXTable: 'table',
  AXOutline: 'tree',
  AXRow: 'row',
  AXCell: 'cell',
  AXList: 'list',
  AXToolbar: 'toolbar',
  AXMenuBar: 'menubar',
  AXMenu: 'menu',
  AXStaticText: 'text',
  AXImage: 'img',
  AXHeading: 'heading',
  AXListBox: 'listbox',
  AXProgressIndicator: 'progressbar',
  AXBusyIndicator: 'progressbar',
  AXLevelIndicator: 'meter',
};

export function describeWindow(window: WindowInfo): string {
  const parts = [window.appName || 'unknown app'];
  if (window.bundleId) parts.push(`(${window.bundleId})`);
  if (window.title) parts.push(JSON.stringify(window.title));
  parts.push(`window ${window.windowId}`);
  parts.push(
    `at ${Math.round(window.bounds.x)},${Math.round(window.bounds.y)} ${Math.round(window.bounds.width)}x${Math.round(window.bounds.height)}`,
  );
  return parts.join(' ');
}

function normalise(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function matchesApp(window: WindowInfo, scope: WindowScope): boolean {
  const appName = normalise(scope.appName);
  const bundleId = normalise(scope.bundleId);
  if (!appName && !bundleId) return true;
  const windowApp = normalise(window.appName);
  const windowBundle = normalise(window.bundleId);
  const windowBundleName = normalise(window.bundleName);
  if (bundleId && windowBundle !== bundleId) return false;
  if (!appName) return true;
  return (
    windowApp === appName ||
    windowApp.includes(appName) ||
    windowBundle.includes(appName) ||
    windowBundleName === appName ||
    windowBundleName.includes(appName)
  );
}

/**
 * Pick exactly one window, deterministically, or fail with the reason.
 *
 * The helper reports windows front-to-back, so the first match is the window
 * the user would see. Explicit `windowId` wins, then app, then title filter.
 */
export function selectAppWindow(windows: WindowInfo[], scope: WindowScope): WindowInfo {
  const usable = windows.filter(
    (window) =>
      Number.isFinite(window.windowId) &&
      window.windowId > 0 &&
      window.bounds &&
      window.bounds.width >= MIN_WINDOW_SIDE &&
      window.bounds.height >= MIN_WINDOW_SIDE,
  );
  if (scope.windowId !== undefined) {
    const exact = usable.find((window) => window.windowId === scope.windowId);
    if (!exact) {
      throw new CuaError(
        'TARGET_NOT_FOUND',
        `Window ${scope.windowId} is not open or is not a normal app window. Nothing was read or operated.`,
      );
    }
    return exact;
  }
  const titleFilter = normalise(scope.windowTitle);
  const candidates = usable.filter(
    (window) =>
      matchesApp(window, scope) && (!titleFilter || normalise(window.title).includes(titleFilter)),
  );
  if (candidates.length === 0) {
    const wanted = [
      scope.appName ? `app ${JSON.stringify(scope.appName)}` : undefined,
      scope.bundleId ? `bundle ${JSON.stringify(scope.bundleId)}` : undefined,
      scope.windowTitle ? `title containing ${JSON.stringify(scope.windowTitle)}` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    const seen = usable.length === 0 ? 'no normal windows are visible' : `visible windows: ${usable.slice(0, 6).map(describeWindow).join('; ')}`;
    throw new CuaError(
      'TARGET_NOT_FOUND',
      `No window matched ${wanted || 'the requested app'} (${seen}). Open the app window first; nothing was read or operated.`,
    );
  }
  return candidates[0]!;
}

export function windowBoundsKey(bounds: WindowBounds): string {
  return [bounds.x, bounds.y, bounds.width, bounds.height].map((value) => Math.round(value)).join(',');
}

export function windowLocalToGlobal(point: { x: number; y: number }, bounds: WindowBounds): { x: number; y: number } {
  return { x: point.x + bounds.x, y: point.y + bounds.y };
}

export function globalToWindowLocal(point: { x: number; y: number }, bounds: WindowBounds): { x: number; y: number } {
  return { x: point.x - bounds.x, y: point.y - bounds.y };
}

export function isPointInsideWindow(
  point: { x: number; y: number },
  bounds: WindowBounds,
  tolerance = WINDOW_POINT_TOLERANCE,
): boolean {
  return (
    point.x >= -tolerance &&
    point.y >= -tolerance &&
    point.x <= bounds.width + tolerance &&
    point.y <= bounds.height + tolerance
  );
}

export function describePoint(point: { x: number; y: number }): string {
  return `${Math.round(point.x)},${Math.round(point.y)}`;
}

/** One accessibility node as reported by the native helper (screen coordinates). */
export interface AxNode {
  path: string;
  depth?: number;
  role?: string;
  subrole?: string;
  title?: string;
  value?: string;
  description?: string;
  identifier?: string;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  actions?: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface AxTargetsOptions {
  maxTargets?: number;
  maxTextChars?: number;
}

export interface AxTargetsResult {
  targets: Target[];
  text: string;
  omitted: number;
  /** Target list hit the cap. */
  truncated: boolean;
  /** Text outline hit the character cap. */
  textTruncated: boolean;
}

function roleTag(role: string | undefined): string {
  if (!role) return 'unknown';
  return ACTIONABLE_ROLES[role] ?? STRUCTURAL_TAGS[role] ?? 'unknown';
}

function isActionable(node: AxNode): boolean {
  const role = node.role ?? '';
  if (ACTIONABLE_ROLES[role]) return true;
  return (node.actions ?? []).some((action) => action === 'AXPress' || action === 'AXConfirm' || action === 'AXOpen');
}

function displayName(node: AxNode): string {
  const candidates = [node.title, node.description, node.value, node.identifier];
  for (const candidate of candidates) {
    const text = (candidate ?? '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 200);
  }
  return '';
}

function intersectsWindow(node: AxNode, window: WindowBounds): boolean {
  if (node.x === undefined || node.y === undefined || node.width === undefined || node.height === undefined) {
    return false;
  }
  if (node.width <= 0 || node.height <= 0) return false;
  return (
    node.x + node.width > window.x &&
    node.x < window.x + window.width &&
    node.y + node.height > window.y &&
    node.y < window.y + window.height
  );
}

/**
 * Convert the app accessibility tree into window-local targets plus a compact
 * textual outline. Only nodes inside the scoped window become targets, so the
 * model can never be handed a control that lives in another window.
 */
export function axNodesToTargets(
  nodes: AxNode[],
  window: WindowBounds,
  options: AxTargetsOptions = {},
): AxTargetsResult {
  const maxTargets = options.maxTargets ?? 160;
  const maxTextChars = options.maxTextChars ?? 4_000;
  const targets: Target[] = [];
  const lines: string[] = [];
  let omitted = 0;
  let truncated = false;
  let textTruncated = false;

  for (const node of nodes) {
    const depth = node.depth ?? 0;
    if (depth > 8) continue;
    const name = displayName(node);
    const tag = roleTag(node.role);
    const structural = tag === 'group' || tag === 'window' || tag === 'application';
    if (!name && structural) continue;
    if (!name && !isActionable(node)) continue;

    if (intersectsWindow(node, window)) {
      if (targets.length >= maxTargets) {
        omitted += 1;
        truncated = true;
      } else {
        const localX = (node.x ?? window.x) - window.x;
        const localY = (node.y ?? window.y) - window.y;
        const attributes: Record<string, string> = { axPath: node.path };
        if (node.subrole) attributes.subrole = node.subrole;
        if (node.identifier) attributes.identifier = node.identifier;
        const actions = (node.actions ?? []).filter(Boolean);
        if (actions.length > 0) attributes.actions = actions.join(',');
        targets.push({
          targetId: `ax:${node.path || '0'}`,
          frameId: 'main',
          role: node.role ?? 'unknown',
          name: name || node.role || 'unknown',
          tag,
          value: node.value ? node.value.slice(0, 1000) : undefined,
          disabled: node.enabled === false ? true : undefined,
          visible: true,
          actionable: isActionable(node),
          bbox: {
            x: localX,
            y: localY,
            width: node.width ?? 0,
            height: node.height ?? 0,
          },
          attributes,
          ordinal: targets.length,
        });
      }
    }

    const indent = '  '.repeat(Math.min(depth, 6));
    const label = node.role ? node.role.replace(/^AX/, '') : 'node';
    if (name) lines.push(`${indent}${label} ${JSON.stringify(name)}`);
  }

  let text = lines.join('\n');
  if (text.length > maxTextChars) {
    text = text.slice(0, maxTextChars);
    textTruncated = true;
  }
  return { targets, text, omitted, truncated, textTruncated };
}

/** Stable observation surface for one app, so freshness is per app not per display. */
export function appWindowSurfaceId(window: Pick<WindowInfo, 'appName' | 'bundleId' | 'pid'>): string {
  const key = window.bundleId || window.appName || `pid-${window.pid}`;
  return `desktop_app:${key.replace(/\s+/g, '-').toLowerCase()}`;
}

/**
 * Keep only the accessibility subtree of the scoped window. An application's AX
 * tree contains every window it owns (including ones behind the target), so
 * bounds filtering alone could surface controls from a different window.
 */
export function pruneAxTreeToWindow(
  nodes: AxNode[],
  window: WindowBounds,
  tolerance = 8,
): { nodes: AxNode[]; matched: boolean } {
  const windowNode = nodes.find((node) => {
    if (node.role !== 'AXWindow' && node.role !== 'AXSheet' && node.role !== 'AXDialog') return false;
    if (
      node.x === undefined ||
      node.y === undefined ||
      node.width === undefined ||
      node.height === undefined
    ) {
      return false;
    }
    return (
      Math.abs(node.x - window.x) <= tolerance &&
      Math.abs(node.y - window.y) <= tolerance &&
      Math.abs(node.width - window.width) <= tolerance &&
      Math.abs(node.height - window.height) <= tolerance
    );
  });
  if (!windowNode) return { nodes, matched: false };
  const prefix = `${windowNode.path}/`;
  return {
    nodes: nodes.filter((node) => node.path === windowNode.path || node.path.startsWith(prefix)),
    matched: true,
  };
}
