// One-tap story timing (ms from the tap), approved in gateb-freeze-v1.1.
// The art animations are scheduled in onboardingV2.css with the same numbers; these constants drive the
// caption changes and the automatic reveal of the three intentions.

export const STORY_TIMELINE = {
  caption2At: 2300,
  caption3At: 6000,
  choicesAt: 7700,
  /** Last intention row finishes sliding in (measured 8.29–8.31 s in the prototype). */
  choicesFullyVisibleAt: 8300,
  /** Welcome screen -> street: dissolve before the example starts (not part of the 8.3 s story). */
  welcomeFade: 450,
  /** Opening: the logo settles first, then the street fades up. */
  introDuration: 1400,
  /** Focus moves to the new heading after the panel has swapped. */
  focusDelay: 40,
  /** Choice highlight before handing off to sign-up. */
  pickDelay: 200,
  /** Screen-reader announcement after the choices appear. */
  announceDelay: 120,
} as const;

export type StoryCaption = 'cap1' | 'cap2' | 'cap3';

export type StoryStep = { at: number; action: 'caption'; caption: StoryCaption } | { at: number; action: 'choices' };

/** The timed steps of one play-through, in order. */
export const STORY_STEPS: readonly StoryStep[] = [
  { at: STORY_TIMELINE.caption2At, action: 'caption', caption: 'cap2' },
  { at: STORY_TIMELINE.caption3At, action: 'caption', caption: 'cap3' },
  { at: STORY_TIMELINE.choicesAt, action: 'choices' },
];
