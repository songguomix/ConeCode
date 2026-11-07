import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FiSquare, FiCircle, FiArrowUpRight, FiEdit3, FiType,
  FiDownload, FiX, FiCheck, FiCornerUpLeft, FiCornerUpRight,
} from 'react-icons/fi';
import { useLanguageStore, useWorkspaceStore } from '../../stores';
import { useScreenshotStore } from '../../stores/screenshot.store';

type Tool = 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text';

type Shape =
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number; color: string }
  | { kind: 'ellipse'; x0: number; y0: number; x1: number; y1: number; color: string }
  | { kind: 'arrow'; x0: number; y0: number; x1: number; y1: number; color: string }
  | { kind: 'pen'; pts: { x: number; y: number }[]; color: string }
  | {
      kind: 'text'; x: number; y: number; text: string; color: string;
      fontSize: number; maxWidth: number;
    };

type BoxShape = Extract<Shape, { kind: 'rect' | 'ellipse' | 'arrow' }>;
type DraftShape = BoxShape | Extract<Shape, { kind: 'pen' }>;

interface Rect { x: number; y: number; w: number; h: number }
interface Point { x: number; y: number }
interface TextEdit {
  x: number; y: number; text: string; color: string;
  fontSize: number; maxWidth: number;
}

interface BarTheme {
  dark: boolean;
  background: string;
  base: string;
  border: string;
  fg: string;
  divider: string;
}

const MIN_SEL = 8;
const LW = 3;
const TEXT_SIZE = 16;
const TEXT_LINE_HEIGHT = 1.32;
const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';
const COLOR_KEY = 'conecode.screenshotColor';

// WeChat-style palette: readable on both bright and dark screenshots.
const BASE_COLORS = [
  '#ff3b30', '#ff9500', '#ffd60a', '#34c759',
  '#0a84ff', '#bf5af2', '#ffffff', '#111114',
];

const DARK_BAR: BarTheme = {
  dark: true,
  background: 'rgba(24, 24, 28, 0.94)',
  base: '#18181c',
  border: 'rgba(255, 255, 255, 0.14)',
  fg: 'rgba(255, 255, 255, 0.92)',
  divider: 'rgba(255, 255, 255, 0.16)',
};

function contain(nw: number, nh: number, bw: number, bh: number): Rect {
  const s = Math.min(bw / nw, bh / nh);
  const w = nw * s;
  const h = nh * s;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

function parseColor(value: string): { r: number; g: number; b: number } | null {
  const text = String(value || '').trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) {
    return {
      r: parseInt(short[1] + short[1], 16),
      g: parseInt(short[2] + short[2], 16),
      b: parseInt(short[3] + short[3], 16),
    };
  }
  const full = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (full) {
    return { r: parseInt(full[1], 16), g: parseInt(full[2], 16), b: parseInt(full[3], 16) };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(text);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  return null;
}

function luminance(r: number, g: number, b: number): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** White or near-black ink for a filled surface (labels, active tool). */
function readableInk(color: string): string {
  const rgb = parseColor(color);
  if (!rgb) return '#ffffff';
  return luminance(rgb.r, rgb.g, rgb.b) > 0.55 ? '#111114' : '#ffffff';
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s };
}

/**
 * Tint the floating bar with the average color behind it. The surface stays
 * high-contrast (dark or light) while its hue follows the desktop — so the
 * bar adapts to any wallpaper/app, not just black vs white.
 */
function barThemeFor(r: number, g: number, b: number, dark: boolean): BarTheme {
  const { h, s } = rgbToHsl(r, g, b);
  const hue = Math.round(h);
  const tint = Math.round(Math.min(dark ? 42 : 30, s * 100 * (dark ? 0.55 : 0.4)));
  const base = dark ? `hsl(${hue}, ${tint}%, 14%)` : `hsl(${hue}, ${tint}%, 96%)`;
  const background = dark
    ? `hsla(${hue}, ${tint}%, 14%, 0.96)`
    : `hsla(${hue}, ${tint}%, 96%, 0.97)`;
  return {
    dark,
    background,
    base,
    border: dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.10)',
    fg: dark ? 'rgba(255, 255, 255, 0.92)' : 'rgba(20, 18, 16, 0.90)',
    divider: dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.10)',
  };
}

