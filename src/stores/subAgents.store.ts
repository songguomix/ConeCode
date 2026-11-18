import { useEffect, useReducer, useState } from 'react';
import type { SubAgentRun } from '../types/subAgent.types';

// Completed transcripts live with their parent message. Keep only active or
// unsaved snapshots here so closing the panel releases the historical logs.
const transient = new Map<string, SubAgentRun>();
type Listener = (id: string, run: SubAgentRun | null) => void;
const listeners = new Set<Listener>();

export async function recordSubAgentRun(parentMessageId: string, run: SubAgentRun): Promise<void> {
  transient.set(run.id, run);
  for (const notify of listeners) notify(run.id, run);
  try {
    const saved = await window.electronAPI.message.recordSubAgent(parentMessageId, run);
    if (transient.get(run.id) !== run) return;
    if (!saved || run.status !== 'running') transient.delete(run.id);
    if (!saved) for (const notify of listeners) notify(run.id, null);
  } catch (error) {
    // A history write failure must not abort the delegated task. Its latest
    // snapshot remains readable this session and the next update retries.
    console.warn('Could not save sub-agent transcript', error);
  }
}

export function useSubAgentHistory() {
  const [runs, setRuns] = useState<SubAgentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [request, reload] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    let open = true;
    let reading = true;
    const changes = new Map<string, SubAgentRun | null>(transient);
    const onUpdate: Listener = (id, run) => {
      if (reading) changes.set(id, run);
      setRuns((previous) => {
        const remaining = previous.filter((r) => r.id !== id);
        return run ? [...remaining, run] : remaining;
      });
    };
    listeners.add(onUpdate);
    setRuns(Array.from(transient.values()));
    setLoading(true);
    setError(false);
    const load = async () => {
      try {
        const history = await window.electronAPI.message.subAgentHistory();
        if (!open) return;
        const merged = new Map<string, SubAgentRun>();
        for (const run of history) {
          // A running snapshot without a live owner survived an app restart.
          merged.set(run.id, run.status === 'running' ? { ...run, status: 'interrupted' } : run);
        }
        // Include updates that arrived after the IPC read began.
        for (const [id, run] of changes) {
          if (run) merged.set(id, run);
          else merged.delete(id);
        }
        setRuns(Array.from(merged.values()));
      } catch {
        if (open) setError(true);
      } finally {
        reading = false;
        changes.clear();
        if (open) setLoading(false);
      }
    };
    void load();
    return () => {
      open = false;
      listeners.delete(onUpdate);
    };
  }, [request]);

  return { runs, loading, error, reload };
}
