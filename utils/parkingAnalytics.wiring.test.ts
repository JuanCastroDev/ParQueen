/**
 * Source-boundary tests: complement the existing transaction/hook tests.
 * Any future refactor of the live handlers must relocate instrumentation
 * consciously instead of silently dropping or duplicating an event.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const street = readFileSync(resolve(process.cwd(), 'views/StreetParkingView.tsx'), 'utf8');
const interest = readFileSync(resolve(process.cwd(), 'views/street-parking/useInterestFlow.ts'), 'utf8');
const section = (source: string, first: string, last: string) => {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start + first.length);
  if (start < 0 || end < 0) throw new Error(`Missing analytics anchor: ${first} / ${last}`);
  return source.slice(start, end);
};
const occurrences = (source: string, needle: string) => source.split(needle).length - 1;

describe('approved events are anchored to live parking flows', () => {
  it('records visible map transitions rather than render or obscured Messages layer', () => {
    const map = section(street, 'const mapWasVisibleRef', 'const mapContainerRef');
    expect(map).toContain('Boolean(showPrimaryNavigation && user?.id)');
    expect(map).toContain('visible && !mapWasVisibleRef.current');
    expect(map).toContain("recordParkingAnalyticsEvent('map_opened')");
    expect(map).toContain('mapWasVisibleRef.current = visible');
  });

  it('counts regular ping success only after a committed transaction', () => {
    const save = section(street, 'const handleSaveSpot =', 'const handleDeletePing =');
    expect(occurrences(save, "recordParkingAnalyticsEvent('ping_creation_started')")).toBe(1);
    expect(occurrences(save, "recordParkingAnalyticsEvent('ping_creation_succeeded')")).toBe(1);
    expect(save).toMatch(/const onSaveSuccess = \(\) => \{[\s\S]*?recordParkingAnalyticsEvent\('ping_creation_succeeded'\)/);
    expect(occurrences(save, 'await commitPingCreate(')).toBe(3);
    expect(occurrences(save, 'onSaveSuccess();')).toBe(3);
  });

  it('counts My Car only on a newly committed ping, not an already-linked ping', () => {
    const save = section(street, 'const handleMyCarPing =', 'const handleSaveSpot =');
    expect(occurrences(save, "recordParkingAnalyticsEvent('ping_creation_started')")).toBe(1);
    expect(occurrences(save, "recordParkingAnalyticsEvent('ping_creation_succeeded')")).toBe(1);
    expect(save).toMatch(/await commitPingCreate\([\s\S]*?recordParkingAnalyticsEvent\('ping_creation_succeeded'\)/);
    expect(save.indexOf('if (savedSpot.linkedPingId)')).toBeLessThan(save.indexOf("recordParkingAnalyticsEvent('ping_creation_started')"));
  });

  it('counts departure re-pings only after the Firestore create completes', () => {
    const departure = section(interest, 'const handleDeparturePing =', 'const handleScheduledClaim =');
    expect(occurrences(departure, "recordParkingAnalyticsEvent('ping_creation_started')")).toBe(1);
    expect(occurrences(departure, "recordParkingAnalyticsEvent('ping_creation_succeeded')")).toBe(1);
    expect(departure).toMatch(/await commitPingCreate\([\s\S]*?recordParkingAnalyticsEvent\('ping_creation_succeeded'\)/);
  });

  it('counts only fresh claims from both immediate and scheduled paths', () => {
    const immediate = section(interest, 'const handleExpressInterest =', 'const handleCancelByFinder =');
    const scheduled = section(interest, 'const handleScheduledClaim =', 'const handleCommitToHeading =');
    for (const path of [immediate, scheduled]) {
      expect(path).toContain('const claimResult = await acquireActiveIncomingClaim(');
      expect(path).toContain("if (claimResult === 'claimed') recordParkingAnalyticsEvent('parking_claim_started')");
    }
    const heading = section(interest, 'const handleCommitToHeading =', 'const handleOwnerLeaveNow =');
    expect(heading).not.toContain('recordParkingAnalyticsEvent');
  });

  it('records handoff success only from claimer server-backed completed state', () => {
    const watcher = section(interest, 'const watchForServerAward =', 'const enterAttestationWaiting =');
    expect(watcher).toContain("claimState !== 'completed_success'");
    expect(watcher).toContain('awardDeliveredRef.current.has(spotId)');
    expect(watcher).toContain("const serverConfirmed = isConfirmedServerHandoffSuccess(claimState, snap.metadata)");
    expect(watcher).toContain("role === 'claimer' && serverConfirmed && !successAnalyticsRecordedRef.current.has(spotId)");
    expect(watcher).toContain("if (role === 'claimer' && !serverConfirmed) return;");
    expect(watcher).toContain("recordParkingAnalyticsEvent('handoff_success_recorded')");
    const action = section(interest, 'const handleHandoffOutcome =', 'const handleFailureReason =');
    expect(action).not.toContain('handoff_success_recorded');
  });

  it('counts failed handoff only on newly created durable terminal feedback', () => {
    const failure = section(interest, 'const handleFailureReason =', 'const retryTerminalHandoff =');
    expect(failure).toMatch(/const recorded = await completeTerminalHandoff\(/);
    expect(failure).toContain("if (recorded === 'created') recordParkingAnalyticsEvent('handoff_failure_recorded')");
  });
});
