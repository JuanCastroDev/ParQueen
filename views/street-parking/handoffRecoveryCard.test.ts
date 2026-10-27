import { describe, expect, it } from 'vitest';
import { isHandoffRecoveryCardRendered } from './handoffRecoveryCard';

describe('isHandoffRecoveryCardRendered (render condition, not record existence)', () => {
  it('is true only when no handoff step is open and a pending/unfinished handoff exists', () => {
    expect(isHandoffRecoveryCardRendered({ handoffStep: null, finderPendingHandoff: { id: 'h' }, unfinishedHandoff: null })).toBe(true);
    expect(isHandoffRecoveryCardRendered({ handoffStep: null, finderPendingHandoff: null, unfinishedHandoff: { id: 'h' } })).toBe(true);
  });
  it('is false while a handoff sheet step is open even though a record exists (card not rendered)', () => {
    expect(isHandoffRecoveryCardRendered({ handoffStep: 'outcome', finderPendingHandoff: { id: 'h' }, unfinishedHandoff: { id: 'h' } })).toBe(false);
  });
  it('is false with no pending or unfinished handoff', () => {
    expect(isHandoffRecoveryCardRendered({ handoffStep: null, finderPendingHandoff: null, unfinishedHandoff: null })).toBe(false);
    expect(isHandoffRecoveryCardRendered({ handoffStep: null, finderPendingHandoff: undefined, unfinishedHandoff: undefined })).toBe(false);
  });
});
