import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FiDownload, FiCopy, FiMaximize2, FiX, FiCheck } from 'react-icons/fi';
import SparklesIcon from '../common/SparklesIcon';
import { isSafeImageUrl } from '../../core/markdown/markdown';
import { saveImageToDisk, copyImageToClipboard } from '../../core/image/imageGen';
import { useImageGenStore } from '../../stores/imageGen.store';
import { useLanguageStore } from '../../stores/language.store';

export default function ChatImage({ src, alt = '' }: { src: string; alt?: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const openModal = useImageGenStore((s) => s.openModal);
  const { t } = useLanguageStore();

  useEffect(() => {
    if (!lightboxOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxOpen]);

  if (!isSafeImageUrl(src) || failedSource === src) {
    return (
      <span
        role="img"
        aria-label={alt || 'ConeCode: image unavailable'}
        className="inline-block rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]"
      >
        {alt || 'ConeCode: image unavailable'}
      </span>
    );
  }

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyImageToClipboard(src);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const cleanAlt = alt ? alt.slice(0, 20).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_') : 'image';
    const ok = await saveImageToDisk(src, `conecode-${cleanAlt}-${Date.now()}.png`);
    if (ok) {
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 1500);
    }
  };

  const handleRemix = (e: React.MouseEvent) => {
    e.stopPropagation();
    openModal(alt || '');
  };

  return (
    <>
      <div className="relative group inline-block my-2 max-w-full align-middle">
        <img
          src={src}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedSource(src)}
          onClick={() => setLightboxOpen(true)}
          className="max-h-[480px] max-w-full rounded-2xl object-contain border border-[var(--glass-border)] shadow-sm cursor-zoom-in group-hover:shadow-md transition-shadow"
        />

        {/* Hover action toolbar */}
        <div className="absolute top-2.5 right-2.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 backdrop-blur-md rounded-xl p-1 border border-white/10 shadow-lg">
          <button
            onClick={handleCopy}
            className="p-1.5 rounded-lg text-white hover:bg-white/20 transition-colors cursor-pointer"
            title={t('copyArtwork')}
          >
            {copied ? <FiCheck size={13} className="text-emerald-400" /> : <FiCopy size={13} />}
          </button>
          <button
            onClick={handleDownload}
            className="p-1.5 rounded-lg text-white hover:bg-white/20 transition-colors cursor-pointer"
            title={t('saveArtwork')}
          >
            {downloaded ? <FiCheck size={13} className="text-emerald-400" /> : <FiDownload size={13} />}
          </button>
          {alt && (
            <button
              onClick={handleRemix}
              className="p-1.5 rounded-lg text-white hover:bg-white/20 transition-colors cursor-pointer"
              title={t('remixInStudio')}
            >
              <SparklesIcon size={13} className="text-amber-300" />
            </button>
          )}
          <button
            onClick={() => setLightboxOpen(true)}
            className="p-1.5 rounded-lg text-white hover:bg-white/20 transition-colors cursor-pointer"
            title={t('fullscreenView')}
          >
            <FiMaximize2 size={13} />
          </button>
        </div>
      </div>

      {/* Lightbox Modal — portalled to <body>. Message rows animate with a
          lingering transform (and blur), which would otherwise become the
          containing block for `fixed` and clip/offset the zoomed image. */}
      {lightboxOpen && typeof document !== 'undefined' && createPortal(
        <div
          onClick={() => setLightboxOpen(false)}
          className="fixed inset-0 z-60 bg-black/90 backdrop-blur-2xl flex items-center justify-center p-4 anim-scrim cursor-zoom-out"
        >
          <div className="absolute top-4 right-4 flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
              title={t('copyArtwork')}
            >
              {copied ? <FiCheck size={16} className="text-emerald-400" /> : <FiCopy size={16} />}
            </button>
            <button
              onClick={handleDownload}
              className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
              title={t('saveArtwork')}
            >
              {downloaded ? <FiCheck size={16} className="text-emerald-400" /> : <FiDownload size={16} />}
            </button>
            <button
              onClick={() => setLightboxOpen(false)}
              className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
              title={t('close')}
            >
              <FiX size={18} />
            </button>
          </div>
          <img
            src={src}
            alt={alt}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[92vh] max-w-[92vw] object-contain rounded-2xl shadow-2xl cursor-default"
          />
        </div>,
        document.body,
      )}
    </>
  );
}

export function MessageImages({ images }: { images?: string[] }) {
  if (!images?.length) return null;
  return (
    <div className="flex max-w-full flex-wrap gap-2">
      {images.map((src, index) => (
        <ChatImage key={index} src={src} />
      ))}
    </div>
  );
}
