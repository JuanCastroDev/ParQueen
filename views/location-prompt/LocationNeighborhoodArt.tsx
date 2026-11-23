// Location-permission artwork: an original, editable vector illustration of an Onboarding 2.0 brownstone
// block seen from above at blue hour. The camera has risen from the street-level onboarding scene, and the
// map centres on an example location with nearby example Pings (production Ping shape and ParQueen mark).
// Illustrative only: no live data, no map tiles, no words inside the art. Geometry: neighborhoodPlan.ts.
import React, { type CSSProperties } from 'react';
import { PARQUEEN_MARK_PATH, PARQUEEN_MARK_TRANSFORM, PIN_PATH } from '../street-parking/parqueenMark';
import {
  ART_HEIGHT, ART_WIDTH, AVENUE, BACKYARDS, BLOCKS, BUILDINGS, FACADE_TONES, FOCUS, LAMPS, MOVING_CARS,
  PARKED_CARS, PINGS, RADIUS, ROOF_TONES, STREET, TREES, YOU,
  type Building, type Car, type CarKind, type Tree,
} from './neighborhoodPlan';

const ASPHALT = '#161d35';
const PARKING_LANE = '#131a2f';
const SIDEWALK = '#29335a';
const CURB = '#43527c';
const BACKYARD = '#142238';
const WINDOW_LIT = '#f2c27e';
const WINDOW_WARM = '#ffd89a';
const WINDOW_DARK = '#1d2238';
const GLASS = '#0d1528';
const FACADE_H = 9;

/** Deterministic "random" so the art never changes between renders. */
const hash = (a: number, b: number) => Math.abs(Math.round(a * 7.31 + b * 13.7)) % 5;

const CAR_PAINT: Record<CarKind, { body: string; roof: string }> = {
  // Night-muted paint so the cars sit in the scene; the cab and a few red cars are the only accents.
  silver: { body: '#7f889c', roof: '#98a1b3' },
  white: { body: '#b4bccb', roof: '#cbd2de' },
  red: { body: '#a8443f', roof: '#bf524b' },
  maroon: { body: '#652a33', roof: '#7c2f38' },
  navy: { body: '#2d3860', roof: '#38446f' },
  slate: { body: '#474d66', roof: '#575e78' },
  teal: { body: '#33555c', roof: '#41666c' },
  taxi: { body: '#e3a72b', roof: '#f2c14f' },
};

const TopDownCar = ({ car }: { car: Car }) => {
  const paint = CAR_PAINT[car.kind];
  return (
    <g transform={`translate(${car.cx} ${car.cy}) rotate(${car.angle})`}>
      {car.moving && (
        <path d="M-4.2 -12 L-11 -54 L11 -54 L4.2 -12 Z" fill="url(#pqloc-beam)" />
      )}
      <rect x={-5.2} y={-10.4} width={12} height={24} rx={3.6} fill="rgba(2,6,17,0.5)" />
      <rect x={-6} y={-12} width={12} height={24} rx={3.6} fill={paint.body} />
      <path d="M-4.7 -5.6 L-3.6 -9 H3.6 L4.7 -5.6 Z" fill={GLASS} opacity={0.88} />
      <rect x={-4.7} y={-5.6} width={9.4} height={11} rx={1.8} fill={paint.roof} />
      <rect x={-4.1} y={5.8} width={8.2} height={2.8} rx={0.9} fill={GLASS} opacity={0.82} />
      {car.kind === 'taxi' && <rect x={-2.2} y={-1.6} width={4.4} height={2.6} rx={0.6} fill="#fff4c9" />}
      {car.moving ? (
        <>
          <circle cx={-3.7} cy={-11.6} r={1.2} fill="#fff6d8" />
          <circle cx={3.7} cy={-11.6} r={1.2} fill="#fff6d8" />
          <rect x={-5} y={11.2} width={2.6} height={1.1} rx={0.5} fill="#ff5a4f" />
          <rect x={2.4} y={11.2} width={2.6} height={1.1} rx={0.5} fill="#ff5a4f" />
        </>
      ) : null}
    </g>
  );
};

