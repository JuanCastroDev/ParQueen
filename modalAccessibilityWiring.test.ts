import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('shared modal accessibility wiring', () => {
  it('requires a name for every BottomSheet call site', () => {
    const bottomSheet = read('views/street-parking/BottomSheet.tsx');
    expect(bottomSheet).toMatch(/ariaLabel:\s*string/);
    expect(bottomSheet).not.toMatch(/ariaLabel\?:\s*string/);

    for (const file of [
      'views/street-parking/SpotModal.tsx',
      'views/street-parking/ParkingActivitySheet.tsx',
      'views/StreetParkingView.tsx',
    ]) {
      const source = read(file);
      const calls = source.match(/<BottomSheet\b[^>]*>/gs) ?? [];
      expect(calls.length, `${file} should render at least one BottomSheet`).toBeGreaterThan(0);
      calls.forEach(call => expect(call, `${file} BottomSheet must be named`).toMatch(/ariaLabel=/));
    }
  });

  it('uses the shared contract for account deletion with cancel-first focus and no Escape during deletion', () => {
    const app = read('App.tsx');
    expect(app).toContain("from './components/AccessibleModal'");
    expect(app).toMatch(/<AccessibleModal[\s\S]*?ariaLabel=/);
    expect(app).toMatch(/initialFocusRef=\{deleteCancelRef\}/);
    expect(app).toMatch(/onDismiss=\{deletePhase === 'deleting' \? undefined : handleDeleteModalDismiss\}/);
    expect(app).toMatch(/ref=\{deleteCancelRef\}/);
  });

  it('uses the shared contract for delete/report dialogs and returns focus to More options', () => {
    const messages = read('views/MessagesView.tsx');
    expect(messages).toContain("from '../components/AccessibleModal'");
    expect(messages).toMatch(/ref=\{menuTriggerRef\}[\s\S]*?aria-label=\{t\('messages\.menu_aria'\)\}/);
    expect(messages.match(/<AccessibleModal/g)).toHaveLength(2);
    expect(messages.match(/returnFocusRef=\{menuTriggerRef\}/g)).toHaveLength(2);
    expect(messages.match(/initialFocusRef=\{(?:delete|report)CancelRef\}/g)).toHaveLength(2);
    expect(messages).toMatch(/onDismiss=\{deletingChat \? undefined : closeDeleteConfirm\}/);
  });

  it('uses the shared contract for the delete-Ping dialog layered over Spot Details', () => {
    const streetParking = read('views/StreetParkingView.tsx');
    expect(streetParking).toContain("from '../components/AccessibleModal'");
    expect(streetParking).toMatch(/showDeleteConfirm[\s\S]*?<AccessibleModal/);
    expect(streetParking).toMatch(/initialFocusRef=\{deletePingCancelRef\}/);
    expect(streetParking).toMatch(/ref=\{deletePingCancelRef\}/);
  });

  it('wires discard/crowns/radius dialogs with data-modal-root and dialog role on the inner panel', () => {
    const cases = [
      {
        file: 'views/EditProfileView.tsx',
        modalRootMarker: 'data-modal-root=""',
        dialogRef: 'ref={discardDialogRef}',
        labelledBy: 'aria-labelledby="discard-title"',
      },
      {
        file: 'views/ProfileView.tsx',
        modalRootMarker: 'data-modal-root=""',
        dialogRef: 'ref={crownsDialogRef}',
        labelledBy: 'aria-labelledby="crowns-modal-title"',
      },
      {
        file: 'views/NotificationsView.tsx',
        modalRootMarker: 'data-modal-root=""',
        dialogRef: 'ref={radiusDialogRef}',
        labelledBy: "aria-label={t('nearby_activity.radius_sheet_title')}",
      },
    ] as const;

    for (const { file, modalRootMarker, dialogRef, labelledBy } of cases) {
      const source = read(file);
      expect(source, `${file} must declare data-modal-root`).toContain(modalRootMarker);
      expect(source, `${file} must keep dialogRef on the panel`).toContain(dialogRef);
      expect(source, `${file} must keep accessible name`).toContain(labelledBy);

      // dialogRef / role=dialog / aria-modal must not sit on the same element as data-modal-root
      const rootIdx = source.indexOf(modalRootMarker);
      expect(rootIdx, `${file} missing data-modal-root`).toBeGreaterThan(-1);
      const afterRoot = source.slice(rootIdx);
      // Find the opening tag that contains data-modal-root
      const openEnd = afterRoot.indexOf('>');
      const rootOpenTag = afterRoot.slice(0, openEnd + 1);
      expect(rootOpenTag, `${file} overlay must not carry role=dialog`).not.toMatch(/role=["']dialog["']/);
      expect(rootOpenTag, `${file} overlay must not carry dialogRef`).not.toContain(dialogRef);

      // Inner panel after the modal root should carry role=dialog + aria-modal + the dialogRef
      const panelRegion = afterRoot.slice(0, 1200);
      expect(panelRegion, `${file} inner panel needs role=dialog`).toMatch(/role=["']dialog["']/);
      expect(panelRegion, `${file} inner panel needs aria-modal`).toMatch(/aria-modal=["']true["']/);
      expect(panelRegion, `${file} dialogRef should be near the dialog role`).toContain(dialogRef);
    }
  });

  it('registers Android Back overlays on shared modal plumbing and Map search', () => {
    const modalA11y = read('hooks/useModalAccessibility.ts');
    expect(modalA11y).toContain('registerAndroidBackOverlay');
    expect(modalA11y).toContain('modalRootIsSuspended');

    const search = read('views/street-parking/useSearch.ts');
    expect(search).toContain("layer: 'transient'");
    expect(search).toContain('registerAndroidBackOverlay');

    const bottomSheet = read('views/street-parking/BottomSheet.tsx');
    expect(bottomSheet).toContain('onNestedBack');
    expect(bottomSheet).toContain('dismissFromBack');

    const ping = read('views/street-parking/SpotModal.tsx');
    expect(ping).toContain('onNestedBack');
    expect(ping).toContain("view !== 'timePicker'");

    const map = read('views/StreetParkingView.tsx');
    expect(map).toContain('onNestedBack');
    expect(map).toContain('spotDetailsBackStack');
    expect(map).toContain("myCarDepartureView !== 'timePicker'");
  });
});
