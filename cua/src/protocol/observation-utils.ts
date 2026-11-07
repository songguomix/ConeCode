import { CuaError } from './errors.js';
import type { Action, Observation, Target } from './schemas.js';

export interface ObservationFreshnessContext {
  surfaceId: string;
  generation: number;
  url?: string;
  scrollX?: number;
  scrollY?: number;
}

/**
 * An observation id only proves what the agent saw. It does not freeze the
 * page. Before every action we also compare the live surface generation and
 * URL; navigation or reload invalidates every target from the old generation.
 */
export function assertObservationFresh(
  observation: Observation,
  live: ObservationFreshnessContext,
): void {
  if (observation.surfaceId !== live.surfaceId) {
    throw new CuaError('OBSERVATION_STALE', 'The action targets a surface that is no longer active.', {
      details: { observedSurface: observation.surfaceId, liveSurface: live.surfaceId },
    });
  }
  if (observation.generation !== live.generation) {
    throw new CuaError('OBSERVATION_STALE', 'The page changed since it was observed; re-observe before acting.', {
      details: { observedGeneration: observation.generation, liveGeneration: live.generation },
    });
  }
  if (observation.interface.url && live.url && normalizeUrl(observation.interface.url) !== normalizeUrl(live.url)) {
    throw new CuaError('OBSERVATION_STALE', 'The page navigated since it was observed; re-observe before acting.', {
      details: { observedUrl: observation.interface.url, liveUrl: live.url },
    });
  }
  if (
    observation.screenshot &&
    live.scrollX !== undefined &&
    live.scrollY !== undefined &&
    (Math.abs(observation.screenshot.scrollX - live.scrollX) > 1 || Math.abs(observation.screenshot.scrollY - live.scrollY) > 1)
  ) {
    throw new CuaError('OBSERVATION_STALE', 'The page scrolled since the screenshot was captured; re-observe before using screenshot coordinates.', {
      details: {
        observedScroll: [observation.screenshot.scrollX, observation.screenshot.scrollY],
        liveScroll: [live.scrollX, live.scrollY],
      },
    });
  }
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

export function findTarget(observation: Observation, targetId: string): Target {
  const target = observation.targets.find((t) => t.targetId === targetId);
  if (!target) {
    throw new CuaError('TARGET_NOT_FOUND', `Target "${targetId}" is not present in observation ${observation.id}.`, {
      details: { observationId: observation.id, targetId, known: observation.targets.map((t) => t.targetId).slice(0, 100) },
    });
  }
  return target;
}

export function findTargetsByName(observation: Observation, name: string): Target[] {
  const needle = name.trim().toLowerCase();
  return observation.targets.filter((t) => t.name.trim().toLowerCase() === needle);
}

/** A compact view for the model. Cuts old targets from large pages while keeping coverage explicit. */
export function observationForModel(observation: Observation, maxTargets = 80, maxText = 6_000): Record<string, unknown> {
  const visible = observation.targets.filter((t) => t.visible);
  const targets = visible.slice(0, maxTargets).map((t) => ({
    targetId: t.targetId,
    role: t.role,
    name: t.name,
    tag: t.tag,
    type: t.type,
    value: t.value,
    disabled: t.disabled,
    bbox: t.bbox,
    ...(t.duplicateKey ? { duplicateKey: t.duplicateKey } : {}),
    ...(t.frameId !== 'main' ? { frameId: t.frameId } : {}),
  }));
  return {
    observationId: observation.id,
    generation: observation.generation,
    surfaceId: observation.surfaceId,
    interface: observation.interface,
    viewport: observation.viewport,
    screenshot: observation.screenshot
      ? {
          path: observation.screenshot.path,
          width: observation.screenshot.width,
          height: observation.screenshot.height,
          scaleX: observation.screenshot.scaleX,
          scaleY: observation.screenshot.scaleY,
        }
      : undefined,
    visibleText: observation.visibleText.slice(0, maxText),
    targets,
    coverage: {
      ...observation.coverage,
      targetsOmittedFromModel: Math.max(0, visible.length - targets.length),
      textOmittedFromModel: Math.max(0, observation.visibleText.length - maxText),
    },
  };
}

/** Deterministic short digest for duplicate-action detection. */
export function actionSignature(action: unknown): string {
  const s = JSON.stringify(action);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Stable retry identity within one task: transient target references are replaced
 * with observed semantic identity. URL, surface and business object scope keep
 * similarly named controls on different records/pages from sharing a budget.
 */
export function semanticActionSignature(action: Action, observation: Observation, businessObject?: unknown): string {
  const stable: Record<string, unknown> = { ...action };
  for (const key of ['targetId', 'fromTargetId', 'toTargetId']) {
    if (typeof stable[key] !== 'string') continue;
    const target = observation.targets.find((entry) => entry.targetId === stable[key]);
    stable[key] = target ? {
      role: target.role, name: target.name, tag: target.tag, type: target.type,
      frameUrl: observation.frames.find((frame) => frame.frameId === target.frameId)?.url ?? 'main',
      attributes: Object.fromEntries(Object.entries(target.attributes).sort(([a], [b]) => a.localeCompare(b))),
      ordinal: target.ordinal,
    } : { missingObservedTarget: true };
  }
  return actionSignature({
    action: stable, surfaceId: observation.surfaceId, url: observation.interface.url,
    appName: observation.interface.appName, windowTitle: observation.interface.windowTitle,
    businessObject,
  });
}
