# Proposal: remind 10 minutes before a restriction starts

**Status:** proposed, **not implemented**. Needs product approval before any change.

## What ships today

The Sign Scanner keeps the reminder timing the Parking Tools screen used. It is implemented in
`reminderMinutesFor()` in `views/sign-scanner/signScannerPresentation.ts`, and a test
(`signScannerPresentation.test.ts`) checks it against a verbatim copy of the old code:

- If `restrictionStartsAt` is in the future, the reminder fires **at** that time (minutes rounded up).
- Otherwise it fires **60 minutes** from now.
- It goes through `useParkingTimer().startTimer(minutes, 'parking sign')`, unchanged.

The one change that shipped with the scanner is **when the reminder is offered**: never when
parking appears prohibited (`status: 'NO'`). It is still offered only when the result includes
actionable advice, as before. Tests: `reminderOffered` in `signScannerPresentation.test.ts`, and
"does not offer a reminder when parking appears prohibited" in `SignScannerView.test.tsx`.

## The problem

A reminder that fires at the restriction start leaves no time to get back to the car. For
street cleaning at 11:30 AM, a notification at 11:30 means the ticket risk has already started.

## Proposal

When `restrictionStartsAt` is in the future, fire the reminder **10 minutes before** it.

- If that lead time would put the reminder less than 1 minute from now, fall back to the start time.
- The 60-minute fallback (no start time) is unchanged.
- The button label already shows the exact time, so the user sees the earlier time before tapping.

```ts
const LEAD_MINUTES = 10;
export function reminderMinutesFor(result: SignAnalysisResult, now: number): number {
  let minutes = REMINDER_FALLBACK_MINUTES;
  if (result.restrictionStartsAt) {
    const diff = Math.ceil((new Date(result.restrictionStartsAt).getTime() - now) / 60_000);
    if (diff > 0) minutes = diff - LEAD_MINUTES >= 1 ? diff - LEAD_MINUTES : diff;
  }
  return minutes;
}
```

## Open questions

1. Is 10 minutes right for NYC (walking back, moving the car)? Should it scale (e.g. 15 min when
   the restriction is more than 2 hours away)?
2. Should the label say both times ("Remind me at 11:20 AM, 10 min before cleaning")?
3. `useParkingTimer` is one global timer shared with My Car. A scanner reminder replaces an
   existing My Car reminder today; that is also unchanged and worth a separate decision.

## To ship it

Change `reminderMinutesFor`, replace the "unchanged from the previous screen" test block with
lead-time cases (including the <1 minute fallback), and update this document's status.
