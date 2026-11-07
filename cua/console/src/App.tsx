import React, { useCallback, useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    __CUA_TOKEN__?: string;
    __CUA_API__?: string;
  }
}

interface Task {
  id: string;
  goal: string;
  status: string;
  statusReason?: string;
  acceptance: any[];
  authorization: any;
  budgets: any;
  environment: any;
  createdAt: string;
  updatedAt: string;
  lastObservationId?: string;
  sessionId?: string;
}

interface EventItem {
  seq: number;
  id: string;
  type: string;
  at: string;
  actor: string;
  payload: any;
}

interface ActionItem {
  id: string;
  proposal: any;
  result?: any;
  status: string;
  startedAt: string;
}

interface VerificationItem {
  id: string;
  scope: string;
  verdict: string;
  criteria: any[];
  details: any[];
  at: string;
}

interface Details {
  task: Task;
  session?: any;
  latestObservation?: any;
  actions: ActionItem[];
  verifications: VerificationItem[];
  events: EventItem[];
  controller?: { awaitingUser?: { kind: string; question: string; actionId?: string }; pauseRequested?: boolean; cancelRequested?: boolean; step?: number };
}

const token = window.__CUA_TOKEN__ ?? '';
const base = (window.__CUA_API__ ?? '').replace(/\/$/, '');

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  return payload as T;
}

function artifactUrl(id: string): string {
  return `${base}/api/artifacts/${encodeURIComponent(id)}`;
}

