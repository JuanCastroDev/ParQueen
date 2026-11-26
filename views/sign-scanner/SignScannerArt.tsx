import React from 'react';
import { t } from '../../i18n';

/**
 * Original hero illustration for the Sign Scanner: a blue-hour street, a pole with two stacked
 * parking signs, and a viewfinder frame. Plain SVG shapes only (no rasters, no real sign text),
 * on the same fixed night palette as the location primer art, so it reads identically in light
 * and dark themes. The two annotation chips are HTML so they translate and scale with text size.
 *
 * `compact` crops to the sign (returning visits, where Recent scans needs the space).
 */

/** Deterministic window pattern: the art never changes between renders. */
const WINDOW_BLOCKS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [-10, 58, 66, 3, 9], [60, 92, 48, 2, 6], [108, 46, 54, 2, 9], [298, 78, 80, 3, 7],
];
const WINDOWS = (() => {
  const out: Array<{ x: number; y: number; w: number; fill: string; op: number }> = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (const [x, y, w, cols, rows] of WINDOW_BLOCKS) {
    const cell = (w - 12) / cols;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = rnd();
        out.push({
          x: x + 8 + c * cell,
          y: y + 10 + r * 16,
          w: cell - 7,
          fill: v > 0.84 ? '#ffd79a' : v > 0.62 ? '#5b78b4' : '#202d5a',
          op: v > 0.84 ? 0.78 : v > 0.62 ? 0.38 : 0.9,
        });
      }
    }
  }
  return out;
})();

const INK = '#1b2440';

const SignFace = ({ y, tone, prohibited }: { y: number; tone: string; prohibited: boolean }) => (
  <g transform={`translate(181 ${y})`}>
    <rect width="96" height="64" rx="5" fill="#f2f5fa" />
    <rect x="2.5" y="2.5" width="91" height="59" rx="3.5" fill="none" stroke="#d3dae6" />
    <circle cx="20" cy="20" r="11.5" fill="none" stroke={tone} strokeWidth="3" />
    <path
      d="M16.4 27V13.2h4.9c3 0 4.9 1.6 4.9 4.2s-1.9 4.2-4.9 4.2h-2.1V27z"
      fill={prohibited ? '#17203a' : tone}
    />
    <path d="M19.2 15.6v3.6h2c1.4 0 2.2-.7 2.2-1.8s-.8-1.8-2.2-1.8z" fill="#f2f5fa" />
    {prohibited && <path d="M12 28 28 12" stroke={tone} strokeWidth="3" strokeLinecap="round" />}
    <rect x="39" y="10" width="46" height="6" rx="3" fill={tone} />
    <rect x="39" y="21" width="36" height="4" rx="2" fill={INK} />
    <rect x="39" y="29" width="42" height="4" rx="2" fill={INK} opacity=".8" />
    <rect x="10" y="40" width="74" height="4" rx="2" fill={INK} opacity=".75" />
    <path
      d={prohibited ? 'M12 53h28M12 53l5-3.6M12 53l5 3.6' : 'M84 53H56M84 53l-5-3.6M84 53l-5 3.6'}
      stroke={INK}
      strokeWidth="2.4"
      strokeLinecap="round"
      fill="none"
    />
  </g>
);

const corner = {
  stroke: '#67ddfc', strokeWidth: 3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none',
};

