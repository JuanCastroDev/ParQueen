/**
 * Last-in-first-out overlay dismiss stack for Android system Back.
 * Sheets/modals/search register while open; App.handleBack pops the top
 * active overlay before any AppView navigation.
 *
 * `modal` overlays (sheets/dialogs) always dismiss before `transient` ones
 * (Map search), regardless of mount order — search lives in the header,
 * below sheets in the tree.
 *
 * Suspended overlays (e.g. a Map BottomSheet under an inert Messages shell)
 * are skipped so Back reaches the foreground screen.
 */

export type AndroidBackOverlayLayer = 'modal' | 'transient';

export type AndroidBackOverlay = {
  dismiss: () => void;
  /** When omitted, the overlay is always eligible. */
  isActive?: () => boolean;
  /** Defaults to modal. Transient = Map search UI. */
  layer?: AndroidBackOverlayLayer;
};

const overlays: AndroidBackOverlay[] = [];

export function registerAndroidBackOverlay(overlay: AndroidBackOverlay): () => void {
  overlays.push(overlay);
  return () => {
    const index = overlays.lastIndexOf(overlay);
    if (index >= 0) overlays.splice(index, 1);
  };
}

function isEligible(overlay: AndroidBackOverlay): boolean {
  return !overlay.isActive || overlay.isActive();
}

/** Dismiss the topmost active overlay. Returns true when Back was consumed. */
export function dismissTopAndroidBackOverlay(): boolean {
  for (let i = overlays.length - 1; i >= 0; i--) {
    const overlay = overlays[i];
    if ((overlay.layer ?? 'modal') !== 'modal') continue;
    if (!isEligible(overlay)) continue;
    overlays.splice(i, 1);
    overlay.dismiss();
    return true;
  }
  for (let i = overlays.length - 1; i >= 0; i--) {
    const overlay = overlays[i];
    if (overlay.layer !== 'transient') continue;
    if (!isEligible(overlay)) continue;
    overlays.splice(i, 1);
    overlay.dismiss();
    return true;
  }
  return false;
}

/** Test-only: drop leaked registrations between cases. */
export function resetAndroidBackOverlays(): void {
  overlays.length = 0;
}