const RoofDetail = ({ b, roofH }: { b: Building; roofH: number }) => {
  switch (b.detail) {
    case 'tower': {
      // The NYC rooftop water tank, from above.
      const cx = b.x + b.w * 0.58, cy = b.y + roofH * 0.44;
      return (
        <g>
          <ellipse cx={cx + 3} cy={cy + 3.4} rx={6.6} ry={5.6} fill="rgba(2,6,17,0.45)" />
          <circle cx={cx} cy={cy} r={6} fill="#7a5440" stroke="#3b261e" strokeWidth={1} />
          <circle cx={cx - 0.6} cy={cy - 0.6} r={3.9} fill="#966a4f" />
          <circle cx={cx - 0.9} cy={cy - 0.9} r={1.4} fill="#c99c74" />
        </g>
      );
    }
    case 'ac':
      return (
        <g>
          <rect x={b.x + b.w * 0.28 + 1} y={b.y + roofH * 0.32 + 1.2} width={6.4} height={4.8} rx={0.8} fill="rgba(2,6,17,0.4)" />
          <rect x={b.x + b.w * 0.28} y={b.y + roofH * 0.32} width={6.4} height={4.8} rx={0.8} fill="#6b7591" />
          <circle cx={b.x + b.w * 0.28 + 3.2} cy={b.y + roofH * 0.32 + 2.4} r={1.5} fill="#39425c" />
        </g>
      );
    case 'skylight': {
      const x = b.x + b.w / 2 - 3.6, y = b.y + roofH * 0.46;
      return (
        <g>
          <rect x={x - 2.4} y={y - 2.4} width={12} height={9.2} rx={2} fill={WINDOW_LIT} opacity={0.16} />
          <rect x={x} y={y} width={7.2} height={4.4} rx={0.6} fill={WINDOW_WARM} opacity={0.82} />
        </g>
      );
    }
    case 'hatch':
      return <rect x={b.x + b.w * 0.36} y={b.y + roofH * 0.38} width={4.6} height={4.6} rx={0.6} fill="#2a2438" stroke="#5c5272" strokeWidth={0.7} />;
    case 'garden':
      return (
        <g>
          <rect x={b.x + 3} y={b.y + 4} width={b.w - 6} height={roofH * 0.42} rx={2.4} fill="#2b5c4f" opacity={0.85} />
          <circle cx={b.x + 6.5} cy={b.y + 7.5} r={2.4} fill="#3f7a66" />
          <circle cx={b.x + b.w - 7} cy={b.y + 9} r={2.1} fill="#3f7a66" />
        </g>
      );
    default:
      return null;
  }
};

/** A row of facade windows along a building's south face; most are lit, warm, like the onboarding street. */
const FacadeWindows = ({ x, y, w, seed }: { x: number; y: number; w: number; seed: number }) => {
  const count = Math.max(1, Math.floor((w - 4) / 5.6));
  const gap = (w - count * 2.8) / (count + 1);
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const tone = hash(seed, i);
        const fill = tone === 0 ? WINDOW_DARK : tone === 4 ? WINDOW_WARM : WINDOW_LIT;
        return <rect key={i} x={x + gap + i * (2.8 + gap)} y={y + 2.4} width={2.8} height={4} rx={0.4} fill={fill} />;
      })}
    </>
  );
};

const Rowhouse = ({ b }: { b: Building }) => {
  const front = Boolean(b.front);
  const roofH = front ? b.h - FACADE_H : b.h;
  const facadeTone = FACADE_TONES[b.tone % FACADE_TONES.length];
  return (
    <g>
      <rect x={b.x} y={b.y} width={b.w} height={roofH} fill={b.corner ? '#3d4a63' : ROOF_TONES[b.tone]} stroke="#141a2b" strokeWidth={0.9} />
      <rect x={b.x + 2.2} y={b.y + 2.2} width={Math.max(0, b.w - 4.4)} height={Math.max(0, roofH - 4.4)} fill="none" stroke="rgba(8,10,22,0.38)" strokeWidth={1} />
      <line x1={b.x + 1} y1={b.y + 1.1} x2={b.x + b.w - 1} y2={b.y + 1.1} stroke="rgba(255,236,222,0.1)" strokeWidth={1.2} />
      <RoofDetail b={b} roofH={roofH} />
      {front && (
        <g>
          <rect x={b.x} y={b.y + roofH} width={b.w} height={FACADE_H} fill={b.corner ? '#4b5672' : facadeTone} stroke="#141a2b" strokeWidth={0.8} />
          <line x1={b.x + 0.5} y1={b.y + roofH + 0.7} x2={b.x + b.w - 0.5} y2={b.y + roofH + 0.7} stroke="rgba(255,226,200,0.22)" strokeWidth={1} />
          {b.corner ? (
            <>
              {/* corner store: lit storefront and a green awning over the sidewalk */}
              <rect x={b.x + 4} y={b.y + roofH + 2.2} width={b.w - 8} height={4.6} rx={0.6} fill={WINDOW_WARM} />
              <rect x={b.x + 3} y={b.y + b.h - 1.2} width={b.w - 6} height={4.4} rx={1} fill="#2f8a74" />
              <rect x={b.x + 3} y={b.y + b.h + 2} width={b.w - 6} height={1.2} fill="#a6e3cf" opacity={0.55} />
            </>
          ) : (
            <>
              <FacadeWindows x={b.x} y={b.y + roofH} w={b.w} seed={b.x} />
              {/* brownstone stoop onto the sidewalk */}
              <rect x={b.x + b.w * 0.5 - 2.6} y={b.y + b.h} width={5.2} height={4.2} rx={0.6} fill="#786d80" />
              <line x1={b.x + b.w * 0.5 - 2.6} y1={b.y + b.h + 2} x2={b.x + b.w * 0.5 + 2.6} y2={b.y + b.h + 2} stroke="#5a5064" strokeWidth={0.6} />
            </>
          )}
        </g>
      )}
      {b.back ? (
        <g>
          <rect x={b.x} y={b.y + b.h - FACADE_H} width={b.back} height={FACADE_H} fill={facadeTone} stroke="#141a2b" strokeWidth={0.8} />
          <FacadeWindows x={b.x} y={b.y + b.h - FACADE_H} w={b.back} seed={b.x + 3} />
        </g>
      ) : null}
    </g>
  );
};

