import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const map = readFileSync('views/StreetParkingView.tsx', 'utf8');
const assistant = readFileSync('views/AssistantView.tsx', 'utf8');

describe('parking timer integration contract', () => {
  it('derives the timer chip from live hook state, so expiry restores the contextual chip', () => {
    // When the hook clears an expired timer, timerChipRendered becomes false and the
    // contextual chip loses its --suppressed class without any extra wiring.
    expect(map).toContain('const timerChipRendered = !!(parkingTimer.timer && savedSpot);');
    expect(map).toMatch(/handoffRecoveryCardRendered \|\| timerChipRendered \? ' map-context-chip--suppressed' : ''/);
  });

  it('keeps the handoff card independent of the timer', () => {
    expect(map).toContain('const handoffRecoveryCardRendered = isHandoffRecoveryCardRendered(interestFlow);');
    expect(map).toMatch(/\{handoffRecoveryCardRendered && \(\s*<FinishHandoffChip/);
    expect(map).not.toMatch(/isHandoffRecoveryCardRendered\([^)]*parkingTimer/);
  });

  it('keeps the existing management actions and the AssistantView contract', () => {
    expect(map).toContain('onClick={parkingTimer.clearTimer}');
    expect(map).toMatch(/parkingTimer\.startTimer\(/);
    expect(assistant).toContain('const { startTimer, timer } = useParkingTimer();');
  });
});

function chipSuppressed(timer: object | null, savedSpot: object | null, handoff: boolean) {
  const timerChipRendered = !!(timer && savedSpot);
  return handoff || timerChipRendered;
}

describe('short-landscape priority truth table (mirrors StreetParkingView)', () => {
  it('restores the contextual chip once the timer expires (timer -> null)', () => {
    expect(chipSuppressed({ expiresAt: 1 }, {}, false)).toBe(true);
    expect(chipSuppressed(null, {}, false)).toBe(false);
  });
  it('stays suppressed by the handoff card regardless of the timer', () => {
    expect(chipSuppressed(null, {}, true)).toBe(true);
    expect(chipSuppressed({ expiresAt: 1 }, {}, true)).toBe(true);
  });
});

describe('End Parking Session cancels the global reminder', () => {
  it('endSession uses the explicit cancel path; the manual reminder cancel button keeps the guarded clear', () => {
    const start = map.indexOf('const endSession = () => {');
    const body = map.slice(start, map.indexOf('\n    };', start));
    expect(body).toContain('parkingTimer.cancelCurrentReminder();');
    expect(body).not.toContain('parkingTimer.clearTimer');
    expect(map).toContain('onClick={parkingTimer.clearTimer}');
  });
});
