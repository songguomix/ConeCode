import iconUrl from '../../assets/app-icon.png';

/**
 * ConeCode's original application icon.
 */
export default function AppIcon({
  size = 40,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  const hasDimensionClass = className.includes('w-') || className.includes('h-');
  return (
    <img
      src={iconUrl}
      width={size}
      height={size}
      alt="ConeCode"
      draggable={false}
      className={`shrink-0 select-none object-cover ${className}`}
      style={hasDimensionClass ? undefined : { width: size, height: size }}
    />
  );
}
