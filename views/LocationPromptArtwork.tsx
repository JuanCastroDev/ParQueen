// The exact editable Onboarding 2.0 neighborhood, reused for the location primer.
// These are *illustrative* Pings: there are no live map data or backend reads here.
import React from 'react';
import Logo from '../assets/Parqueen_Logo.png';
import envSvg from '../assets/onboarding-v2/env.svg';
import departingCar from '../assets/onboarding-v2/depart-car.svg';
import searchingCar from '../assets/onboarding-v2/search-car.svg';
import { PARQUEEN_MARK_PATH, PARQUEEN_MARK_TRANSFORM, PIN_PATH } from './street-parking/parqueenMark';

const ExamplePing = ({ x, y, delay }: { x: number; y: number; delay: number }) => (
    <g transform={`translate(${x} ${y})`}>
        <g className="pq-location-example-ping" style={{ animationDelay: `${delay}ms` }}>
            <g transform="translate(-17 -39) scale(0.85)">
                <path d={PIN_PATH} fill="#1e75ff" stroke="#b8d7ff" strokeWidth={0.7} />
                <g transform={PARQUEEN_MARK_TRANSFORM}>
                    <path d={PARQUEEN_MARK_PATH} fill="#fff" fillRule="evenodd" />
                </g>
            </g>
        </g>
    </g>
);

export const LocationPromptArtwork = ({ description }: { description: string }) => (
    <>
        <svg
            className="pq-location-scene"
            viewBox="0 108 390 445"
            preserveAspectRatio="xMidYMid slice"
            role="img"
            aria-label={description}
        >
            <defs>
                <radialGradient id="pq-location-ground-glow">
                    <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.34" />
                    <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
                </radialGradient>
                <linearGradient id="pq-location-scene-fade" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#050d1c" stopOpacity="0.16" />
                    <stop offset="68%" stopColor="#050d1c" stopOpacity="0" />
                    <stop offset="100%" stopColor="#050d1c" stopOpacity="0.85" />
                </linearGradient>
            </defs>
            <image href={envSvg} x="0" y="0" width="390" height="600" aria-hidden="true" />
            <image href={searchingCar} x="0" y="0" width="390" height="600" aria-hidden="true" />
            <image href={departingCar} x="0" y="0" width="390" height="600" aria-hidden="true" />
            {/* A location halo grounded on the road, not a false live GPS reading. */}
            <ellipse cx="195" cy="456" rx="96" ry="51" fill="url(#pq-location-ground-glow)" />
            <ellipse className="pq-location-halo" cx="195" cy="456" rx="81" ry="37" fill="none" stroke="#56dfff" strokeWidth="1.8" opacity=".72" />
            <ellipse cx="195" cy="456" rx="49" ry="22" fill="none" stroke="#9ceeff" strokeWidth="1" opacity=".55" />
            <circle cx="195" cy="456" r="14" fill="#32c8f5" opacity=".23" />
            <circle cx="195" cy="456" r="6" fill="#65e0ff" stroke="#fff" strokeWidth="2.2" />
            <ExamplePing x={105} y={362} delay={250} />
            <ExamplePing x={270} y={309} delay={420} />
            <ExamplePing x={320} y={388} delay={590} />
            <rect width="390" height="600" fill="url(#pq-location-scene-fade)" aria-hidden="true" />
        </svg>

        <div className="pq-location-brand" aria-hidden="true">
            <img src={Logo} alt="" />
            <span>ParQueen</span>
        </div>
    </>
);
