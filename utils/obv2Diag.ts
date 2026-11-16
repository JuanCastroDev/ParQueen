// Onboarding 2.0 device diagnostics (QA builds only: VITE_OBV2_DIAG=1). Off in every normal build.
// Records navigation and lifecycle decisions so intermittent Android Back behaviour can be traced on a real device.
// Only enum-like, non-sensitive values are accepted: never phone numbers, codes, tokens, ids or any user data.
export const OBV2_DIAG = import.meta.env.VITE_OBV2_DIAG === '1';

type DiagValue = string | number | boolean | null | undefined;
const MAX = 400;
const buffer: string[] = [];

export function diag(event: string, data: Record<string, DiagValue> = {}): void {
  if (!OBV2_DIAG) return;
  const line = `[obv2-diag] t=${Math.round(performance.now())} ${event} ${JSON.stringify(data)}`;
  buffer.push(line);
  if (buffer.length > MAX) buffer.shift();
  (globalThis as unknown as { __obv2diag?: string[] }).__obv2diag = buffer;
  // eslint-disable-next-line no-console
  console.info(line);
}