/** Greedy wrap that works for CJK (character) and Latin (word-ish) text. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return text.split('\n');
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const ch of Array.from(paragraph)) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawShape(ctx: CanvasRenderingContext2D, s: Shape): void {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
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
  } else if (s.kind === 'text') {
    ctx.font = `500 ${s.fontSize}px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const lines = wrapText(ctx, s.text, s.maxWidth);
    const lineHeight = s.fontSize * TEXT_LINE_HEIGHT;
    lines.forEach((line, i) => ctx.fillText(line, s.x, s.y + i * lineHeight));
  }
}

function ToolBtn({ title, active, activeColor, danger, success, solid, disabled, theme, onClick, children }: {
  title: string;
  active?: boolean;
  activeColor?: string;
  danger?: boolean;
  success?: boolean;
  solid?: string;
  disabled?: boolean;
  theme: BarTheme;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const idleColor = danger
    ? (theme.dark ? '#ff6b62' : '#dc2626')
    : success
      ? (theme.dark ? '#4ade80' : '#16a34a')
      : theme.fg;
  const style: React.CSSProperties = {
    color: solid ? '#ffffff' : active ? readableInk(activeColor || '#C96442') : idleColor,
  };
  if (active || solid) {
    style.backgroundColor = solid || activeColor || '#C96442';
    style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.24)';
  }
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      style={style}
      className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-100 ${
        disabled
          ? 'opacity-30 cursor-default'
          : active || solid
            ? 'cursor-pointer scale-[1.02]'
            : `cursor-pointer ${theme.dark ? 'hover:bg-white/10' : 'hover:bg-black/10'}`
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Full-screen screenshot: drag a region, annotate with WeChat-style tools
 * (rectangle / ellipse / arrow / pen / text + colors + undo), then confirm to
 * clipboard + chat, or save to disk.
 *
 * Props override the close/confirm targets: the fullscreen overlay window
 * reports back to main over IPC (main reshows + drops the shot into chat),
 * while the in-app instance (permission-error card) keeps store behavior.
 */
