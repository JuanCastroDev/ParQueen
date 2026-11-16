// The Onboarding 2.0 street: frozen vector art layers plus the code-drawn interaction layers
// (halo, unlock blink, production Ping, cyan signal, discovery phone). Geometry: sceneGeometry.ts.
import React, { type CSSProperties } from 'react';
import envSvg from '../../assets/onboarding-v2/env.svg';
import envForeSvg from '../../assets/onboarding-v2/env-fore.svg';
import departCarSvg from '../../assets/onboarding-v2/depart-car.svg';
import driverSvg from '../../assets/onboarding-v2/driver.svg';
import departDoorSvg from '../../assets/onboarding-v2/depart-door.svg';
import searchCarSvg from '../../assets/onboarding-v2/search-car.svg';
import { PARQUEEN_MARK_PATH, PARQUEEN_MARK_TRANSFORM, PIN_PATH } from '../street-parking/parqueenMark';
import { PING_HEIGHT, PING_WIDTH, SCENE_ANCHORS, signalDots, signalPath } from './sceneGeometry';

const A = SCENE_ANCHORS;
const DOTS = signalDots();
const SIGNAL = signalPath();

/** The production Ping marker (same pin outline, white ParQueen mark and blue as the live map). */
const ProductionPin = ({ className, width, height }: { className?: string; width?: number; height?: number }) => (
  <svg className={className} width={width} height={height} viewBox="0 0 40 46" aria-hidden="true" focusable="false">
    <path d={PIN_PATH} fill="#1e75ff" stroke="rgba(255,255,255,0.25)" strokeWidth={0.5} />
    <g transform={PARQUEEN_MARK_TRANSFORM}><path d={PARQUEEN_MARK_PATH} fill="#ffffff" fillRule="evenodd" /></g>
  </svg>
);

export const LeaveIntentIcon = () => (
  <svg width={16} height={18} viewBox="0 0 40 46" aria-hidden="true" focusable="false">
    <path d={PIN_PATH} fill="#1e75ff" />
    <g transform={PARQUEEN_MARK_TRANSFORM}><path d={PARQUEEN_MARK_PATH} fill="#fff" fillRule="evenodd" /></g>
  </svg>
);

const Halo = () => {
  const H = A.halo;
  return (
    <svg className="fx" viewBox="0 0 390 600" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="obv2-haloG" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="rgba(56,189,248,0.30)" />
          <stop offset="1" stopColor="rgba(56,189,248,0)" />
        </radialGradient>
      </defs>
      <g className="halo">
        <ellipse cx={H.cx} cy={H.cy} rx={H.rx * 1.24} ry={H.ry * 1.22} fill="url(#obv2-haloG)" />
        <ellipse className="halo-ring" cx={H.cx} cy={H.cy} rx={H.rx} ry={H.ry} fill="none" stroke="#38bdf8" strokeWidth={2} />
        <ellipse cx={H.cx} cy={H.cy} rx={H.rx * 1.12} ry={H.ry * 1.13} fill="none" stroke="rgba(96,165,250,0.40)" strokeWidth={1} />
      </g>
    </svg>
  );
};

