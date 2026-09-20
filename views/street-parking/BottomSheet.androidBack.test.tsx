import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet } from './BottomSheet';
import {
  dismissTopAndroidBackOverlay,
  resetAndroidBackOverlays,
} from '../../utils/androidBackOverlay';

describe('BottomSheet Android Back', () => {
  beforeEach(() => {
    resetAndroidBackOverlays();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('window', {
      innerHeight: 800,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });
  afterEach(() => {
    resetAndroidBackOverlays();
    vi.unstubAllGlobals();
  });

  it('pops nested sheet state before closing', () => {
    const onClose = vi.fn();
    const onNestedBack = vi.fn(() => true);
    act(() => {
      TestRenderer.create(
        <BottomSheet isOpen onClose={onClose} ariaLabel="Ping your spot" onNestedBack={onNestedBack}>
          nested
        </BottomSheet>,
      );
    });

    expect(dismissTopAndroidBackOverlay()).toBe(true);
    expect(onNestedBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes the sheet when there is no nested state', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    act(() => {
      TestRenderer.create(
        <BottomSheet isOpen onClose={onClose} ariaLabel="My Car session">
          session
        </BottomSheet>,
      );
    });

    expect(dismissTopAndroidBackOverlay()).toBe(true);
    act(() => {
      vi.runAllTimers();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