const StreetTree = ({ t }: { t: Tree }) => (
  <g>
    <circle cx={t.x + 3} cy={t.y + 4} r={t.r} fill="rgba(2,6,17,0.38)" />
    <circle cx={t.x} cy={t.y} r={t.r} fill="#23514a" />
    <circle cx={t.x - t.r * 0.22} cy={t.y - t.r * 0.26} r={t.r * 0.66} fill="#2f6a5c" />
    <circle cx={t.x - t.r * 0.42} cy={t.y - t.r * 0.46} r={t.r * 0.26} fill="#4a8a73" opacity={0.75} />
  </g>
);

const Streets = () => {
  const { x0: ax0, x1: ax1, lane: al } = AVENUE;
  const { y0: sy0, y1: sy1, lane: sl } = STREET;
  const cx = (ax0 + ax1) / 2;
  const cy = (sy0 + sy1) / 2;
  const bars = (from: number, to: number) => {
    const out: number[] = [];
    for (let v = from; v <= to; v += 6.2) out.push(v);
    return out;
  };
  return (
    <g>
      <rect x={ax0} y={-20} width={ax1 - ax0} height={ART_HEIGHT + 40} fill={ASPHALT} />
      <rect x={-20} y={sy0} width={ART_WIDTH + 40} height={sy1 - sy0} fill={ASPHALT} />
      {/* parking lanes, interrupted at the intersection */}
      <rect x={ax0} y={-20} width={al} height={sy0 - 14 + 20} fill={PARKING_LANE} />
      <rect x={ax1 - al} y={-20} width={al} height={sy0 - 14 + 20} fill={PARKING_LANE} />
      <rect x={ax0} y={sy1 + 14} width={al} height={ART_HEIGHT - sy1} fill={PARKING_LANE} />
      <rect x={ax1 - al} y={sy1 + 14} width={al} height={ART_HEIGHT - sy1} fill={PARKING_LANE} />
      <rect x={-20} y={sy0} width={ax0 - 14 + 20} height={sl} fill={PARKING_LANE} />
      <rect x={-20} y={sy1 - sl} width={ax0 - 14 + 20} height={sl} fill={PARKING_LANE} />
      <rect x={ax1 + 14} y={sy0} width={ART_WIDTH - ax1} height={sl} fill={PARKING_LANE} />
      <rect x={ax1 + 14} y={sy1 - sl} width={ART_WIDTH - ax1} height={sl} fill={PARKING_LANE} />
      {/* curbs */}
      <path
        d={`M${ax0} -20 V${sy0} H-20 M${ax1} -20 V${sy0} H${ART_WIDTH + 20} M${ax0} ${ART_HEIGHT + 20} V${sy1} H-20 M${ax1} ${ART_HEIGHT + 20} V${sy1} H${ART_WIDTH + 20}`}
        fill="none" stroke={CURB} strokeWidth={1.4}
      />
      {/* lane dashes */}
      <g stroke="rgba(214,226,252,0.2)" strokeWidth={1.2} strokeDasharray="7 9" fill="none">
        <path d={`M${cx} -20 V${sy0 - 16} M${cx} ${sy1 + 16} V${ART_HEIGHT + 20}`} />
        <path d={`M-20 ${cy} H${ax0 - 16} M${ax1 + 16} ${cy} H${ART_WIDTH + 20}`} />
      </g>
      {/* crosswalks */}
      <g fill="#c3cce0" opacity={0.5}>
        {bars(ax0 + 3, ax1 - 6).map(x => <rect key={`n${x}`} x={x} y={sy0 - 13} width={3.2} height={11} />)}
        {bars(ax0 + 3, ax1 - 6).map(x => <rect key={`s${x}`} x={x} y={sy1 + 2} width={3.2} height={11} />)}
        {bars(sy0 + 3, sy1 - 6).map(y => <rect key={`w${y}`} x={ax0 - 13} y={y} width={11} height={3.2} />)}
        {bars(sy0 + 3, sy1 - 6).map(y => <rect key={`e${y}`} x={ax1 + 2} y={y} width={11} height={3.2} />)}
      </g>
    </g>
  );
};

