import iconUrl from '../../assets/app-icon.png';

/**
 * The application's own icon. Bundled as an asset (not an inline SVG) so the
 * product mark stays in one place — swap src/assets/app-icon.png and every
 * appearance follows.
 */
export default function AppIcon({ size = 40, className = '' }: { size?: number; className?: string }) {
  return (
    <img
      src={iconUrl}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={`shrink-0 select-none ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
