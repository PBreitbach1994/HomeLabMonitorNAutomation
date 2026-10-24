import { useId } from 'react';

/** Tiny trend line for tiles and rows. Not interactive — the number beside it carries the value. */
export function Sparkline({
  values,
  color = '#60a5fa',
  width = 120,
  height = 32,
  fill = true,
  max: maxIn,
  strokeWidth = 1.5,
  responsive = false,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  fill?: boolean;
  max?: number;
  strokeWidth?: number;
  /** Stretch to the container's width (stroke width stays constant). */
  responsive?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />;
  const max = maxIn ?? Math.max(...values, 1e-9);
  const min = 0;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 2 - ((Math.min(v, max) - min) / (max - min || 1)) * (height - 4)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  return (
    <svg
      width={responsive ? '100%' : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={responsive ? 'none' : undefined}
      aria-hidden
      style={{ display: 'block' }}
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={`sg${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.28" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${d}L${width},${height}L0,${height}Z`} fill={`url(#sg${id})`} />
        </>
      )}
      <path d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
