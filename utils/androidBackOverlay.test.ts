import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dismissTopAndroidBackOverlay,
  registerAndroidBackOverlay,
  resetAndroidBackOverlays,
} from './androidBackOverlay';

describe('androidBackOverlay stack', () => {
  beforeEach(() => {
    resetAndroidBackOverlays();
  });
  afterEach(() => {
    resetAndroidBackOverlays();
  });

  // Isolation from other files that mount BottomSheet/AccessibleModal.

  it('returns false when nothing is registered', () => {
    expect(dismissTopAndroidBackOverlay()).toBe(false);
  });

  it('dismisses the most recently registered overlay first', () => {
    const lower = vi.fn();
    const upper = vi.fn();
    registerAndroidBackOverlay({ dismiss: lower });
    registerAndroidBackOverlay({ dismiss: upper });

    expect(dismissTopAndroidBackOverlay()).toBe(true);
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();

    expect(dismissTopAndroidBackOverlay()).toBe(true);
    expect(lower).toHaveBeenCalledTimes(1);
  });

  it('skips inactive overlays so an inert Map sheet does not steal Messages Back', () => {
    const mapSheet = vi.fn();
    const messagesModal = vi.fn();
    registerAndroidBackOverlay({ dismiss: mapSheet, isActive: () => false });
    registerAndroidBackOverlay({ dismiss: messagesModal, isActive: () => true });

    expect(dismissTopAndroidBackOverlay()).toBe(true);
    expect(messagesModal).toHaveBeenCalledTimes(1);
    expect(mapSheet).not.toHaveBeenCalled();
  });

  it('unregisters on cleanup so a closed sheet cannot consume a later Back', () => {
    const dismiss = vi.fn();
    const unregister = registerAndroidBackOverlay({ dismiss });
    unregister();
    expect(dismissTopAndroidBackOverlay()).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('consumes Back even when dismiss is a no-op (non-dismissible in-progress modal)', () => {
    registerAndroidBackOverlay({ dismiss: () => undefined });
    expect(dismissTopAndroidBackOverlay()).toBe(true);
  });

  it('dismisses modal sheets before transient Map search regardless of mount order', () => {
    const search = vi.fn();
    const sheet = vi.fn();
    registerAndroidBackOverlay({ dismiss: search, layer: 'transient' });
    registerAndroidBackOverlay({ dismiss: sheet, layer: 'modal' });

    expect(dismissTopAndroidBackOverlay()).toBe(true);
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();

    expect(dismissTopAndroidBackOverlay()).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });
});
