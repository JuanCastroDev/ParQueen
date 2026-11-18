import { describe, expect, it } from 'vitest';
import { isHandoffRecoveryCardRendered } from './handoffRecoveryCard';

describe('isHandoffRecoveryCardRendered (render condition, not record existence)', () => {
  it('is true only when no handoff step is open and an unfinished claimer handoff exists', () => {
    expect(isHandoffRecoveryCardRendered({ handoffStep: null, unfinishedHandoff: { id: 'h' } })).toBe(true);
  });
  it('is false while a handoff sheet step is open even though a record exists (card not rendered)', () => {
    expect(isHandoffRecoveryCardRendered({ handoffStep: 'outcome', unfinishedHandoff: { id: 'h' } })).toBe(false);
  });
  it('is false with no unfinished claimer handoff', () => {
    expect(isHandoffRecoveryCardRendered({ handoffStep: null, unfinishedHandoff: null })).toBe(false);
    expect(isHandoffRecoveryCardRendered({ handoffStep: null, unfinishedHandoff: undefined })).toBe(false);
  });
});