const Backyards = () => (
  <g>
    {BACKYARDS.map((r, i) => (
      <g key={i}>
        <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={BACKYARD} />
        {/* lot fences */}
        <g stroke="rgba(170,190,235,0.07)" strokeWidth={0.8}>
          {Array.from({ length: Math.ceil(r.w / 22) }, (_, k) => (
            <line key={k} x1={r.x + k * 22} y1={r.y} x2={r.x + k * 22} y2={r.y + r.h} />
          ))}
          <line x1={r.x} y1={r.y + r.h / 2} x2={r.x + r.w} y2={r.y + r.h / 2} />
        </g>
        {/* garden patches */}
        <rect x={r.x + 26} y={r.y + 14} width={16} height={22} rx={3} fill="#173630" />
        <rect x={r.x + r.w - 46} y={r.y + r.h - 40} width={18} height={20} rx={3} fill="#173630" />
      </g>
    ))}
  </g>
);

const Lamp = ({ x, y }: { x: number; y: number }) => (
  <g>
    <circle cx={x} cy={y} r={36} fill="url(#pqloc-lamp)" />
    <circle cx={x} cy={y} r={3.6} fill="#ffd58a" opacity={0.5} />
    <circle cx={x} cy={y} r={1.9} fill="#fff3d6" />
  </g>
);

/** Production Ping: same pin outline, blue and white ParQueen mark as the live map, hovering over a car. */
const ExamplePing = ({ x, y, index }: { x: number; y: number; index: number }) => (
  <g transform={`translate(${x} ${y})`}>
    <ellipse cx={0} cy={0.6} rx={7.4} ry={2.8} fill="rgba(30,117,255,0.38)" stroke="rgba(147,197,253,0.75)" strokeWidth={1} />
    <g className="pq-loc-ping" style={{ '--i': index } as CSSProperties}>
      <g transform="translate(-16 -40) scale(0.8)">
        <path d={PIN_PATH} transform="translate(1.6 2.4)" fill="rgba(2,6,17,0.55)" />
        <path d={PIN_PATH} fill="#1e75ff" stroke="#b8d7ff" strokeWidth={0.9} />
        <g transform={PARQUEEN_MARK_TRANSFORM}>
          <path d={PARQUEEN_MARK_PATH} fill="#ffffff" fillRule="evenodd" />
        </g>
      </g>
    </g>
  </g>
);

/** Four viewfinder corners: the map frames and centres on the example location. */
const FocusBrackets = () => {
  const { halfW: w, halfH: h, arm: a } = FOCUS;
  const corner = (sx: number, sy: number) => `M${sx * w} ${sy * (h - a)} V${sy * h} H${sx * (w - a)}`;
  return (
    <g transform={`translate(${YOU.x} ${YOU.y})`}>
      <g className="pq-loc-focus">
        <path
          d={[corner(-1, -1), corner(1, -1), corner(-1, 1), corner(1, 1)].join(' ')}
          fill="none" stroke="#9beaff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" opacity={0.92}
        />
      </g>
    </g>
  );
};

