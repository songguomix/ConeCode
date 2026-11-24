import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, WheelEvent } from 'react';
import { FiArrowUpRight, FiMousePointer, FiMove, FiRefreshCw, FiType } from 'react-icons/fi';
import { MAX_TYPE_LENGTH, type DisplayGeometry } from '../../core/computer/computer';
import type { ComputerPreviewAPI, ComputerPreviewInput, ComputerPreviewUpdate } from '../../core/computer/preview';
import { useLanguageStore } from '../../stores/language.store';
import './computer-preview.css';

/** A delayed initial pull must not replace a newer push or restore a stopped screen. */
export function newerPreviewState(current: ComputerPreviewUpdate | null, next: ComputerPreviewUpdate): ComputerPreviewUpdate | null {
  if (!next || !Number.isSafeInteger(next.revision) || next.revision < 0) return current;
  const [latest, other] = current && next.revision <= current.revision ? [current, next] : [next, current];
  const shot = latest.shot;
  const previous = other?.shot;
  // A compact push can arrive before getState resolves. Accept its matching
  // pixels without taking any of the older status or pointer information.
  if (latest.status.enabled && shot && !shot.dataUrl && previous?.dataUrl && shot.frameId === previous.frameId
    && shot.capturedAt === previous.capturedAt && shot.target.id === previous.target.id
    && latest.status.targetRevision === other?.status.targetRevision) {
    return { ...latest, shot: { ...shot, dataUrl: previous.dataUrl } };
  }
  return latest;
}

export function pointInPreviewImage(
  clientX: number, clientY: number, bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, geometry: DisplayGeometry,
): [number, number] | null {
  const x = clientX - bounds.left;
  const y = clientY - bounds.top;
  if (!(x >= 0 && x < bounds.width && y >= 0 && y < bounds.height)) return null;
  return [Math.floor(x / bounds.width * geometry.captureWidth), Math.floor(y / bounds.height * geometry.captureHeight)];
}

const CLICK_ACTIONS = new Set(['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click']);

interface SurfaceProps {
  snapshot: ComputerPreviewUpdate | null;
  waiting: string;
  unavailable: string;
  failed?: boolean;
  controls?: Pick<ComputerPreviewAPI, 'act' | 'refresh'>;
}

export function ComputerPreviewSurface(props: SurfaceProps) {
  const status = props.snapshot?.status;
  return <PreviewTarget key={`${status?.enabled}:${status?.targetRevision}`} {...props} />;
}

