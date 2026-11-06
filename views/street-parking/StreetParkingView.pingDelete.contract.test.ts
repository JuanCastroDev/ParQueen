import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '../../i18n/en';
import es from '../../i18n/es';

const source = readFileSync('views/StreetParkingView.tsx', 'utf8');
const flow = source.slice(source.indexOf('const handleDeletePing ='), source.indexOf('const handlePrimaryMapAction ='));
const dialog = source.slice(source.indexOf('{showDeleteConfirm && ('), source.indexOf('{showPingConfirmation && ('));

describe('Ping deletion confirmation UX contract', () => {
  it('freezes the confirmed Ping target instead of resolving a later selection', () => {
    expect(flow).toContain('deletePingTargetRef.current = spotToDelete');
    expect(flow).toContain('const spotToDelete = deletePingTargetRef.current');
  });

  it('guards duplicate submissions synchronously', () => {
    expect(flow).toContain('if (deletePingInFlightRef.current) return');
    expect(flow).toContain('deletePingInFlightRef.current = true');
    expect(flow).toContain('deletePingInFlightRef.current = false');
    expect(dialog).toContain('disabled={isDeletingPing}');
  });

  it('does not close until a successful outcome and leaves failures visible', () => {
    const request = flow.indexOf('await cancelConfirmedPing');
    const close = flow.indexOf('setShowDeleteConfirm(false)');
    expect(request).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(request);
    expect(dialog).toContain('role="alert"');
    expect(dialog).toContain("t('map.delete_deleting')");
  });

  it('has matching English and Spanish loading and error copy', () => {
    const keys = [
      'map.delete_deleting',
      'map.delete_error_stale',
      'map.delete_error_not_owner',
      'map.delete_error_unavailable',
      'map.delete_error_service',
      'map.delete_error_permission',
      'map.delete_error_verification',
      'map.delete_error_network',
      'map.delete_error_failed',
    ];
    for (const key of keys) {
      expect(en[key]).toBeTruthy();
      expect(es[key]).toBeTruthy();
    }
  });

  it('keeps the live subscription responsible for clearing a deleted map selection', () => {
    expect(source).toContain('// Sync selectedItem from live Firestore updates');
    expect(source).toContain('// Spot no longer in any data source (occupied/expired/deleted) — clear selection');
    expect(flow).toContain('setSelectedItem(null)');
  });
});
