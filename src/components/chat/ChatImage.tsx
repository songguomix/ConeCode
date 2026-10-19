import { useState } from 'react';
import { isSafeImageUrl } from '../../core/markdown/markdown';

export default function ChatImage({ src, alt = '' }: { src: string; alt?: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (!isSafeImageUrl(src) || failedSource === src) {
    return <span role="img" aria-label={alt || 'ConeCode: image unavailable'} className="inline-block rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">{alt || 'ConeCode: image unavailable'}</span>;
  }
  return <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedSource(src)} className="my-2 inline-block max-h-[480px] max-w-full rounded-xl object-contain align-middle" />;
}

export function MessageImages({ images }: { images?: string[] }) {
  if (!images?.length) return null;
  return <div className="flex max-w-full flex-wrap gap-2">{images.map((src, index) => <ChatImage key={index} src={src} />)}</div>;
}