function PreviewTarget({ snapshot, waiting, unavailable, failed, controls }: SurfaceProps) {
  const { t } = useLanguageStore();
  const [failedFrame, setFailedFrame] = useState<string>();
  const [manual, setManual] = useState(false);
  const [showText, setShowText] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const pending = useRef(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const status = snapshot?.status;
  const target = status?.enabled ? status.target : null;
  const shot = snapshot?.shot?.frameId === status?.frameId && snapshot?.shot?.target.id === target?.id ? snapshot?.shot : null;
  const image = shot?.dataUrl;
  const geometry = shot?.geometry;
  const ready = !!shot && !!image && /^data:image\/(?:png|jpe?g|webp);base64,/.test(image) && failedFrame !== shot.frameId
    && !!geometry && Number.isFinite(geometry.captureWidth) && Number.isFinite(geometry.captureHeight)
    && geometry.captureWidth > 0 && geometry.captureHeight > 0;
  const interactive = !!controls && manual && ready && status?.accessibility;
  const busy = working || (snapshot?.inFlight ?? 0) > 0;
  const pointer = snapshot?.pointer;
  const showPointer = ready && pointer && pointer.frameId === shot.frameId;

  async function perform(operation: () => Promise<{ ok: boolean; message: string; warning?: string }>) {
    if (pending.current || busy) return false;
    pending.current = true;
    setWorking(true);
    setError(undefined);
    try {
      const result = await operation();
      if (!result.ok) setError(result.message || t('computerPreviewActionFailed'));
      else if (result.warning) setError(result.warning);
      return result.ok;
    } catch {
      setError(t('computerPreviewActionFailed'));
      return false;
    } finally {
      pending.current = false;
      setWorking(false);
    }
  }

  const send = (input: ComputerPreviewInput) => controls && perform(() => controls.act(input));
  const imageLoaded = () => !!imageRef.current?.complete && !!imageRef.current.naturalWidth && imageRef.current.currentSrc === image;
  const interact = (event: MouseEvent<HTMLDivElement>, action: 'left_click' | 'right_click') => {
    if (!interactive || !geometry || !imageLoaded() || (action === 'right_click' && status?.platform !== 'win32')) return;
    event.preventDefault();
    const coordinate = pointInPreviewImage(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), geometry);
    if (coordinate) void send({ frameId: shot.frameId, action, coordinate });
  };
  const scroll = (event: WheelEvent<HTMLDivElement>) => {
    if (!interactive || status?.platform !== 'win32' || !geometry || !imageLoaded() || event.ctrlKey) return;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const delta = horizontal ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    const coordinate = pointInPreviewImage(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), geometry);
    if (coordinate) void send({
      frameId: shot.frameId, action: 'scroll', coordinate,
      scroll_direction: horizontal ? (delta > 0 ? 'right' : 'left') : (delta > 0 ? 'down' : 'up'),
      scroll_amount: Math.max(1, Math.min(6, Math.round(Math.abs(delta) / (event.deltaMode === 0 ? 100 : 3)))),
    });
  };

  const closeManual = () => {
    setManual(false);
    setShowText(false);
    setDraft('');
    setError(undefined);
  };

  return (
    <div className="computer-preview-surface" data-testid="computer-preview-window" data-manual={manual || undefined} onKeyDown={(event) => {
      if (manual && event.key === 'Escape') closeManual();
    }}>
      <div className="computer-preview-stage">
        {ready ? (
          <div className="computer-preview-image" data-interactive={interactive || undefined} aria-busy={manual && busy || undefined}
            style={{ '--computer-preview-ratio': geometry.captureWidth / geometry.captureHeight } as CSSProperties}
            onClick={(event) => interact(event, 'left_click')} onContextMenu={(event) => interact(event, 'right_click')}
            onWheel={scroll}>
            <img ref={imageRef} src={image} alt={shot.target.name} draggable={false} onError={() => setFailedFrame(shot.frameId)} />
            {showPointer && (
              <span className="computer-preview-pointer" aria-hidden="true" data-phase={pointer.phase} data-source={pointer.source ?? 'agent'}
                style={{ left: `${pointer.coordinate[0] / geometry.captureWidth * 100}%`, top: `${pointer.coordinate[1] / geometry.captureHeight * 100}%` }}>
                {pointer.phase === 'sent' && CLICK_ACTIONS.has(pointer.action) && <span key={pointer.id} className="computer-preview-pulse" />}
                <FiMousePointer className="computer-preview-arrow" size={24} />
              </span>
            )}
          </div>
        ) : (
          <span className="computer-preview-placeholder" role="status">{failed ? unavailable : waiting}</span>
        )}
      </div>
      {controls && status && target && (
        <div className="computer-preview-toolbar">
          <span className="computer-preview-drag" title={t('computerPreviewMove')}><FiMove aria-hidden="true" size={14} /></span>
          <button type="button" title={t('computerPreviewControl')} aria-pressed={manual} data-testid="computer-preview-control"
            disabled={!manual && (!ready || !status?.accessibility)} onClick={() => manual ? closeManual() : setManual(true)}>
            <FiMousePointer aria-hidden="true" size={14} /><span>{t('computerPreviewControl')}</span>
          </button>
          {manual && (
            <button type="button" title={t('computerPreviewText')} aria-label={t('computerPreviewText')} aria-pressed={showText}
              disabled={!interactive || busy} onClick={() => setShowText(!showText)}>
              <FiType aria-hidden="true" size={14} />
            </button>
          )}
          <button type="button" title={t('computerPreviewRefresh')} aria-label={t('computerPreviewRefresh')} data-testid="computer-preview-refresh"
            disabled={busy} onClick={() => void perform(() => controls.refresh(status.targetRevision))}>
            <FiRefreshCw aria-hidden="true" size={14} />
          </button>
        </div>
      )}
      {manual && showText && (
        <form className="computer-preview-text" onSubmit={(event) => {
          event.preventDefault();
          if (!interactive || !shot || !draft || !imageLoaded()) return;
          void send({ frameId: shot.frameId, action: 'type', text: draft })?.then((sent) => {
            if (sent) { setDraft(''); setShowText(false); }
          });
        }}>
          <input autoFocus aria-label={t('computerPreviewText')} placeholder={t('computerPreviewText')} maxLength={MAX_TYPE_LENGTH}
            value={draft} onChange={(event) => setDraft(event.target.value)} />
          <button type="submit" aria-label={t('computerPreviewSend')} title={t('computerPreviewSend')} disabled={busy || !interactive || !draft}>
            <FiArrowUpRight aria-hidden="true" size={16} />
          </button>
        </form>
      )}
      {error && <div className="computer-preview-error" role="status" title={error}>{error}</div>}
    </div>
  );
}

/** Isolated preview root, backed by the selected window's frame and input bridge. */
export default function ComputerPreviewWindow() {
  const { t, locale } = useLanguageStore();
  const [snapshot, setSnapshot] = useState<ComputerPreviewUpdate | null>(null);
  const [failed, setFailed] = useState(false);
  const apply = useCallback((next: ComputerPreviewUpdate) => {
    setSnapshot((previous) => newerPreviewState(previous, next));
    setFailed(false);
  }, []);

  useEffect(() => {
    const appearance = snapshot?.appearance;
    if (appearance && appearance.locale !== useLanguageStore.getState().locale) useLanguageStore.getState().setLocale(appearance.locale);
  }, [snapshot?.appearance?.locale]);
  const target = snapshot?.status.target;
  useEffect(() => { document.title = `ConeCode · ${t('computerPreviewTitle')}${target ? ` · ${target.name}` : ''}`; }, [locale, t, target]);

  useEffect(() => {
    const api = window.computerPreviewAPI;
    if (!api) { setFailed(true); return; }
    let disposed = false;
    const receive = (next: ComputerPreviewUpdate) => { if (!disposed) apply(next); };
    const unsubscribe = api.onState(receive);
    void api.getState().then(receive).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; unsubscribe(); };
  }, [apply]);

  return <ComputerPreviewSurface snapshot={snapshot} waiting={t('computerPreviewWaiting')} unavailable={t('computerPreviewUnavailable')}
    failed={failed} controls={window.computerPreviewAPI} />;
}