function ArtifactImage({ artifactId }: { artifactId?: string }) {
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!artifactId) return;
    let revoked: string | undefined;
    let cancelled = false;
    setSrc(undefined);
    setError(undefined);
    fetch(artifactUrl(artifactId), { headers: { authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`artifact HTTP ${response.status}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        revoked = url;
        if (!cancelled) setSrc(url);
        else URL.revokeObjectURL(url);
      })
      .catch((err) => !cancelled && setError(String(err.message ?? err)));
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [artifactId]);
  if (!artifactId) return <div className="muted">No screenshot yet.</div>;
  if (error) return <div className="error">Screenshot unavailable: {error}</div>;
  if (!src) return <div className="muted">Loading screenshot…</div>;
  return <img className="screenshot" src={src} alt="latest observation screenshot" />;
}

function StatusBadge({ status }: { status: string }) {
  const cls = ['succeeded', 'failed', 'cancelled', 'paused', 'awaiting_user', 'needs_attention', 'verifying_unknown', 'verifying'].includes(status)
    ? status
    : 'running';
  return <span className={`badge ${cls}`}>{status}</span>;
}

const statusHelp: Record<string, string> = {
  verifying_unknown: 'An action outcome is unknown. The runtime is reading live state; it will not retry a write automatically.',
  paused: 'Paused. The agent is not writing. A paused task cannot promise that an in-flight action was rolled back.',
  awaiting_user: 'Waiting for you. The agent is not writing while awaiting input or approval.',
  needs_attention: 'Human decision required. Acceptance is not proven, or recovery found an unknown state.',
};

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string>();
  const [details, setDetails] = useState<Details>();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [error, setError] = useState<string>();
  const [metrics, setMetrics] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [inputText, setInputText] = useState('approve');
  const selectedRef = useRef<string>();
  const lastSeq = useRef(0);
  const detailsRequest = useRef(0);

  const refreshTasks = useCallback(async () => {
    const data = await api<{ tasks: Task[] }>('/api/tasks');
    setTasks(data.tasks);
    return data.tasks;
  }, []);

  const refreshDetails = useCallback(async (taskId: string) => {
    const request = ++detailsRequest.current;
    const data = await api<Details>(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (selectedRef.current !== taskId || detailsRequest.current !== request) return;
    setDetails(data);
    setEvents((previous) => {
      const merged = new Map([...previous, ...data.events].map((event) => [event.seq, event]));
      return [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-400);
    });
    lastSeq.current = Math.max(lastSeq.current, ...data.events.map((event) => event.seq));
  }, []);

  const selectTask = (taskId: string) => {
    if (selectedRef.current === taskId) return;
    // Switch ownership synchronously so an old HTTP/SSE response cannot paint
    // another task's details, or carry its global event cursor into this task.
    selectedRef.current = taskId;
    detailsRequest.current += 1;
    lastSeq.current = 0;
    setDetails(undefined);
    setEvents([]);
    setError(undefined);
    setSelected(taskId);
  };

  useEffect(() => {
    refreshTasks().catch((e) => setError(String(e.message ?? e)));
    api<any>('/api/metrics').then(setMetrics).catch(() => undefined);
    const timer = setInterval(() => {
      refreshTasks().catch(() => undefined);
      if (selectedRef.current) refreshDetails(selectedRef.current).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [refreshDetails, refreshTasks]);

  useEffect(() => {
    selectedRef.current = selected;
    if (!selected) return;
    refreshDetails(selected).catch((e) => setError(String(e.message ?? e)));
    const controller = new AbortController();
    let stopped = false;
    (async () => {
      while (!stopped && selectedRef.current === selected) {
        try {
          const response = await fetch(
            `${base}/api/tasks/${encodeURIComponent(selected)}/events?since=${lastSeq.current}&stream=1`,
            { headers: { authorization: `Bearer ${token}` }, signal: controller.signal },
          );
          if (!response.ok || !response.body) throw new Error(`stream HTTP ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!stopped && selectedRef.current === selected) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index: number;
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
              if (!data) continue;
              try {
                const event = JSON.parse(data) as EventItem;
                if (selectedRef.current !== selected || !Number.isSafeInteger(event.seq)) continue;
                lastSeq.current = Math.max(lastSeq.current, event.seq);
                setEvents((prev) => (prev.some((e) => e.seq === event.seq) ? prev : [...prev.slice(-400), event]));
                if (event.type === 'task.status' || event.type === 'task.finished' || event.type === 'verification.result') {
                  refreshDetails(selected).catch(() => undefined);
                  refreshTasks().catch(() => undefined);
                }
              } catch {
                // heartbeat/malformed frame
              }
            }
          }
        } catch (e: any) {
          if (stopped || controller.signal.aborted || selectedRef.current !== selected) return;
          setError(`Event stream: ${e.message ?? e}`);
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [selected, refreshDetails, refreshTasks]);

  const control = async (action: string) => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/tasks/${encodeURIComponent(selected)}/control`, { method: 'POST', body: JSON.stringify({ action }) });
      await refreshDetails(selected);
      await refreshTasks();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitInput = async () => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/tasks/${encodeURIComponent(selected)}/input`, {
        method: 'POST',
        body: JSON.stringify({ kind: details?.controller?.awaitingUser?.kind === 'approval' ? 'approval' : 'answer', text: inputText }),
      });
      await refreshDetails(selected);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const screenshotId = details?.latestObservation?.screenshot?.artifactId;
  const awaiting = details?.controller?.awaitingUser;

  return (
    <div className="app">
      <header>
        <div>
          <h1>Computer Use Agent</h1>
          <p className="muted">Local runtime · observe → propose → execute → verify → recover</p>
        </div>
        <div className="header-metrics">
          {metrics ? (
            <>
              <span>{metrics.succeeded} succeeded</span>
              <span>{metrics.needsAttention} need attention</span>
              <span>{metrics.actionCount} actions</span>
              <span>{metrics.modelCalls} model turns</span>
            </>
          ) : null}
        </div>
      </header>
      {error ? <div className="banner error">{error}</div> : null}
      <main>
        <aside className="task-list">
          <div className="panel-title">Tasks <button className="small" onClick={() => refreshTasks().catch(() => undefined)}>refresh</button></div>
          {tasks.map((task) => (
            <button
              key={task.id}
              className={`task-row ${selected === task.id ? 'selected' : ''}`}
              onClick={() => selectTask(task.id)}
            >
              <StatusBadge status={task.status} />
              <span className="goal">{task.goal}</span>
              <span className="muted tiny">{new Date(task.updatedAt).toLocaleTimeString()}</span>
            </button>
          ))}
          {tasks.length === 0 ? <p className="muted">No tasks yet. Create one with the CLI, SDK, MCP, or the API.</p> : null}
        </aside>

        <section className="detail">
          {!details ? (
            <div className="empty">
              <h2>Select a task</h2>
              <p className="muted">The console reads the same service state as the CLI, SDK and MCP adapter.</p>
              <pre>{`cua demo browser\n# or\ncua serve --open`}</pre>
            </div>
          ) : (
            <>
              <div className="detail-head">
                <div>
                  <div className="kicker">{details.task.id}</div>
                  <h2>{details.task.goal}</h2>
                  <div className="chip-row">
                    <StatusBadge status={details.task.status} />
                    {details.task.statusReason ? <span className="muted">{details.task.statusReason}</span> : null}
                  </div>
                  {statusHelp[details.task.status] ? <p className="note">{statusHelp[details.task.status]}</p> : null}
                  {details.controller?.cancelRequested ? <p className="note warn">Cancel requested. An in-flight action may still be running; cancellation is not rollback.</p> : null}
                </div>
                <div className="controls">
                  <button onClick={() => control('pause')} disabled={busy}>Pause</button>
                  <button onClick={() => control('resume')} disabled={busy}>Resume</button>
                  <button onClick={() => control('takeover')} disabled={busy}>Take over</button>
                  <button onClick={() => control('release')} disabled={busy}>Release</button>
                  <button onClick={() => control('recover')} disabled={busy}>Recover</button>
                  <button className="danger" onClick={() => control('cancel')} disabled={busy}>Cancel</button>
                </div>
              </div>

              {awaiting ? (
                <div className="card approval">
                  <div className="panel-title">{awaiting.kind === 'approval' ? 'Approval required' : 'Input required'}</div>
                  <p>{awaiting.question}</p>
                  <div className="row">
                    <input value={inputText} onChange={(e) => setInputText(e.target.value)} />
                    <button onClick={submitInput} disabled={busy}>Submit</button>
                  </div>
                </div>
              ) : null}

              <div className="grid">
                <div className="card">
                  <div className="panel-title">Current observation</div>
                  <ArtifactImage artifactId={screenshotId} />
                  {details.latestObservation ? (
                    <div className="obs-meta">
                      <span>{details.latestObservation.interface?.url ?? details.latestObservation.interface?.appName ?? 'surface'}</span>
                      <span>gen {details.latestObservation.generation}</span>
                      <span>{details.latestObservation.targets?.length ?? 0} targets</span>
                      <span>{details.latestObservation.coverage?.coverageNotes?.length ?? 0} coverage notes</span>
                    </div>
                  ) : null}
                  {details.latestObservation?.visibleText ? (
                    <pre className="text">{details.latestObservation.visibleText.slice(0, 4000)}</pre>
                  ) : null}
                </div>
                <div className="card">
                  <div className="panel-title">Acceptance (user-owned)</div>
                  <pre className="json">{JSON.stringify(details.task.acceptance, null, 2)}</pre>
                  <div className="panel-title">Environment</div>
                  <pre className="json">{JSON.stringify(details.task.environment, null, 2)}</pre>
                </div>
              </div>

              <div className="grid">
                <div className="card">
                  <div className="panel-title">Actions ({details.actions.length})</div>
                  {details.actions.slice().reverse().map((action) => (
                    <div className="action" key={action.id}>
                      <div>
                        <strong>{action.proposal.action.tool}</strong>
                        <span className={`badge ${action.result?.status ?? 'running'}`}>{action.result?.status ?? action.status}</span>
                      </div>
                      {action.result?.error ? <div className="error tiny">{action.result.error.code}: {action.result.error.message}</div> : null}
                      {action.result?.actual?.verificationVerdict ? <div className="muted tiny">postcondition: {action.result.actual.verificationVerdict}</div> : null}
                      {action.result?.sideEffectUnknown ? <div className="warn tiny">side effect unknown — no automatic retry</div> : null}
                    </div>
                  ))}
                  {details.actions.length === 0 ? <p className="muted">No actions yet.</p> : null}
                </div>
                <div className="card">
                  <div className="panel-title">Verification</div>
                  {details.verifications.slice().reverse().map((verification) => (
                    <div className="verification" key={verification.id}>
                      <span className={`badge ${verification.verdict}`}>{verification.verdict}</span>
                      <span className="tiny">{verification.scope}</span>
                      {verification.details.map((d: any, i: number) => <div className="muted tiny" key={i}>{d.detail}</div>)}
                    </div>
                  ))}
                  {details.verifications.length === 0 ? <p className="muted">No verification yet.</p> : null}
                </div>
              </div>

              <div className="card">
                <div className="panel-title">Live event log <span className="muted tiny">seq {lastSeq.current}</span></div>
                <div className="events">
                  {events.slice().reverse().map((event) => (
                    <div className="event" key={event.seq}>
                      <span className="seq">{event.seq}</span>
                      <span className="type">{event.type}</span>
                      <span className="muted tiny">{new Date(event.at).toLocaleTimeString()}</span>
                      <span className="payload">{JSON.stringify(event.payload).slice(0, 260)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
