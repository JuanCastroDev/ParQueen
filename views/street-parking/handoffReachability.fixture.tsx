import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BottomSheet } from './BottomSheet';
import { FinishHandoffChip } from './FinishHandoffChip';
import { HandoffFlow } from './HandoffFlow';

const params = new URLSearchParams(location.search);
const initial = params.get('mode') === 'chip' ? 'chip' : 'sheet';
const initialStep = params.get('step') === 'outcome' ? 'outcome' : 'failure_reason';

function Nav() {
  return (
    <nav className="mobile-primary-nav md:hidden" aria-label="Primary">
      <div className="mobile-primary-nav-surface">
        <button type="button" className="mobile-primary-nav-item">Map</button>
        <button type="button" className="mobile-primary-nav-item">Nearby</button>
        <button type="button" className="mobile-primary-nav-ping">
          <span className="mobile-primary-nav-ping-orbit">
            <span className="mobile-primary-nav-ping-core" />
          </span>
          <span className="mobile-primary-nav-ping-label">Ping</span>
        </button>
        <button type="button" className="mobile-primary-nav-item">Messages</button>
        <button type="button" className="mobile-primary-nav-item">Profile</button>
      </div>
    </nav>
  );
}

function Fixture() {
  const [mode, setMode] = useState<'chip' | 'sheet'>(initial);
  const [step, setStep] = useState<'outcome' | 'failure_reason'>(initialStep);
  const [picked, setPicked] = useState<string | null>(null);
  const [resumed, setResumed] = useState(0);
  (window as unknown as { __picked: string | null; __resumed: number; __step: string }).__picked = picked;
  (window as unknown as { __resumed: number }).__resumed = resumed;
  (window as unknown as { __step: string }).__step = step;

  return (
    <div className="sp-page">
      <BottomSheet isOpen={mode === 'sheet'} ariaLabel="Handoff" onClose={() => setMode('chip')}>
        {mode === 'sheet' && (
          <HandoffFlow
            step={step}
            onOutcome={(outcome) => {
              if (outcome === 'failed') setStep('failure_reason');
            }}
            onFailureReason={(reason) => setPicked(reason)}
            onSetTimer={() => {}}
            onSkip={() => setMode('chip')}
          />
        )}
      </BottomSheet>
      <div className="sp-map" />
      <div className="sp-overlay flex flex-col justify-between p-0 md:p-3 pointer-events-none">
        <header className="map-mobile-header w-full pointer-events-auto" style={{ paddingTop: '16px' }}>
          <div className="map-search-shell" style={{ height: 51 }} />
        </header>
        <div className="mobile-map-controls w-full flex flex-col gap-3 pointer-events-auto mt-auto pb-0 px-0 md:pb-16 md:px-4">
          <div className="map-secondary-controls flex flex-col items-end gap-3 max-w-none md:max-w-[380px] mx-auto w-full mb-3">
            <button type="button" className="map-control-button" id="car-btn">Car</button>
            <button type="button" className="map-control-button" id="locate-btn">Locate</button>
          </div>
          {mode === 'chip' && (
            <FinishHandoffChip onResume={() => setResumed((n) => n + 1)} />
          )}
        </div>
      </div>
      {mode === 'chip' && <Nav />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
