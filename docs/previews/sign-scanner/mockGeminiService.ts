/**
 * Preview-only stand-in for services/geminiService (aliased in ./vite.config.ts).
 * Same exports the Sign Scanner uses; responses follow the real SignAnalysisResult contract.
 * Choose the response with ?result=yes|no|conditional|conditional-timed|unreadable|unavailable
 * and the delay with ?delay=<ms> (default 2400).
 */
export interface SignAnalysisResult {
  status: 'YES' | 'NO' | 'CONDITIONAL' | 'ERROR';
  explanation: string;
  restrictionStartsAt?: string | null;
  restrictionEndsAt?: string | null;
  actionableAdvice?: string | null;
}

// Must match the real module byte-for-byte; views/sign-scanner/SignScannerView.test.tsx checks this.
export const SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION =
  'Assistant temporarily unavailable\nThe AI service is temporarily unavailable. Please try again shortly.';
export const SIGN_ANALYSIS_UNREADABLE_EXPLANATION =
  "Couldn't read this sign\nTry taking another photo with the full sign visible and in focus.";

export const isSignAnalysisUnavailable = (result: SignAnalysisResult): boolean =>
  result.status === 'ERROR' && result.explanation === SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION;

const params = () => new URLSearchParams(window.location.search);
const round5 = (ms: number) => { const d = new Date(ms); d.setSeconds(0, 0); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5); return d; };
const clock = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function responseFor(kind: string): SignAnalysisResult {
  const now = Date.now();
  const limit = round5(now + 120 * 60_000);
  const opens = round5(now + 195 * 60_000);
  const sweep = new Date(now); sweep.setDate(sweep.getDate() + 1); sweep.setHours(11, 30, 0, 0);
  switch (kind) {
    case 'no':
      return { status: 'NO', explanation: `No parking until ${clock(opens)} on weekdays, and that rule is in effect now.`, restrictionEndsAt: opens.toISOString(), actionableAdvice: `Find another spot, or come back after ${clock(opens)}.` };
    case 'conditional':
      return { status: 'CONDITIONAL', explanation: 'The lower sign’s hours depend on the day, and part of it is hard to make out.', restrictionStartsAt: null, restrictionEndsAt: null, actionableAdvice: null };
    case 'conditional-timed':
      return { status: 'CONDITIONAL', explanation: 'You can park now, but street cleaning starts tomorrow at 11:30 AM.', restrictionStartsAt: sweep.toISOString(), actionableAdvice: 'Move your car before 11:30 AM tomorrow.' };
    case 'unreadable':
      return { status: 'ERROR', explanation: SIGN_ANALYSIS_UNREADABLE_EXPLANATION };
    case 'unavailable':
      return { status: 'ERROR', explanation: SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION };
    default:
      return { status: 'YES', explanation: `Two-hour parking is allowed here now. The limit runs out at ${clock(limit)}.`, restrictionStartsAt: limit.toISOString(), actionableAdvice: `Move your car by ${clock(limit)}.` };
  }
}

export const analyzeParkingSign = async (_imageBase64: string): Promise<SignAnalysisResult> => {
  const delay = Number(params().get('delay') ?? 2400);
  await new Promise(r => setTimeout(r, delay));
  return responseFor(params().get('result') ?? 'yes');
};