const StoryEffects = () => {
  const { x: X, y: Y, w: PWd, h: PHt } = A.phone;
  const mx = X + PWd / 2, my = Y + 44;
  const [gx, gy] = A.redGlass;
  const [hx, hy] = A.hand;
  const sparkStyle = { '--dx': `${(A.pingTip[0] - hx).toFixed(1)}px`, '--dy': `${(A.pingTip[1] - 30 - hy).toFixed(1)}px` } as CSSProperties;
  return (
    <svg className="fx" viewBox="0 0 390 600" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="obv2-rxG" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="rgba(56,189,248,0.75)" />
          <stop offset="1" stopColor="rgba(56,189,248,0)" />
        </radialGradient>
        <radialGradient id="obv2-ambG" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="rgba(255,179,71,0.9)" />
          <stop offset="1" stopColor="rgba(255,179,71,0)" />
        </radialGradient>
      </defs>
      {A.amber.map(([x, y]) => <circle key={x} className="unlock" cx={x} cy={y} r={16} fill="url(#obv2-ambG)" />)}
      <path className="sig-line" d={SIGNAL.d} fill="none" stroke="rgba(56,189,248,0.55)" strokeWidth={1.6} strokeLinecap="round" strokeDasharray="2 5" />
      {DOTS.map(dot => (
        <React.Fragment key={dot.index}>
          <circle className="sig-glow" style={{ '--i': dot.index } as CSSProperties} cx={dot.x} cy={dot.y} r={dot.glowR} fill={`rgba(56,189,248,${dot.glowAlpha})`} />
          <circle className="sig-dot" style={{ '--i': dot.index } as CSSProperties} cx={dot.x} cy={dot.y} r={dot.r} fill="#bae6fd" />
        </React.Fragment>
      ))}
      {/* discovery: the searching driver's phone shows the same Ping on the map (in-app, not a push notification) */}
      <ellipse className="rx-glow" cx={gx} cy={gy} rx={16} ry={6} fill="url(#obv2-rxG)" />
      <g className="disc">
        <path d={`M${X + PWd / 2 - 6},${Y + PHt - 1} L${X + PWd / 2 + 6},${Y + PHt - 1} L${A.cueBase[0]},${A.cueBase[1] + 1} Z`} fill="rgba(56,189,248,0.75)" />
        <rect className="disc-halo" x={X - 4} y={Y - 4} width={PWd + 8} height={PHt + 8} rx={11} fill="none" stroke="#38bdf8" strokeWidth={2} />
        <rect x={X - 2} y={Y - 2} width={PWd + 4} height={PHt + 4} rx={10} fill="rgba(56,189,248,0.22)" />
        <rect x={X} y={Y} width={PWd} height={PHt} rx={8} fill="#091728" stroke="rgba(186,230,253,0.85)" strokeWidth={1.5} />
        <rect x={X + 3} y={Y + 7} width={PWd - 6} height={PHt - 14} rx={4} fill="#12305a" />
        <path d={`M${X + 3},${Y + 22} H${X + PWd - 3} M${X + 3},${Y + 54} H${X + PWd - 3} M${X + 14},${Y + 7} V${Y + PHt - 7} M${X + 30},${Y + 7} V${Y + PHt - 7}`} stroke="rgba(147,197,253,0.35)" strokeWidth={2.2} />
        <rect x={X + PWd / 2 - 6} y={Y + 2.6} width={12} height={1.8} rx={0.9} fill="rgba(255,255,255,0.35)" />
        <circle className="disc-pulse" cx={mx} cy={my - 8} r={8} fill="none" stroke="#1e75ff" strokeWidth={2} />
        <g className="disc-pin">
          <g transform={`translate(${mx - 8.4} ${my - 19.3}) scale(0.42)`}>
            <path d={PIN_PATH} fill="#1e75ff" stroke="rgba(255,255,255,0.5)" strokeWidth={1} />
            <g transform={PARQUEEN_MARK_TRANSFORM}><path d={PARQUEEN_MARK_PATH} fill="#fff" fillRule="evenodd" /></g>
          </g>
        </g>
      </g>
      {/* the light that leaves the departing driver's phone and becomes the Ping */}
      <circle className="spark" cx={hx} cy={hy} r={4} fill="#bae6fd" style={sparkStyle} />
    </svg>
  );
};

type Props = {
  altText: string;
  carLabel: string;
  carTappable: boolean;
  onCarTap: () => void;
  transform: string;
};

export const NeighborhoodScene = ({ altText, carLabel, carTappable, onCarTap, transform }: Props) => (
  <div className="scene" style={{ transform }} data-testid="obv2-scene">
    <div className="art" role="img" aria-label={altText}>
      <img src={envSvg} alt="" aria-hidden="true" data-layer="environment" draggable={false} decoding="async" />
      {/* the same street, continued toward the camera below the 390x600 frame (same projection; nothing stretched) */}
      <img className="layer-fore" src={envForeSvg} alt="" aria-hidden="true" data-layer="environment-foreground" draggable={false} decoding="async" />
      <Halo />
      <img src={departCarSvg} alt="" aria-hidden="true" data-layer="departing-car" draggable={false} />
      <img className="layer-driver" src={driverSvg} alt="" aria-hidden="true" data-layer="driver" draggable={false} />
      <img src={departDoorSvg} alt="" aria-hidden="true" data-layer="departing-door" draggable={false} />
      <img className="layer-search" src={searchCarSvg} alt="" aria-hidden="true" data-layer="searching-car" draggable={false} />
      <StoryEffects />
      <div
        className="ping"
        aria-hidden="true"
        style={{ left: A.pingTip[0] - PING_WIDTH / 2, top: A.pingTip[1] - PING_HEIGHT }}
        data-testid="obv2-ping"
      >
        <span className="tip" /><span className="pulse" /><span className="pulse p2" />
        <ProductionPin className="pin" />
      </div>
    </div>
    <div className="hits">
      <button
        type="button"
        className="car-hit"
        aria-label={carLabel}
        hidden={!carTappable}
        onClick={onCarTap}
        style={{ left: A.carHit[0], top: A.carHit[1], width: A.carHit[2], height: A.carHit[3] }}
        data-testid="obv2-car"
      />
    </div>
  </div>
);
