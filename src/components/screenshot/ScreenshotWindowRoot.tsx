import { useEffect, useState } from 'react';
import { FiX } from 'react-icons/fi';
import { useLanguageStore } from '../../stores';
import { useScreenshotStore } from '../../stores/screenshot.store';
import ScreenshotOverlay from './ScreenshotOverlay';

/**
 * Root for the WeChat-style fullscreen overlay window (URL hash #screenshot).
 * Transparent background (the real screen shows through), pulls the pixels
 * main grabbed after hiding the app, and reports back via IPC:
 * confirm → screenshot:finish (main reshows + drops it into the chat),
 * cancel  → screenshot:cancel (main just reshows).
 */
export default function ScreenshotWindowRoot() {
  const image = useScreenshotStore((s) => s.image);
  const openWithImage = useScreenshotStore((s) => s.openWithImage);
  const { t } = useLanguageStore();
  const [failed, setFailed] = useState<null | 'permission' | 'failed'>(null);

  useEffect(() => {
    // index.css paints the body opaque — punch through so the desktop shows.
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.background;
    const prevBody = body.style.background;
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    (async () => {
      try {
        const res = await (window as any).electronAPI?.screenshot?.getImage?.();
        if (!res || 'error' in res) {
          setFailed(res?.needsPermission ? 'permission' : 'failed');
          return;
        }
        openWithImage(res);
      } catch {
        setFailed('failed');
      }
    })();
    return () => {
      html.style.background = prevHtml;
      body.style.background = prevBody;
    };
  }, [openWithImage]);

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
      onClose={() => void (window as any).electronAPI?.screenshot?.cancel?.()}
      onConfirm={(url) => void (window as any).electronAPI?.screenshot?.finish?.(url)}
    />
  );
}
