import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(__dirname, '..', 'StreetParkingView.tsx'), 'utf8');

const between = (startText: string, endText: string): string => {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('StreetParkingView canonical curb save contract', () => {
  it('persists the saved/resolving state before the bounded burst and callable finish', () => {
    const save = between('const saveMySpot = async () =>', '// Used after handoff');
    expect(save).toContain("curbResolutionStatus: 'resolving'");
    expect(save).toContain('writeSavedSpot(resolvingSpot)');
    expect(save).toContain('setSavedSpot(resolvingSpot)');
    expect(save).toContain('requestCanonicalCurb(lat, lng)');
    expect(save.indexOf('setSavedSpot(resolvingSpot)')).toBeLessThan(save.indexOf('requestCanonicalCurb(lat, lng)'));
    expect(source).toContain("savedSpot.curbResolutionStatus === 'resolving'");
    expect(source).toContain("t('street_intel.verifying_curb')");
  });

  it('uses one V2 request for a normal save and never invokes the 80 m matcher', () => {
    const request = between('const requestCanonicalCurb = useCallback', '// Pre-V2 sessions');
    const save = between('const saveMySpot = async () =>', '// Used after handoff');
    expect(request).toContain('collectLocationBurst');
    expect(request).toContain('buildCanonicalCurbRequest(location, candidateToken)');
    expect(request).toContain('parseCanonicalCurbResponse(result.data)');
    expect(save.match(/requestCanonicalCurb\(lat, lng\)/g)).toHaveLength(1);
    expect(save).not.toContain('runMatchNearestSegment');
    expect(save).not.toContain('geohashQueryBounds');
    expect(save).not.toContain('80');
  });

  it('passes the actual foreground-fix timestamp so stale map state cannot count as a fresh burst sample', () => {
    const request = between('const requestCanonicalCurb = useCallback', '// Pre-V2 sessions');
    const watch = between('watchHandle = watchPosition(', 'if (!mapRef.current) {');
    expect(watch).toContain('lastGpsSampleRef.current = {');
    expect(watch).toContain('timestampMs: Date.now()');
    expect(request).toContain('const observed = lastGpsSampleRef.current');
    expect(request).toContain('collectLocationBurst({ seed: liveSeed })');
    expect(request).not.toMatch(/liveSeed\s*=\s*\{[^}]*timestampMs:\s*now/s);
  });

  it('does not mix fresh GPS into an already-known handoff coordinate', () => {
    const handoff = between('const saveMySpotFromCoords', 'const [curbSelectionLoading');
    expect(handoff).toContain('requestCanonicalCurb(lat, lng, undefined, false)');
    expect(handoff).not.toContain('runMatchNearestSegment');
  });

  it('keeps postal address separate from canonical curb street and persists ambiguity', () => {
    const fields = between('const canonicalResponseFields', 'export const MapView');
    const save = between('const saveMySpot = async () =>', '// Used after handoff');
    expect(save).toContain("address: addressResult.status === 'fulfilled' ? addressResult.value : ''");
    expect(fields).toContain('segmentStreetName: response.streetName');
    expect(fields).toContain('curbSelector: response.selector');
    expect(fields).toContain("curbResolutionStatus: 'ambiguous'");
    expect(fields).toContain('parkingSide: null');
  });

  it('allows ambiguity to produce only one token-bearing selection request', () => {
    const selection = between('const handleCanonicalCurbSelection', 'const handleConfirmSide');
    expect(selection.match(/requestCanonicalCurb\(savedSpot\.lat, savedSpot\.lng, candidateToken\)/g)).toHaveLength(1);
    expect(selection).toContain("savedSpot.curbResolutionStatus !== 'ambiguous'");
    expect(selection).toContain('curbSelectionLoading');
    expect(selection).not.toContain('runMatchNearestSegment');
    expect(source).toContain('<VisualCurbSelector');
    expect(source).toContain('onSelect={handleCanonicalCurbSelection}');
  });

  it('attempts legacy canonical refresh once and replaces legacy identity only on V2 high confidence', () => {
    const migration = between('// Pre-V2 sessions', '// Live duration counter');
    expect(migration).toContain('savedSpot.curbRefreshAttempted');
    expect(migration).toContain('curbRefreshAttempted: true');
    expect(migration).toContain("if (response.status !== 'high_confidence') return");
    expect(migration).not.toContain('runMatchNearestSegment');
  });

  it('stores no invented side or segment for unsupported V2 results', () => {
    const fields = between('const canonicalResponseFields', 'export const MapView');
    const unsupported = fields.slice(fields.lastIndexOf('return {'));
    expect(unsupported).toContain('segmentId: null');
    expect(unsupported).toContain('parkingSide: null');
    expect(unsupported).toContain("curbResolutionStatus: 'unsupported'");
  });

  it('gates Cleaning Alert on a usable future cleaning time, not segment presence', () => {
    expect(source).toContain('setCleaningAvailable(r.cleaningAvailable)');
    expect(source).toContain('setNextCleaningAt(r.nextCleaningAt)');
    expect(source).toContain('disabled={!cleaningAvailable || !nextCleaningAt}');
    expect(source).toContain('cleaningAvailable && nextCleaningAt && reminderEnabled');
    expect(source).not.toContain('disabled={!savedSpot.segmentId}');
  });

  it('deactivates stale session reminders without erasing the saved preference', () => {
    const deactivate = between('const deactivateCleaningReminder', 'const endSession');
    expect(deactivate).toContain('reminderEnabled: false');
    expect(deactivate).toContain('nextCleaningAt: null');
    expect(deactivate).toContain('reminderAt: null');
    expect(deactivate).not.toContain('setReminderEnabled(false)');
    expect(source).toContain('writeCleaningReminder(r.nextCleaningAt, reminderEnabled');
  });
});
