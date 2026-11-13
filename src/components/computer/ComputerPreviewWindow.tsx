import { useCallback, useEffect, useState } from 'react';
import type { ComputerPreviewSnapshot } from '../../core/computer/preview';
import { useLanguageStore } from '../../stores/language.store';
import './computer-preview.css';

/** A delayed initial pull must not replace a newer push or restore a stopped screen. */
export function newerPreviewState(current: ComputerPreviewSnapshot | null, next: ComputerPreviewSnapshot): ComputerPreviewSnapshot | null {
  if (!next || !Number.isSafeInteger(next.revision) || next.revision < 0) return current;
  return current && next.revision <= current.revision ? current : next;
}

export function ComputerPreviewSurface({ snapshot, waiting, unavailable, failed }: {
  snapshot: ComputerPreviewSnapshot | null;
  waiting: string;
  unavailable: string;
  failed?: boolean;
}) {
  const [failedShot, setFailedShot] = useState<string>();
  const shot = snapshot?.shot;
  const image = snapshot?.status.enabled && shot?.frameId === snapshot.status.frameId ? shot?.dataUrl : undefined;
  const ready = !!image && /^data:image\/(?:png|jpe?g|webp);base64,/.test(image) && failedShot !== image;
  return (
    <div className="computer-preview-surface" data-testid="computer-preview-window">
      {ready ? (
        <img src={image} alt={shot!.target.name} draggable={false} onError={() => setFailedShot(image)} />
      ) : (
        <span className="computer-preview-placeholder" role="status">{failed ? unavailable : waiting}</span>
      )}
    </div>
  );
}

/** Display-only root: no controls, embedded application, or main-app bootstrap. */
export default function ComputerPreviewWindow() {
  const { t, locale } = useLanguageStore();
  const [snapshot, setSnapshot] = useState<ComputerPreviewSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const apply = useCallback((next: ComputerPreviewSnapshot) => {
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
    const receive = (next: ComputerPreviewSnapshot) => { if (!disposed) apply(next); };
    const unsubscribe = api.onState(receive);
    void api.getState().then(receive).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; unsubscribe(); };
  }, [apply]);

  return <ComputerPreviewSurface snapshot={snapshot} waiting={t('computerPreviewWaiting')} unavailable={t('computerPreviewUnavailable')} failed={failed} />;
}
