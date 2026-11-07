import { useCallback, useEffect, useRef, useState } from 'react';
import { FiX } from 'react-icons/fi';
import { useLanguageStore } from '../../stores';
import { useScreenshotStore } from '../../stores/screenshot.store';
import ScreenshotOverlay from './ScreenshotOverlay';

type ShotPayload = {
  dataUrl: string;
  width: number;
  height: number;
  session?: number;
};

/**
 * Root for the WeChat-style fullscreen overlay window (URL hash #screenshot).
 * The window is pre-warmed at app launch and reused for every shot:
 * main pushes the freshly captured pixels over `screenshot:image`, this root
 * decodes them while still hidden, then reports `ready` so main can reveal the
 * overlay in a single compositor frame (no window creation or page-load wait).
 *
 * confirm → screenshot:finish (main reshows + drops it into the chat),
 * cancel  → screenshot:cancel (main just reshows).
 */
export default function ScreenshotWindowRoot() {
  const image = useScreenshotStore((s) => s.image);
  const openWithImage = useScreenshotStore((s) => s.openWithImage);
  const close = useScreenshotStore((s) => s.close);
  const { t } = useLanguageStore();
  const [generation, setGeneration] = useState(0);
  const [failed, setFailed] = useState<null | 'permission' | 'failed'>(null);
  const sessionRef = useRef(0);
  const appliedSessionRef = useRef<number | null>(null);

  useEffect(() => {
    // index.css paints the body opaque — punch through so the desktop shows.
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.background;
    const prevBody = body.style.background;
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    return () => {
      html.style.background = prevHtml;
      body.style.background = prevBody;
    };
  }, []);

  useEffect(() => {
    const api = (window as any).electronAPI?.screenshot;
    const apply = (payload: ShotPayload | null) => {
      if (!payload || typeof payload.dataUrl !== 'string') return;
      const session = Number(payload.session) || 0;
      // The push event and the cold-start pull can race; apply a session once.
      if (session > 0 && appliedSessionRef.current === session) return;
      appliedSessionRef.current = session;
      sessionRef.current = session;
      openWithImage({ dataUrl: payload.dataUrl, width: payload.width, height: payload.height });
      setFailed(null);
      setGeneration((g) => g + 1);
    };
    const offImage = api?.onImage?.(apply);
    const offReset = api?.onReset?.(() => {
      close();
      setFailed(null);
    });
    // Cold start: the image may have been pushed before this renderer mounted
    // (first shot before pre-warm finished). Pull it once as a safety net.
    void (async () => {
      try {
        const res = await api?.getImage?.();
        if (res && !('error' in res)) apply(res);
        else if (res?.needsPermission) setFailed('permission');
      } catch {
        /* main reports capture failures in the app window */
      }
    })();
    return () => {
      offImage?.();
      offReset?.();
    };
  }, [openWithImage, close]);

  const notifyReady = useCallback(() => {
    void (window as any).electronAPI?.screenshot?.ready?.(sessionRef.current);
  }, []);

  if (failed) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="px-4 py-3.5 rounded-2xl bg-[#1e1e20]/95 border border-white/10 shadow-2xl max-w-[400px]">
          <div className="flex items-center gap-2.5">
            <FiX size={15} className="text-[#ff6b62] shrink-0" />
            <span className="text-[13px] text-white/85">
              {t(failed === 'permission' ? 'screenshotNoPermission' : 'screenshotFailed')}
            </span>
          </div>
          <button
            onClick={() => void (window as any).electronAPI?.screenshot?.cancel?.()}
            className="mt-3 w-full px-3 py-1.5 rounded-lg bg-white/10 text-xs text-white/85 hover:bg-white/15 transition-colors"
          >
            {t('screenshotCancel')}
          </button>
        </div>
      </div>
    );
  }

  // Transparent wait — never paint an opaque flash over the user's screen.
  if (!image) return <div className="fixed inset-0 cursor-wait" />;

  return (
    <ScreenshotOverlay
      key={generation}
      onReady={notifyReady}
      onClose={() => void (window as any).electronAPI?.screenshot?.cancel?.()}
      onConfirm={(url) => void (window as any).electronAPI?.screenshot?.finish?.(url)}
    />
  );
}
