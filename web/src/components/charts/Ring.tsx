import { STATUS } from '../../lib/colors.ts';

/** CPU-style ring meter: the arc carries severity, the number sits inside. */
export function Ring({ value, size = 44, label }: { value: number | null; size?: number; label?: string }) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const color = v >= 90 ? STATUS.critical : v >= 70 ? STATUS.warning : '#60a5fa';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? `CPU ${value == null ? 'unknown' : `${Math.round(v)}%`}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#24304a" strokeWidth={3.5} />
      {value != null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={3.5}
          strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      <text x="50%" y="50%" dy="0.36em" textAnchor="middle" fill="#e8edf5" fontSize={size * 0.32} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {value == null ? '—' : Math.round(v)}
      </text>
    </svg>
  );
}