export const SignScannerArt = ({ compact = false }: { compact?: boolean }) => (
  <figure className={`pq-scan-hero${compact ? ' pq-scan-hero--compact' : ''}`} aria-hidden="true">
    <svg
      className="pq-scan-art"
      viewBox={compact ? '0 18 360 180' : '0 18 360 242'}
      preserveAspectRatio={compact ? 'xMidYMid slice' : 'xMidYMin slice'}
      focusable="false"
    >
      <defs>
        <linearGradient id="pqScanSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0a1430" /><stop offset=".72" stopColor="#15224c" /><stop offset="1" stopColor="#1a2852" />
        </linearGradient>
        <linearGradient id="pqScanWalk" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#25315a" /><stop offset="1" stopColor="#1b2445" />
        </linearGradient>
        <linearGradient id="pqScanCone" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe2b0" stopOpacity=".2" /><stop offset="1" stopColor="#ffe2b0" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="pqScanBeam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#67ddfc" stopOpacity="0" /><stop offset="1" stopColor="#67ddfc" stopOpacity=".24" />
        </linearGradient>
      </defs>

      <rect width="360" height="260" fill="url(#pqScanSky)" />
      <g fill="#141f46">
        <rect x="-10" y="58" width="66" height="160" /><rect x="60" y="92" width="48" height="126" />
        <rect x="108" y="46" width="54" height="172" /><rect x="298" y="78" width="80" height="140" />
      </g>
      <g fill="#1a2752">
        <rect x="-10" y="54" width="66" height="5" /><rect x="108" y="42" width="54" height="5" /><rect x="298" y="74" width="80" height="5" />
      </g>
      {WINDOWS.map((w, i) => (
        <rect key={i} x={w.x} y={w.y} width={w.w} height="7" rx="1" fill={w.fill} opacity={w.op} />
      ))}

      {/* street light */}
      <path d="M292 40h14l26 170h-66z" fill="url(#pqScanCone)" />
      <rect x="320" y="30" width="4" height="190" fill="#2c3964" />
      <path d="M322 33h-20" stroke="#2c3964" strokeWidth="3" strokeLinecap="round" />
      <rect x="290" y="32" width="17" height="6" rx="2" fill="#3c4c84" />
      <rect x="292" y="37" width="13" height="2" rx="1" fill="#ffe7bd" opacity=".9" />

      {/* sidewalk, curb, street */}
      <rect x="0" y="214" width="360" height="26" fill="url(#pqScanWalk)" />
      <g stroke="#ffffff" strokeOpacity=".05">
        {Array.from({ length: 9 }, (_, i) => <path key={i} d={`M${i * 44 + 10} 216v22`} />)}
      </g>
      <path d="M0 214.5h360" stroke="#3b4878" strokeWidth="1.5" />
      <rect x="0" y="240" width="360" height="5" fill="#2a355f" />
      <rect x="0" y="245" width="360" height="15" fill="#0c1330" />
      <ellipse cx="298" cy="216" rx="38" ry="4" fill="#ffe2b0" opacity=".07" />

      {/* parked car, cropped at the left edge */}
      <path d="M-34 260v-22q2-11 20-13l26-2q11-15 32-16h27q17 1 26 17 9 2 11 13v23z" fill="#22336b" />
      <path d="M17 222q9-11 24-12h20v12z" fill="#33498a" />
      <path d="M66 210h3q12 1 18 12H66z" fill="#33498a" />
      <rect x="102" y="232" width="5" height="7" rx="1.5" fill="#ff5a4f" opacity=".85" />

      {/* pole and two stacked signs */}
      <rect x="227" y="32" width="5" height="204" fill="#7d8bb0" />
      <rect x="227" y="32" width="1.5" height="204" fill="#b9c4de" />
      <rect x="225.5" y="29" width="8" height="4" rx="1" fill="#97a5c8" />
      <rect x="221" y="233" width="17" height="4" rx="1.5" fill="#56638c" />
      <SignFace y={40} tone="#d33b3b" prohibited />
      <SignFace y={110} tone="#1f7a4e" prohibited={false} />

      {/* what the scanner reads (labels are the HTML chips below) */}
      <g className="pq-scan-lead pq-scan-lead--1">
        <path d="M181 72h-31" stroke="#67ddfc" strokeWidth="1.4" strokeDasharray="2.5 3" />
        <circle cx="181" cy="72" r="2.4" fill="#67ddfc" />
      </g>
      <g className="pq-scan-lead pq-scan-lead--2">
        <path d="M181 142h-31" stroke="#67ddfc" strokeWidth="1.4" strokeDasharray="2.5 3" />
        <circle cx="181" cy="142" r="2.4" fill="#67ddfc" />
      </g>

      {/* viewfinder frame */}
      <g className="pq-scan-frame">
        <path d="M169 46V36a8 8 0 0 1 8-8h10" {...corner} />
        <path d="M271 28h10a8 8 0 0 1 8 8v10" {...corner} />
        <path d="M289 168v10a8 8 0 0 1-8 8h-10" {...corner} />
        <path d="M187 186h-10a8 8 0 0 1-8-8v-10" {...corner} />
      </g>
      <g className="pq-scan-sweepline">
        <rect x="171" y="0" width="116" height="24" fill="url(#pqScanBeam)" />
        <rect x="171" y="24" width="116" height="1.6" fill="#67ddfc" />
      </g>
    </svg>
    <span className="pq-scan-chip pq-scan-chip--1">{t('scanner.art_days')}</span>
    <span className="pq-scan-chip pq-scan-chip--2">{t('scanner.art_limits')}</span>
  </figure>
);

/** Small pole-with-two-signs glyph for the photography tip. */
export const StackedSignsGlyph = () => (
  <svg className="pq-scan-tip-glyph" viewBox="0 0 36 44" aria-hidden="true" focusable="false">
    <rect x="17" y="3" width="2.4" height="40" rx="1" fill="currentColor" opacity=".45" />
    <rect x="8" y="6" width="20" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".8" />
    <rect x="8" y="22" width="20" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".8" />
    <path
      d="M3 9V4a2 2 0 0 1 2-2h4M27 2h4a2 2 0 0 1 2 2v5M33 33v5a2 2 0 0 1-2 2h-4M9 40H5a2 2 0 0 1-2-2v-5"
      stroke="var(--pq-scan-accent)" strokeWidth="1.8" strokeLinecap="round" fill="none"
    />
  </svg>
);

/** Error illustrations: a sign washed out by glare, and a service outage. */
export const UnreadableGlyph = () => (
  <svg className="pq-scan-err-art" viewBox="0 0 120 96" aria-hidden="true" focusable="false">
    <rect x="58" y="10" width="4" height="86" rx="1.5" fill="var(--pq-scan-text-3)" opacity=".5" />
    <rect x="26" y="16" width="68" height="48" rx="5" fill="var(--pq-scan-surface-2)" stroke="var(--pq-scan-border)" />
    <g fill="var(--pq-scan-text-3)" opacity=".45">
      <rect x="36" y="26" width="40" height="5" rx="2.5" /><rect x="36" y="36" width="30" height="4" rx="2" /><rect x="36" y="45" width="36" height="4" rx="2" />
    </g>
    <path d="M64 16 46 64M80 16 62 64" stroke="var(--pq-scan-glare)" strokeWidth="7" strokeLinecap="round" />
    <path
      d="M14 22v-6a6 6 0 0 1 6-6h6M94 10h6a6 6 0 0 1 6 6v6M106 58v6a6 6 0 0 1-6 6h-6M26 70h-6a6 6 0 0 1-6-6v-6"
      stroke="var(--pq-scan-accent)" strokeWidth="2.6" strokeLinecap="round" fill="none" strokeDasharray="7 5"
    />
  </svg>
);
