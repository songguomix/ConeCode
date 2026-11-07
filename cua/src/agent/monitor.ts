import { actionSignature } from '../protocol/observation-utils.js';
import { isTerminal, type Event, type Task } from '../protocol/schemas.js';
import type { SessionStore } from '../store/store.js';

export interface MonitorAlert {
  taskId?: string;
  kind: 'stalled' | 'repeat-action' | 'repeat-failure' | 'long-unknown';
  detail: string;
  evidenceEventIds: string[];
}

/**
 * Read-only process monitor. It consumes the append-only event log and never
 * touches a live surface, changes focus, or sends actions. Alerts are written
 * back to the same event log as `monitor.alert` for the console/SDK.
 */
export class Monitor {
  private lastSeq = 0;
  private readonly emitted = new Set<string>();
  private readonly lastProgress = new Map<string, { at: number; eventId: string }>();

  constructor(
    private readonly store: SessionStore,
    private readonly options: { stallMs?: number; repeatThreshold?: number; failureThreshold?: number } = {},
  ) {}

  check(now = Date.now()): MonitorAlert[] {
    const events = this.store.listEvents(undefined, this.lastSeq, 2_000);
    if (events.length > 0) this.lastSeq = events[events.length - 1]!.seq;
    const alerts: MonitorAlert[] = [];
    const byTask = new Map<string, Event[]>();
    for (const event of events) {
      if (!event.taskId) continue;
      if (event.type === 'monitor.alert' || event.type === 'monitor.note') continue;
      const list = byTask.get(event.taskId) ?? [];
      list.push(event);
      byTask.set(event.taskId, list);
      if (
        event.type === 'observation.captured' ||
        event.type === 'action.result' ||
        event.type === 'verification.result' ||
        event.type === 'task.status'
      ) {
        this.lastProgress.set(event.taskId, { at: Date.parse(event.at), eventId: event.id });
      }
    }

    const threshold = this.options.repeatThreshold ?? 3;
    for (const [taskId, list] of byTask) {
      const intents = list.filter((e) => e.type === 'action.intent');
      const signatures = intents.map((e) => actionSignature(e.payload.action ?? e.payload.tool ?? {}));
      const counts = new Map<string, { count: number; ids: string[] }>();
      for (let i = 0; i < signatures.length; i++) {
        const entry = counts.get(signatures[i]!) ?? { count: 0, ids: [] };
        entry.count += 1;
        entry.ids.push(intents[i]!.id);
        counts.set(signatures[i]!, entry);
      }
      for (const [signature, entry] of counts) {
        if (entry.count >= threshold) {
          const key = `${taskId}:repeat:${signature}`;
          if (this.emitted.has(key)) continue;
          this.emitted.add(key);
          alerts.push({
            taskId,
            kind: 'repeat-action',
            detail: `The same action shape was proposed ${entry.count} times.`,
            evidenceEventIds: entry.ids.slice(-entry.count),
          });
        }
      }
      const failures = list.filter((e) => e.type === 'verification.result' && e.payload.verdict === 'fail');
      if (failures.length >= (this.options.failureThreshold ?? 3)) {
        const key = `${taskId}:failures`;
        if (!this.emitted.has(key)) {
          this.emitted.add(key);
          alerts.push({
            taskId,
            kind: 'repeat-failure',
            detail: `${failures.length} verification failures were recorded.`,
            evidenceEventIds: failures.slice(-5).map((e) => e.id),
          });
        }
      }
      const progress = this.lastProgress.get(taskId);
      if (progress && now - progress.at > (this.options.stallMs ?? 120_000)) {
        const task = this.store.getTask(taskId);
        if (task && !isTerminal(task.status) && task.status !== 'paused' && task.status !== 'awaiting_user') {
          const key = `${taskId}:stalled:${progress.eventId}`;
          if (!this.emitted.has(key)) {
            this.emitted.add(key);
            alerts.push({
              taskId,
              kind: 'stalled',
              detail: `No observation/action/verification event for ${Math.round((now - progress.at) / 1000)}s.`,
              evidenceEventIds: [progress.eventId],
            });
          }
        }
      }
    }
    for (const alert of alerts) {
      this.store.appendEvent({
        type: 'monitor.alert',
        actor: 'monitor',
        taskId: alert.taskId,
        payload: { kind: alert.kind, detail: alert.detail, evidenceEventIds: alert.evidenceEventIds },
      });
    }
    return alerts;
  }

  scanAll(now = Date.now()): MonitorAlert[] {
    this.lastSeq = 0;
    this.emitted.clear();
    this.lastProgress.clear();
    // Seed progress from historical events, then evaluate once without
    // duplicating alerts (the emitted set is fresh).
    const all = this.store.listEvents(undefined, 0, 5_000);
    for (const event of all) {
      if (event.taskId && (event.type === 'observation.captured' || event.type === 'action.result')) {
        this.lastProgress.set(event.taskId, { at: Date.parse(event.at), eventId: event.id });
      }
    }
    this.lastSeq = 0;
    return this.check(now);
  }
}
