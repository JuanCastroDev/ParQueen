/**
 * Exactly the condition under which StreetParkingView renders <FinishHandoffChip> (the handoff-recovery card):
 * no handoff sheet step is open and there is a pending finder confirmation or an unfinished claimer handoff.
 * Used both to render the card and to suppress the contextual chip on short landscape, so the chip only
 * hides while the card is actually on screen.
 */
export function isHandoffRecoveryCardRendered(flow: {
    handoffStep: unknown;
    finderPendingHandoff: unknown;
    unfinishedHandoff: unknown;
}): boolean {
    return flow.handoffStep === null && !!(flow.finderPendingHandoff || flow.unfinishedHandoff);
}