const LocationBeacon = () => (
  <g transform={`translate(${YOU.x} ${YOU.y})`}>
    <circle r={RADIUS.outer} fill="url(#pqloc-radius)" stroke="#56dfff" strokeOpacity={0.6} strokeWidth={1.3} />
    <circle r={RADIUS.inner} fill="none" stroke="#a5f0ff" strokeOpacity={0.4} strokeWidth={1} strokeDasharray="2 4" />
    <path d="M0 0 L-16 -43 A46 46 0 0 1 16 -43 Z" fill="url(#pqloc-heading)" />
    <circle className="pq-loc-pulse" r={9} fill="none" stroke="#56dfff" strokeWidth={2} />
    <g className="pq-loc-dot">
      <circle r={17} fill="#38bdf8" opacity={0.24} />
      <circle r={8.4} fill="url(#pqloc-dot)" stroke="#ffffff" strokeWidth={2.8} />
    </g>
  </g>
);

export const LocationNeighborhoodArt = ({ label }: { label: string }) => (
  <svg
    className="pq-loc-art"
    viewBox={`0 0 ${ART_WIDTH} ${ART_HEIGHT}`}
    preserveAspectRatio="xMidYMid slice"
    role="img"
    aria-label={label}
    focusable="false"
    data-testid="location-neighborhood-art"
  >
    <defs>
      <radialGradient id="pqloc-lamp">
        <stop offset="0" stopColor="#ffc46e" stopOpacity={0.34} />
        <stop offset="0.55" stopColor="#ffb357" stopOpacity={0.1} />
        <stop offset="1" stopColor="#ffb357" stopOpacity={0} />
      </radialGradient>
      <linearGradient id="pqloc-beam" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stopColor="#fff3d0" stopOpacity={0.42} />
        <stop offset="1" stopColor="#fff3d0" stopOpacity={0} />
      </linearGradient>
      <radialGradient id="pqloc-vignette" gradientUnits="userSpaceOnUse" cx={YOU.x} cy={YOU.y} r={265}>
        <stop offset="0" stopColor="#030814" stopOpacity={0} />
        <stop offset="0.36" stopColor="#030814" stopOpacity={0.06} />
        <stop offset="0.7" stopColor="#030814" stopOpacity={0.46} />
        <stop offset="1" stopColor="#030814" stopOpacity={0.86} />
      </radialGradient>
      <radialGradient id="pqloc-wash" gradientUnits="userSpaceOnUse" cx={YOU.x} cy={YOU.y} r={150}>
        <stop offset="0" stopColor="#38bdf8" stopOpacity={0.16} />
        <stop offset="1" stopColor="#38bdf8" stopOpacity={0} />
      </radialGradient>
      <radialGradient id="pqloc-radius">
        <stop offset="0" stopColor="#38bdf8" stopOpacity={0.2} />
        <stop offset="0.75" stopColor="#38bdf8" stopOpacity={0.1} />
        <stop offset="1" stopColor="#56dfff" stopOpacity={0.16} />
      </radialGradient>
      <linearGradient id="pqloc-heading" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stopColor="#7de3ff" stopOpacity={0.55} />
        <stop offset="1" stopColor="#7de3ff" stopOpacity={0} />
      </linearGradient>
      <linearGradient id="pqloc-dot" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#0af0ff" />
        <stop offset="1" stopColor="#1e8fff" />
      </linearGradient>
    </defs>

    <g className="pq-loc-city">
      <rect x={-20} y={-20} width={ART_WIDTH + 40} height={ART_HEIGHT + 40} fill={SIDEWALK} />
      <Streets />
      {Object.values(BLOCKS).map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={BACKYARD} />)}
      <Backyards />
      {BUILDINGS.map((b, i) => <Rowhouse key={i} b={b} />)}
      {LAMPS.map(l => <Lamp key={`${l.x},${l.y}`} {...l} />)}
      {PARKED_CARS.map((c, i) => <TopDownCar key={i} car={c} />)}
      {MOVING_CARS.map((c, i) => <TopDownCar key={`m${i}`} car={c} />)}
      {TREES.map((t, i) => <StreetTree key={i} t={t} />)}
      {/* one blue-hour grade over the whole block keeps every colour in the same night */}
      <rect x={-20} y={-20} width={ART_WIDTH + 40} height={ART_HEIGHT + 40} fill="#0b1a4a" opacity={0.16} />
      <rect x={-20} y={-20} width={ART_WIDTH + 40} height={ART_HEIGHT + 40} fill="url(#pqloc-vignette)" />
      <circle cx={YOU.x} cy={YOU.y} r={150} fill="url(#pqloc-wash)" />
    </g>

    <FocusBrackets />
    <LocationBeacon />
    {PINGS.map((p, i) => <ExamplePing key={i} x={p.x} y={p.y} index={i} />)}
  </svg>
);
