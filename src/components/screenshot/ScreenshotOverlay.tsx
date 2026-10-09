import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FiSquare, FiCircle, FiArrowUpRight, FiEdit3, FiType,
  FiDownload, FiX, FiCheck,
} from 'react-icons/fi';
import { useLanguageStore, useWorkspaceStore } from '../../stores';
import { useScreenshotStore } from '../../stores/screenshot.store';

type Tool = 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text';

type Shape =
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'ellipse'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'arrow'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'pen'; pts: { x: number; y: number }[] }
  | { kind: 'text'; x: number; y: number; text: string };

interface Rect { x: number; y: number; w: number; h: number }

const MIN_SEL = 8;
const LW = 3;

function contain(nw: number, nh: number, bw: number, bh: number): Rect {
  const s = Math.min(bw / nw, bh / nh);
  const w = nw * s;
  const h = nh * s;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

function drawShape(ctx: CanvasRenderingContext2D, s: Shape, color: string): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = LW;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.kind === 'rect') {
    const x = Math.min(s.x0, s.x1);
    const y = Math.min(s.y0, s.y1);
    ctx.strokeRect(x, y, Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
  } else if (s.kind === 'ellipse') {
    const cx = (s.x0 + s.x1) / 2;
    const cy = (s.y0 + s.y1) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.abs(s.x1 - s.x0) / 2, Math.abs(s.y1 - s.y0) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.kind === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(s.x0, s.y0);
    ctx.lineTo(s.x1, s.y1);
    ctx.stroke();
    const angle = Math.atan2(s.y1 - s.y0, s.x1 - s.x0);
    const head = 14;
    for (const a of [angle - Math.PI / 7.5, angle + Math.PI / 7.5]) {
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x1 - head * Math.cos(a), s.y1 - head * Math.sin(a));
      ctx.stroke();
    }
  } else if (s.kind === 'pen') {
    if (s.pts.length === 1) {
      ctx.beginPath();
      ctx.arc(s.pts[0].x, s.pts[0].y, LW / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(s.pts[0].x, s.pts[0].y);
      for (const p of s.pts.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  } else {
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeText(s.text, s.x, s.y);
    ctx.fillStyle = color;
    ctx.fillText(s.text, s.x, s.y);
  }
}

function ToolBtn({ title, active, danger, success, onClick, children }: {
  title: string; active?: boolean; danger?: boolean; success?: boolean;
  onClick: () => void; children: React.ReactNode;
}) {
  // Always-on-dark (WeChat/QQ-style): the bar floats over arbitrary desktop
  // content, so theme-aware grays wash out — fixed white-on-black instead.
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all ${
        active
          ? 'bg-[var(--accent)] text-white shadow-md scale-105'
          : danger
            ? 'text-[#ff6b62] hover:bg-white/10'
            : success
              ? 'text-[#4ade80] hover:bg-white/10'
              : 'text-white/75 hover:bg-white/10 hover:text-white'
      }`}>
      {children}
    </button>
  );
}

/**
 * Full-screen screenshot: drag a region, annotate with 8 tools only
 * (rect / ellipse / arrow / pen / text / save / cancel / confirm), then
 * confirm to clipboard + chat, or save to disk.
 *
 * Props override the close/confirm targets: the fullscreen overlay window
 * reports back to main over IPC (main reshows + drops the shot into chat),
 * while the in-app instance (permission-error card) keeps store behavior.
 */
export default function ScreenshotOverlay({ onClose, onConfirm }: {
  onClose?: () => void;
  onConfirm?: (dataUrl: string) => void | Promise<void>;
} = {}) {
  const image = useScreenshotStore((s) => s.image);
  const captureError = useScreenshotStore((s) => s.error);
  const close = useScreenshotStore((s) => s.close);
  const handleClose = onClose ?? close;
  const addPastedImage = useWorkspaceStore((s) => s.addPastedImage);
  const { t } = useLanguageStore();

  const boxRef = useRef<HTMLDivElement>(null);
  const workRef = useRef<HTMLCanvasElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [phase, setPhase] = useState<'select' | 'annotate'>('select');
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [sel, setSel] = useState<Rect | null>(null);
  const [tool, setTool] = useState<Tool>('rect');
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null);
  const [textValue, setTextValue] = useState('');
  const [savedTick, setSavedTick] = useState(false);
  const [busy, setBusy] = useState(false);

  const color = useMemo(() => {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ef6c3d';
    } catch {
      return '#ef6c3d';
    }
  }, []);

  useEffect(() => {
    if (!image) return;
    const el = new Image();
    el.onload = () => setImg(el);
    el.src = image.dataUrl;
  }, [image]);

  useEffect(() => {
    const measure = () => {
      const el = boxRef.current;
      if (el) setBox({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !textAt) {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [handleClose, textAt]);

  useEffect(() => {
    if (textAt) textInputRef.current?.focus();
  }, [textAt]);

  const fit = img && box.w > 0 ? contain(img.naturalWidth, img.naturalHeight, box.w, box.h) : null;
  // Native px per display px (keeps the export sharp on retina).
  const scale = img && fit && fit.w > 0 ? img.naturalWidth / fit.w : 1;

  const clampToFit = useCallback((x: number, y: number): { x: number; y: number } => {
    if (!fit) return { x, y };
    return {
      x: Math.min(fit.x + fit.w, Math.max(fit.x, x)),
      y: Math.min(fit.y + fit.h, Math.max(fit.y, y)),
    };
  }, [fit]);

  const posInBox = (e: React.PointerEvent): { x: number; y: number } => {
    const r = boxRef.current!.getBoundingClientRect();
    return clampToFit(e.clientX - r.left, e.clientY - r.top);
  };

  // ---- region selection ----------------------------------------------------
  const onSelectDown = (e: React.PointerEvent) => {
    if (phase !== 'select' || !fit) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = posInBox(e);
    setAnchor(p);
    setSel({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onSelectMove = (e: React.PointerEvent) => {
    if (phase !== 'select' || !anchor || !fit) return;
    const p = posInBox(e);
    setSel({
      x: Math.min(anchor.x, p.x),
      y: Math.min(anchor.y, p.y),
      w: Math.abs(p.x - anchor.x),
      h: Math.abs(p.y - anchor.y),
    });
  };
  const onSelectUp = () => {
    if (phase !== 'select') return;
    setAnchor(null);
    if (sel && sel.w >= MIN_SEL && sel.h >= MIN_SEL) {
      setShapes([]);
      setDraft(null);
      setTool('rect');
      setPhase('annotate');
    } else {
      setSel(null);
    }
  };

  // ---- annotation ----------------------------------------------------------
  const local = (e: React.PointerEvent): { x: number; y: number } => {
    const r = workRef.current!.getBoundingClientRect();
    return {
      x: Math.min(sel!.w, Math.max(0, e.clientX - r.left)),
      y: Math.min(sel!.h, Math.max(0, e.clientY - r.top)),
    };
  };

  const onWorkDown = (e: React.PointerEvent) => {
    if (textAt || !sel) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = local(e);
    if (tool === 'text') {
      setTextAt(p);
      setTextValue('');
      return;
    }
    if (tool === 'pen') setDraft({ kind: 'pen', pts: [p] });
    else setDraft({ kind: tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onWorkMove = (e: React.PointerEvent) => {
    if (!draft || !sel) return;
    const p = local(e);
    if (draft.kind === 'pen') {
      setDraft({ kind: 'pen', pts: [...draft.pts, p] });
    } else if (draft.kind === 'text') {
      return;
    } else {
      setDraft({ kind: draft.kind, x0: draft.x0, y0: draft.y0, x1: p.x, y1: p.y });
    }
  };
  const onWorkUp = () => {
    if (!draft) return;
    const tiny =
      (draft.kind === 'pen' && draft.pts.length === 0) ||
      ((draft.kind === 'rect' || draft.kind === 'ellipse' || draft.kind === 'arrow') &&
        Math.abs(draft.x1 - draft.x0) < 3 && Math.abs(draft.y1 - draft.y0) < 3);
    if (!tiny) setShapes((s) => [...s, draft]);
    setDraft(null);
  };

  const commitText = () => {
    if (textAt && textValue.trim()) {
      setShapes((s) => [...s, { kind: 'text', x: textAt.x, y: textAt.y, text: textValue.trim() }]);
    }
    setTextAt(null);
    setTextValue('');
  };

  // Redraw the working canvas: cropped region + all shapes.
  useEffect(() => {
    const canvas = workRef.current;
    if (!canvas || !img || !sel || !fit) return;
    canvas.width = Math.max(1, Math.round(sel.w));
    canvas.height = Math.max(1, Math.round(sel.h));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const s = img.naturalWidth / fit.w;
    ctx.drawImage(
      img,
      (sel.x - fit.x) * s, (sel.y - fit.y) * s, sel.w * s, sel.h * s,
      0, 0, sel.w, sel.h,
    );
    for (const sh of shapes) drawShape(ctx, sh, color);
    if (draft) drawShape(ctx, draft, color);
  }, [img, sel, fit, shapes, draft, color]);

  const exportPNG = useCallback((): string | null => {
    if (!img || !sel || !fit) return null;
    const s = img.naturalWidth / fit.w;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sel.w * s));
    c.height = Math.max(1, Math.round(sel.h * s));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(
      img,
      (sel.x - fit.x) * s, (sel.y - fit.y) * s, sel.w * s, sel.h * s,
      0, 0, c.width, c.height,
    );
    ctx.scale(c.width / sel.w, c.height / sel.h);
    for (const sh of shapes) drawShape(ctx, sh, color);
    return c.toDataURL('image/png');
  }, [img, sel, fit, shapes, color]);

  const handleSave = async () => {
    if (busy) return;
    const url = exportPNG();
    if (!url) return;
    setBusy(true);
    try {
      const res = await (window as any).electronAPI?.screenshot?.save?.(url);
      if (res?.ok) {
        setSavedTick(true);
        setTimeout(() => setSavedTick(false), 1600);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (busy) return;
    const url = exportPNG();
    if (!url) return;
    // Overlay-window mode: hand the pixels to main (it reshows the app and
    // drops the shot into the chat there).
    if (onConfirm) {
      setBusy(true);
      try {
        await onConfirm(url);
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      try {
        const blob = await (await fetch(url)).blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      } catch {}
      addPastedImage(url, `screenshot-${Date.now()}.png`);
    } finally {
      setBusy(false);
      close();
    }
  };

  if (!image || !img || !fit) {
    // Capture failed (or still loading): say so instead of vanishing.
    if (captureError && !image) {
      const permission = captureError === 'permission';
      return (
        <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center" onClick={close}>
          <div
            className="px-4 py-3.5 rounded-2xl bg-[var(--bg-2)] border border-[var(--border)] shadow-2xl max-w-[400px] anim-menu"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5">
              <FiX size={15} className="text-[var(--error)] shrink-0" />
              <span className="text-[13px] text-[var(--text-secondary)]">
                {t(permission ? 'screenshotNoPermission' : 'screenshotFailed')}
              </span>
            </div>
            {permission && (
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => void (window as any).electronAPI?.screenshot?.openSettings?.()}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
                >
                  {t('screenshotOpenSettings')}
                </button>
                <button
                  onClick={() => void (window as any).electronAPI?.screenshot?.relaunch?.()}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--bg-3)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors"
                >
                  {t('screenshotRelaunch')}
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }
    return <div ref={boxRef} className="fixed inset-0 z-[100] bg-black/60 cursor-wait" onClick={close} />;
  }

  const selLabel = sel ? `${Math.round(sel.w * scale)} × ${Math.round(sel.h * scale)}` : '';

  return (
    <div ref={boxRef} className="fixed inset-0 z-[100] select-none">
      {/* Dimmed screen */}
      <img
        src={image.dataUrl}
        alt=""
        draggable={false}
        className="absolute"
        style={{ left: fit.x, top: fit.y, width: fit.w, height: fit.h, filter: 'brightness(0.45)' }}
      />
      {phase === 'select' ? (
        <div
          className="absolute inset-0 cursor-crosshair"
          onPointerDown={onSelectDown}
          onPointerMove={onSelectMove}
          onPointerUp={onSelectUp}
        >
          <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3.5 py-1.5 rounded-full bg-black/55 text-white/90 text-[12px] backdrop-blur pointer-events-none">
            {t('screenshotRegionHint')}
          </div>
          {sel && sel.w > 0 && sel.h > 0 && (
            <div
              className="absolute pointer-events-none"
              style={{
                left: sel.x, top: sel.y, width: sel.w, height: sel.h,
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
              }}
            >
              <img
                src={image.dataUrl}
                alt=""
                draggable={false}
                className="absolute"
                style={{
                  width: fit.w, height: fit.h,
                  left: fit.x - sel.x, top: fit.y - sel.y,
                  maxWidth: 'none',
                }}
              />
              <div className="absolute inset-0 border-2 rounded-[2px]" style={{ borderColor: color }} />
              <div className="absolute -top-7 left-0 px-2 py-0.5 rounded-md text-[12px] font-semibold text-white whitespace-nowrap"
                style={{ backgroundColor: color }}>
                {selLabel}
              </div>
            </div>
          )}
        </div>
      ) : (
        sel && (
          <>
            {/* Working canvas = the cropped region, full brightness */}
            <canvas
              ref={workRef}
              className={tool === 'text' ? 'absolute cursor-text' : 'absolute cursor-crosshair'}
              style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }}
              onPointerDown={onWorkDown}
              onPointerMove={onWorkMove}
              onPointerUp={onWorkUp}
            />
            <div className="absolute px-2 py-0.5 rounded-md text-[12px] font-semibold text-white whitespace-nowrap"
              style={{ left: sel.x, top: Math.max(4, sel.y - 30), backgroundColor: color }}>
              {selLabel}
            </div>
            {textAt && (
              <input
                ref={textInputRef}
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                onBlur={commitText}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitText();
                  if (e.key === 'Escape') { setTextAt(null); setTextValue(''); }
                }}
                placeholder={t('screenshotTextPlaceholder')}
                spellCheck={false}
                className="absolute z-10 px-2 py-1 rounded-lg bg-white text-black text-[14px] outline-none shadow-xl min-w-[140px]"
                style={{ left: sel.x + textAt.x, top: sel.y + textAt.y }}
              />
            )}
            {/* 8 tools only: rect ellipse arrow pen text | save | cancel confirm */}
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1.5 rounded-2xl bg-[#1e1e20]/95 backdrop-blur-xl border border-white/10 shadow-2xl anim-menu">
              <ToolBtn title={t('toolRect')} active={tool === 'rect'} onClick={() => setTool('rect')}>
                <FiSquare size={15} />
              </ToolBtn>
              <ToolBtn title={t('toolEllipse')} active={tool === 'ellipse'} onClick={() => setTool('ellipse')}>
                <FiCircle size={15} />
              </ToolBtn>
              <ToolBtn title={t('toolArrow')} active={tool === 'arrow'} onClick={() => setTool('arrow')}>
                <FiArrowUpRight size={16} />
              </ToolBtn>
              <ToolBtn title={t('toolPen')} active={tool === 'pen'} onClick={() => setTool('pen')}>
                <FiEdit3 size={15} />
              </ToolBtn>
              <ToolBtn title={t('toolText')} active={tool === 'text'} onClick={() => setTool('text')}>
                <FiType size={16} />
              </ToolBtn>
              <div className="w-px h-6 bg-white/15 mx-0.5" />
              <ToolBtn title={savedTick ? t('screenshotSaved') : t('screenshotSave')} onClick={handleSave}>
                {savedTick ? <FiCheck size={15} className="text-[var(--success)]" /> : <FiDownload size={15} />}
              </ToolBtn>
              <div className="w-px h-6 bg-white/15 mx-0.5" />
              <ToolBtn title={t('screenshotCancel')} danger onClick={handleClose}>
                <FiX size={16} />
              </ToolBtn>
              <ToolBtn title={t('screenshotConfirm')} success onClick={handleConfirm}>
                <FiCheck size={16} />
              </ToolBtn>
            </div>
          </>
        )
      )}
    </div>
  );
}