export default function ScreenshotOverlay({ onClose, onConfirm, onReady }: {
  onClose?: () => void;
  onConfirm?: (dataUrl: string) => void | Promise<void>;
  /** Overlay window only: image is decoded and painted; main may show it. */
  onReady?: () => void;
} = {}) {
  const image = useScreenshotStore((s) => s.image);
  const captureError = useScreenshotStore((s) => s.error);
  const close = useScreenshotStore((s) => s.close);
  const handleClose = onClose ?? close;
  const addPastedImage = useWorkspaceStore((s) => s.addPastedImage);
  const { t } = useLanguageStore();

  const boxRef = useRef<HTMLDivElement>(null);
  const workRef = useRef<HTMLCanvasElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  const accentColor = useMemo(() => {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ef6c3d';
    } catch {
      return '#ef6c3d';
    }
  }, []);
  const [color, setColor] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(COLOR_KEY);
      if (saved && parseColor(saved)) return saved;
    } catch {}
    return accentColor;
  });
  const palette = useMemo(
    () => Array.from(new Set([accentColor, color, ...BASE_COLORS])),
    [accentColor, color],
  );

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [box, setBox] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 0,
    h: typeof window !== 'undefined' ? window.innerHeight : 0,
  }));
  const [phase, setPhase] = useState<'select' | 'annotate'>('select');
  const [anchor, setAnchor] = useState<Point | null>(null);
  const [sel, setSel] = useState<Rect | null>(null);
  const [tool, setTool] = useState<Tool>('rect');
  const [shapes, setShapes] = useState<Shape[]>([]);
  const shapesRef = useRef<Shape[]>([]);
  const [draft, setDraft] = useState<DraftShape | null>(null);
  const [redoCount, setRedoCount] = useState(0);
  const redoRef = useRef<Shape[]>([]);
  const [textDraft, setTextDraft] = useState<TextEdit | null>(null);
  const textDraftRef = useRef<TextEdit | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [busy, setBusy] = useState(false);
  // The floating bar adapts its dark/light surface + tint to the pixels behind it.
  const [barTheme, setBarTheme] = useState<BarTheme>(DARK_BAR);

  useEffect(() => {
    if (!image) return;
    let alive = true;
    const el = new Image();
    let raf1 = 0;
    let raf2 = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const notifyReady = () => {
      if (!alive || done) return;
      done = true;
      onReadyRef.current?.();
    };
    el.onload = () => {
      if (!alive) return;
      setImg(el);
      // Let React commit (and ideally paint) the captured image while the
      // window is still hidden, then let main reveal it in one frame.
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(notifyReady);
      });
      timer = setTimeout(notifyReady, 80);
    };
    el.src = image.dataUrl;
    return () => {
      alive = false;
      el.onload = null;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (timer) clearTimeout(timer);
    };
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

  const setShapesBoth = useCallback((next: Shape[]) => {
    shapesRef.current = next;
    setShapes(next);
  }, []);

  const updateTextDraft = useCallback((next: TextEdit | null) => {
    textDraftRef.current = next;
    setTextDraft(next);
  }, []);

  const cancelText = useCallback(() => {
    updateTextDraft(null);
  }, [updateTextDraft]);

  const pushShape = useCallback((shape: Shape) => {
    redoRef.current = [];
    setRedoCount(0);
    setShapesBoth([...shapesRef.current, shape]);
  }, [setShapesBoth]);

  const commitText = useCallback(() => {
    const current = textDraftRef.current;
    if (!current) return;
    updateTextDraft(null);
    const text = current.text.replace(/\s+$/, '');
    if (!text.trim()) return;
    pushShape({
      kind: 'text',
      x: current.x,
      y: current.y,
      text,
      color: current.color,
      fontSize: current.fontSize,
      maxWidth: current.maxWidth,
    });
  }, [pushShape, updateTextDraft]);

  const undo = useCallback(() => {
    const list = shapesRef.current;
    if (list.length === 0) return;
    const last = list[list.length - 1];
    redoRef.current = [...redoRef.current, last];
    setRedoCount(redoRef.current.length);
    setShapesBoth(list.slice(0, -1));
  }, [setShapesBoth]);

  const redo = useCallback(() => {
    const stack = redoRef.current;
    if (stack.length === 0) return;
    const next = stack[stack.length - 1];
    redoRef.current = stack.slice(0, -1);
    setRedoCount(redoRef.current.length);
    setShapesBoth([...shapesRef.current, next]);
  }, [setShapesBoth]);

  const selectColor = (value: string) => {
    setColor(value);
    setPaletteOpen(false);
    try { localStorage.setItem(COLOR_KEY, value); } catch {}
  };

  const selectTool = (next: Tool) => {
    commitText();
    setPaletteOpen(false);
    setTool(next);
  };

  const isFullscreen = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return (
      window.location.hash.includes('screenshot') ||
      onConfirm != null ||
      (box.w > 0 && Math.abs(box.w - window.innerWidth) <= 2)
    );
  }, [box.w, onConfirm]);

  const fit = useMemo(() => {
    if (!img || box.w <= 0 || box.h <= 0) return null;
    if (isFullscreen) {
      // In fullscreen overlay mode, cover the full display edge-to-edge without letterboxing
      return { x: 0, y: 0, w: box.w, h: box.h };
    }
    return contain(img.naturalWidth, img.naturalHeight, box.w, box.h);
  }, [img, box.w, box.h, isFullscreen]);

  // Native px per display px (keeps the export sharp on retina).
  const scaleX = img && fit && fit.w > 0 ? img.naturalWidth / fit.w : 1;
  const scaleY = img && fit && fit.h > 0 ? img.naturalHeight / fit.h : 1;

  // Multi-color adaptation: sample the pixels behind the bar, pick a
  // contrasting dark/light surface, then tint it with the backdrop's hue so
  // the toolbar fits any wallpaper, app or screenshot color. Layout effect so
  // the first painted frame already has the right theme (no dark flash).
  useLayoutEffect(() => {
    if (phase !== 'annotate' || !img || !fit) return;
    const bar = barRef.current;
    const boxEl = boxRef.current;
    if (!bar || !boxEl) return;
    try {
      const b = bar.getBoundingClientRect();
      const r = boxEl.getBoundingClientRect();
      const bx = b.left - r.left;
      const by = b.top - r.top;
      const ix = Math.max(bx, fit.x);
      const iy = Math.max(by, fit.y);
      const ix2 = Math.min(bx + b.width, fit.x + fit.w);
      const iy2 = Math.min(by + b.height, fit.y + fit.h);
      if (ix2 <= ix || iy2 <= iy || b.width <= 0 || b.height <= 0) {
        setBarTheme(DARK_BAR);
        return;
      }
      const sx = img.naturalWidth / fit.w;
      const sy = img.naturalHeight / fit.h;
      const c = document.createElement('canvas');
      const N = 28;
      c.width = N;
      c.height = N;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, (ix - fit.x) * sx, (iy - fit.y) * sy, (ix2 - ix) * sx, (iy2 - iy) * sy, 0, 0, N, N);
      const d = ctx.getImageData(0, 0, N, N).data;
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let lum = 0;
      let count = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r0 = d[i];
        const g0 = d[i + 1];
        const b0 = d[i + 2];
        rs += r0;
        gs += g0;
        bs += b0;
        lum += (0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0) / 255;
        count++;
      }
      if (!count) return;
      const dark = lum / count < 0.5;
      setBarTheme(barThemeFor(rs / count, gs / count, bs / count, dark));
    } catch {
      setBarTheme(DARK_BAR);
    }
    // fit is a fresh object every render — depend on its primitives instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, img, fit?.x, fit?.y, fit?.w, fit?.h, box.w, box.h]);

  const textOpen = textDraft !== null;
  useEffect(() => {
    if (!textOpen) return;
    const el = textAreaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [textOpen]);

  useEffect(() => {
    const el = textAreaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(20, el.scrollHeight)}px`;
  }, [textDraft?.text]);

  const clampToFit = useCallback((x: number, y: number): Point => {
    if (!fit) return { x, y };
    return {
      x: Math.min(fit.x + fit.w, Math.max(fit.x, x)),
      y: Math.min(fit.y + fit.h, Math.max(fit.y, y)),
    };
  }, [fit]);

  const posInBox = (e: React.PointerEvent): Point => {
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
      setShapesBoth([]);
      redoRef.current = [];
      setRedoCount(0);
      setDraft(null);
      cancelText();
      setTool('rect');
      setPhase('annotate');
    } else {
      setSel(null);
    }
  };

  // ---- annotation ----------------------------------------------------------
  const local = (e: React.PointerEvent): Point => {
    const r = workRef.current!.getBoundingClientRect();
    return {
      x: Math.min(sel!.w, Math.max(0, e.clientX - r.left)),
      y: Math.min(sel!.h, Math.max(0, e.clientY - r.top)),
    };
  };

  const startText = useCallback((p: Point) => {
    if (!sel) return;
    updateTextDraft({
      x: p.x,
      y: p.y,
      text: '',
      color,
      fontSize: TEXT_SIZE,
      maxWidth: Math.max(24, sel.w - p.x - 2),
    });
  }, [sel, color, updateTextDraft]);

  const onWorkDown = (e: React.PointerEvent) => {
    if (!sel) return;
    setPaletteOpen(false);
    if (tool === 'text') {
      // A click that ends the current text box must not immediately open a
      // fresh one under the same pointer (the old textarea's blur would then
      // commit the new, empty draft and remove it).
      if (textDraftRef.current) {
        commitText();
        return;
      }
      startText(local(e));
      return;
    }
    commitText();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = local(e);
    if (tool === 'pen') {
      setDraft({ kind: 'pen', pts: [p], color });
    } else {
      setDraft({ kind: tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y, color });
    }
  };
  const onWorkMove = (e: React.PointerEvent) => {
    if (!draft || !sel) return;
    const p = local(e);
    if (draft.kind === 'pen') {
      setDraft({ kind: 'pen', pts: [...draft.pts, p], color: draft.color });
    } else {
      setDraft({ ...draft, x1: p.x, y1: p.y });
    }
  };
  const onWorkUp = () => {
    if (!draft) return;
    const tiny =
      (draft.kind === 'pen' && draft.pts.length === 0) ||
      ((draft.kind === 'rect' || draft.kind === 'ellipse' || draft.kind === 'arrow') &&
        Math.abs(draft.x1 - draft.x0) < 3 && Math.abs(draft.y1 - draft.y0) < 3);
    if (!tiny) pushShape(draft);
    setDraft(null);
  };

  // Redraw the working canvas: cropped region + all shapes.
  useEffect(() => {
    const canvas = workRef.current;
    if (!canvas || !img || !sel || !fit) return;
    canvas.width = Math.max(1, Math.round(sel.w));
    canvas.height = Math.max(1, Math.round(sel.h));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const sx = img.naturalWidth / fit.w;
    const sy = img.naturalHeight / fit.h;
    ctx.drawImage(
      img,
      (sel.x - fit.x) * sx, (sel.y - fit.y) * sy, sel.w * sx, sel.h * sy,
      0, 0, sel.w, sel.h,
    );
    for (const shape of shapes) drawShape(ctx, shape);
    if (draft) drawShape(ctx, draft);
  }, [img, sel, fit, shapes, draft]);

  const exportPNG = useCallback((): string | null => {
    if (!img || !sel || !fit) return null;
    const sx = img.naturalWidth / fit.w;
    const sy = img.naturalHeight / fit.h;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sel.w * sx));
    c.height = Math.max(1, Math.round(sel.h * sy));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(
      img,
      (sel.x - fit.x) * sx, (sel.y - fit.y) * sy, sel.w * sx, sel.h * sy,
      0, 0, c.width, c.height,
    );
    ctx.scale(c.width / sel.w, c.height / sel.h);
    for (const shape of shapesRef.current) drawShape(ctx, shape);
    return c.toDataURL('image/png');
  }, [img, sel, fit]);

  const handleSave = async () => {
    if (busy) return;
    commitText();
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
    commitText();
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const inText = target instanceof HTMLTextAreaElement;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (textDraftRef.current) {
          e.stopPropagation();
          cancelText();
          return;
        }
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        handleClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !inText) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [handleClose, cancelText, paletteOpen, undo, redo, handleSave]);

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

  const selLabel = sel ? `${Math.round(sel.w * scaleX)} × ${Math.round(sel.h * scaleY)}` : '';
  const labelInk = readableInk(color);

  return (
    <div ref={boxRef} className="fixed inset-0 z-[100] select-none overflow-hidden">
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
              }}
            >
              <div className="absolute inset-0 overflow-hidden">
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
              </div>
              <div className="absolute inset-0 border-2 rounded-[2px]" style={{ borderColor: color }} />
              <div
                className="absolute px-2 py-0.5 rounded-md text-[12px] font-semibold whitespace-nowrap shadow-sm"
                style={{
                  backgroundColor: color,
                  color: labelInk,
                  left: 0,
                  top: sel.y > 28 ? -28 : 4,
                }}
              >
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
              className="absolute"
              style={{
                left: sel.x, top: sel.y, width: sel.w, height: sel.h,
                cursor: tool === 'text' ? 'text' : 'crosshair',
              }}
              onPointerDown={onWorkDown}
              onPointerMove={onWorkMove}
              onPointerUp={onWorkUp}
            />
            <div
              className="absolute pointer-events-none border-2 rounded-[2px]"
              style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h, borderColor: color }}
            />
            <div
              className="absolute pointer-events-none px-2 py-0.5 rounded-md text-[12px] font-semibold whitespace-nowrap shadow-sm"
              style={{
                left: sel.x,
                top: sel.y > 28 ? sel.y - 28 : Math.min(sel.y + sel.h + 6, box.h - 28),
                backgroundColor: color,
                color: labelInk,
              }}
            >
              {selLabel}
            </div>
            {textDraft && (
              <textarea
                ref={textAreaRef}
                value={textDraft.text}
                onChange={(e) => {
                  const current = textDraftRef.current;
                  if (current) updateTextDraft({ ...current, text: e.target.value });
                }}
                onBlur={commitText}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelText();
                  } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    commitText();
                  }
                }}
                rows={1}
                spellCheck={false}
                placeholder={t('screenshotTextPlaceholder')}
                className="absolute z-20 resize-none overflow-hidden bg-transparent p-0 m-0 border-0 shadow-none select-text placeholder:text-[#9a9a9a]"
                style={{
                  left: sel.x + textDraft.x,
                  top: sel.y + textDraft.y,
                  width: textDraft.maxWidth,
                  color: textDraft.color,
                  caretColor: textDraft.color,
                  fontSize: textDraft.fontSize,
                  lineHeight: TEXT_LINE_HEIGHT,
                  fontFamily: FONT_FAMILY,
                  fontWeight: 500,
                  wordBreak: 'break-all',
                  outline: '1px dashed rgba(127, 127, 127, 0.7)',
                  outlineOffset: 2,
                }}
              />
            )}
            {/* WeChat-style floating bar: tools | undo/redo/color | save | cancel/confirm */}
            <div
              ref={barRef}
              role="toolbar"
              className="absolute bottom-10 left-1/2 -translate-x-1/2 flex items-center gap-0.5 px-2 py-1.5 rounded-2xl backdrop-blur-xl border shadow-2xl anim-menu z-30"
              style={{ backgroundColor: barTheme.background, borderColor: barTheme.border }}
            >
              <ToolBtn title={t('toolRect')} theme={barTheme} active={tool === 'rect'} activeColor={color} onClick={() => selectTool('rect')}>
                <FiSquare size={15} />
              </ToolBtn>
              <ToolBtn title={t('toolEllipse')} theme={barTheme} active={tool === 'ellipse'} activeColor={color} onClick={() => selectTool('ellipse')}>
                <FiCircle size={15} />
              </ToolBtn>
              <ToolBtn title={t('toolArrow')} theme={barTheme} active={tool === 'arrow'} activeColor={color} onClick={() => selectTool('arrow')}>
                <FiArrowUpRight size={16} />
              </ToolBtn>
              <ToolBtn title={t('toolPen')} theme={barTheme} active={tool === 'pen'} activeColor={color} onClick={() => selectTool('pen')}>
                <FiEdit3 size={15} />
              </ToolBtn>
              <ToolBtn title={t('toolText')} theme={barTheme} active={tool === 'text'} activeColor={color} onClick={() => selectTool('text')}>
                <FiType size={16} />
              </ToolBtn>
              <div className="w-px h-6 mx-0.5" style={{ backgroundColor: barTheme.divider }} />
              <ToolBtn title={t('screenshotUndo')} theme={barTheme} disabled={shapes.length === 0} onClick={() => { commitText(); undo(); }}>
                <FiCornerUpLeft size={15} />
              </ToolBtn>
              <ToolBtn title={t('screenshotRedo')} theme={barTheme} disabled={redoCount === 0} onClick={() => { commitText(); redo(); }}>
                <FiCornerUpRight size={15} />
              </ToolBtn>
              <div className="relative">
                <button
                  title={t('screenshotColor')}
                  aria-label={t('screenshotColor')}
                  onClick={() => { commitText(); setPaletteOpen((open) => !open); }}
                  className={`w-9 h-9 rounded-xl flex items-center justify-center cursor-pointer transition-colors ${
                    barTheme.dark ? 'hover:bg-white/10' : 'hover:bg-black/10'
                  }`}
                >
                  <span
                    className="w-4 h-4 rounded-full"
                    style={{
                      backgroundColor: color,
                      boxShadow: color.toLowerCase() === '#ffffff'
                        ? '0 0 0 1px rgba(0,0,0,0.28)'
                        : '0 0 0 1.5px rgba(255,255,255,0.55)',
                    }}
                  />
                </button>
                {paletteOpen && (
                  <div
                    className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 p-2 rounded-2xl border shadow-2xl backdrop-blur-xl"
                    style={{ backgroundColor: barTheme.base, borderColor: barTheme.border }}
                  >
                    <div className="grid grid-cols-5 gap-1.5">
                      {palette.map((item) => (
                        <button
                          key={item}
                          title={item}
                          aria-label={item}
                          onClick={() => selectColor(item)}
                          className="w-6 h-6 rounded-full cursor-pointer transition-transform hover:scale-110"
                          style={{
                            backgroundColor: item,
                            boxShadow: item === color
                              ? `0 0 0 2px ${barTheme.base}, 0 0 0 4px ${item}`
                              : '0 0 0 1px rgba(127,127,127,0.35)',
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="w-px h-6 mx-0.5" style={{ backgroundColor: barTheme.divider }} />
              <ToolBtn title={savedTick ? t('screenshotSaved') : t('screenshotSave')} theme={barTheme} onClick={() => void handleSave()}>
                {savedTick ? <FiCheck size={15} className={barTheme.dark ? 'text-[#4ade80]' : 'text-green-600'} /> : <FiDownload size={15} />}
              </ToolBtn>
              <div className="w-px h-6 mx-0.5" style={{ backgroundColor: barTheme.divider }} />
              <ToolBtn title={t('screenshotCancel')} theme={barTheme} danger onClick={() => { cancelText(); handleClose(); }}>
                <FiX size={16} />
              </ToolBtn>
              <ToolBtn title={t('screenshotConfirm')} theme={barTheme} solid="#22c55e" onClick={() => void handleConfirm()}>
                <FiCheck size={16} />
              </ToolBtn>
            </div>
          </>
        )
      )}
    </div>
  );
}
