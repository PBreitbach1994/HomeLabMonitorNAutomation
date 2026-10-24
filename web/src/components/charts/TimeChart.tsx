import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { fmtAxisBps, fmtBps, niceTicks } from '../../lib/format.ts';

export interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
}

/**
 * Time series over the last hour (or whatever `stepMs × points` spans). Lines with a light wash,
 * or a stacked area. A crosshair snaps to the nearest sample and lists every series.
 */
export function TimeChart({
  series,
  stepMs,
  height = 180,
  stacked = false,
  format = fmtBps,
  axisFormat = fmtAxisBps,
}: {
  series: Series[];
  stepMs: number;
  height?: number;
  stacked?: boolean;
  format?: (v: number) => string;
  axisFormat?: (v: number) => string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = Math.max(0, ...series.map((s) => s.values.length));
  const padL = 40, padR = 8, padT = 8, padB = 22;
  const iw = width - padL - padR;
  const ih = height - padT - padB;
  const val = (s: Series, i: number) => s.values[i - (n - s.values.length)] ?? null;

  // Stack bottom → top in the given order.
  const tops: number[][] = [];
  const bases: number[][] = [];
  let max = 0;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    series.forEach((s, si) => {
      const v = val(s, i) ?? 0;
      (bases[si] ??= [])[i] = stacked ? acc : 0;
      acc = stacked ? acc + v : v;
      (tops[si] ??= [])[i] = acc;
      max = Math.max(max, acc);
    });
  }
  const ticks = niceTicks(max * 1.05 || 1, 3);
  const yMax = ticks[ticks.length - 1] || 1;
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = (v: number) => padT + ih - (v / yMax) * ih;

  const linePath = (arr: number[]) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const areaPath = (top: number[], base: number[]) =>
    `${linePath(top)}L${x(n - 1).toFixed(1)},${y(base[n - 1]).toFixed(1)}${base
      .map((_, j) => {
        const i = n - 1 - j;
        return `L${x(i).toFixed(1)},${y(base[i]).toFixed(1)}`;
      })
      .join('')}Z`;

  const spanMin = Math.round(((n - 1) * stepMs) / 60000);
  const xTicks = spanMin >= 40 ? [60, 45, 30, 15, 0].filter((m) => m <= spanMin) : [spanMin, Math.round(spanMin / 2), 0];

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    const i = Math.round(((px - padL) / iw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };

  const hx = hover != null ? x(hover) : 0;
  const ago = hover != null ? Math.round(((n - 1 - hover) * stepMs) / 60000) : 0;

  return (
    <div className="chart" ref={box}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        height={height}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${series.map((s) => s.label).join(', ')} over the last ${spanMin} minutes`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="#1c2638" strokeWidth={1} />
            <text className="axis" x={padL - 8} y={y(t) + 3.5} textAnchor="end">
              {axisFormat(t)}
            </text>
          </g>
        ))}
        {xTicks.map((m) => {
          const i = n - 1 - (m * 60000) / stepMs;
          if (i < 0) return null;
          return (
            <text key={m} className="axis" x={x(i)} y={height - 5} textAnchor={m === 0 ? 'end' : 'middle'}>
              {m === 0 ? 'Now' : `-${m}m`}
            </text>
          );
        })}
        {n > 1 &&
          series.map((s, si) => (
            <g key={s.key}>
              <path d={areaPath(tops[si], bases[si])} fill={s.color} opacity={stacked ? 0.42 : 0.1} />
              <path d={linePath(tops[si])} fill="none" stroke={s.color} strokeWidth={stacked ? 1.5 : 2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}
        {hover != null && (
          <g pointerEvents="none">
            <line x1={hx} x2={hx} y1={padT} y2={padT + ih} stroke="#8a97ad" strokeWidth={1} />
            {series.map((s, si) => (
              <circle key={s.key} cx={hx} cy={y(tops[si][hover])} r={4} fill={s.color} stroke="#101827" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>
      {hover != null && (
        <div
          className="chart-tip"
          style={{ left: `${(hx / width) * 100}%`, transform: `translate(${hx > width * 0.6 ? 'calc(-100% - 12px)' : '12px'}, 8px)` }}
        >
          <div className="when">{ago === 0 ? 'Now' : `${ago} min ago`}</div>
          {[...series].reverse().map((s) => {
            const v = val(s, hover);
            return (
              <div className="row" key={s.key}>
                <b>{v == null ? '—' : format(v)}</b>
                <span>
                  <i className="key" style={{ background: s.color }} />
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
