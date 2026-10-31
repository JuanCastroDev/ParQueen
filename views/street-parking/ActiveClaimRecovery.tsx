import type { RecoveredClaim } from './recoverActiveClaim';

interface ActiveClaimRecoveryProps {
  claims: RecoveredClaim[];
  error: string | null;
  ack: string | null;
  releasing: boolean;
  onInspect: (spotId: string) => void;
  onRelease: (spotId: string) => void;
  onDismissAck: () => void;
}

/**
 * Shown from the parking page itself, not from a pin inside the map window.
 * Release is a button the user presses. Dismissing this notice is not a release.
 */
export function ActiveClaimRecovery({
  claims,
  error,
  ack,
  releasing,
  onInspect,
  onRelease,
  onDismissAck,
}: ActiveClaimRecoveryProps) {
  if (claims.length === 0 && !error && !ack) return null;
  return (
    <div
      className="absolute top-4 left-0 right-0 z-30 flex justify-center px-4 pointer-events-none"
      role="region"
      aria-label="Active claims"
    >
      <div className="pointer-events-auto w-full max-w-sm rounded-2xl border border-white/10 bg-slate-950/90 px-4 py-3 text-white shadow-2xl backdrop-blur-xl">
        {ack && (
          <button type="button" className="mb-2 w-full text-left" onClick={onDismissAck}>
            <p className="text-sm font-semibold text-emerald-300">{ack}</p>
          </button>
        )}
        {error && <p className="mb-2 text-xs text-amber-200">{error}</p>}
        {claims.map((claim) => (
          <div key={claim.spotId} className="border-t border-white/10 py-2 first:border-t-0 first:pt-0">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-white/50">
              {claim.claimState === 'committed' ? 'Scheduled claim' : 'Active claim'}
            </p>
            <p className="mt-1 text-sm font-semibold">{claim.label}</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold"
                onClick={() => onInspect(claim.spotId)}
              >
                Inspect claim
              </button>
              <button
                type="button"
                className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-50"
                disabled={releasing}
                onClick={() => onRelease(claim.spotId)}
              >
                {releasing ? 'Releasing…' : 'Release claim'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
