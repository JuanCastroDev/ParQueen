'use strict';

// Centralized fresh-admin authorization for privileged callables.
//
// Prior pattern (still used only by bootstrapAdmin's own distinct bootstrap
// contract) was:
//
//   if (request.auth?.token?.role !== 'admin') throw new HttpsError('permission-denied', ...);
//
// This trusts only the PRESENTED ID TOKEN's embedded claims. Firebase ID
// tokens are bearer credentials that remain cryptographically valid for
// their full lifetime (normally ~1 hour) regardless of what happens to the
// account afterward. A token-only check does not notice:
//   - the caller was demoted (admin -> staff/null) after the token was minted
//   - the caller's Auth account was deleted after the token was minted
//   - the caller's Auth account was disabled after the token was minted
//   - the caller's refresh tokens were explicitly revoked after the token was minted
// setStaffRole's and deleteAccount's own target-side hardening (the shared
// adminRoleLock, the last-admin scan) protects the ACCOUNT BEING ACTED ON —
// it does nothing to stop a demoted/deleted/disabled/revoked CALLER from
// using their own still-valid old token to invoke admin-gated callables in
// the first place. requireCurrentAdmin closes that gap by re-deriving
// authorization from current server-side Auth state on every call, not the
// token alone.
//
// Revoked-refresh-token enforcement (isTokenRevokedForUser below) mirrors
// firebase-admin's OWN algorithm exactly — see BaseAuth.
// verifyDecodedJWTNotRevokedOrDisabled in
// node_modules/firebase-admin/lib/auth/base-auth.js (installed version
// 12.7.0 at the time this was written): it compares
// `decodedIdToken.auth_time * 1000` (NOT `iat` — auth_time reflects the
// original sign-in and stays constant across token refreshes tied to that
// session, which is exactly why Firebase uses it for revocation, not iat)
// against `new Date(userRecord.tokensValidAfterTime).getTime()`, and treats
// strictly-less-than as revoked (equal is valid). The callable framework's
// own automatic auth population (checkAuthToken in
// firebase-functions/lib/common/providers/https.js, installed version
// 5.1.1) calls `verifyIdToken(idToken)` with no checkRevoked argument
// (defaults to false) — confirmed by direct source read, not memory — so
// request.auth.token is a verified-but-revocation-unchecked decoded token,
// and request.auth.token.auth_time is the exact same field the SDK's own
// check uses. No raw bearer token re-parsing is needed to reproduce this
// comparison server-side.
//
// A prior version of this file attempted true revocation via
// getAuth().verifyIdToken(token, /* checkRevoked= */ true) against a raw
// bearer token pulled from request.rawRequest, and was removed after a
// direct diagnostic against the Firebase Auth EMULATOR proved the emulator
// does not enforce tokensValidAfterTime (a revoked token was still
// accepted). That was a real, valid reason not to ship an emulator-provable
// implementation — but the underlying algorithm is fully documented in the
// installed Admin SDK's own source and requires no raw-token parsing at
// all: it only needs request.auth.token.auth_time (already present) and
// getUser(uid).tokensValidAfterTime (already fetched by the existing
// fresh-state check below). This version implements that exact comparison
// directly, verified against SDK source and covered by deterministic
// boundary tests (see functions/adminAuth.revocation.integration.test.js) rather than
// relying on emulator behavior that is known not to exercise it.
//
// Lazy-require Firebase modules so this file is importable from test envs
// without requiring Firebase Admin to be initialized (matches rateLimiter.js).

// Pure, side-effect-free — exported for direct deterministic boundary
// testing without needing a live Auth emulator (which cannot exercise this
// path at all; see header above).
//
// Mirrors firebase-admin's BaseAuth.verifyDecodedJWTNotRevokedOrDisabled
// revocation comparison exactly, with two deliberate, documented
// deviations for privileged-endpoint safety (the raw SDK fails OPEN in
// both of these edge cases; a privileged endpoint must not):
//   - decodedToken.auth_time missing/non-numeric: every legitimately
//     Firebase-issued ID token carries this claim; its absence is not part
//     of any normal flow. The raw SDK would compute `undefined * 1000 ===
//     NaN`, and `NaN < x` is always false in JS, silently treating the
//     token as never-revoked. We fail closed instead.
//   - userRecord.tokensValidAfterTime present but unparseable: structurally
//     unreachable via the public UserRecord getter (firebase-admin's own
//     constructor guarantees this field is always either undefined or a
//     successfully Date-parsed string — see
//     node_modules/firebase-admin/lib/auth/user-record.js's parseDate),
//     but defensive regardless. The raw SDK would compute
//     `new Date(malformed).getTime() === NaN`, and any comparison against
//     NaN is false, again silently failing open. We fail closed instead.
//   - userRecord.tokensValidAfterTime absent entirely: this IS the SDK's
//     own documented "never revoked" representation (revokeRefreshTokens
//     has never been called for this account) — NOT an error condition.
//     Matches SDK semantics exactly: not revoked.
function isTokenRevokedForUser(decodedToken, userRecord) {
    const validAfter = userRecord.tokensValidAfterTime;
    if (!validAfter) {
        return false; // never revoked — legitimate default representation, matches SDK
    }

    const validSinceUtc = new Date(validAfter).getTime();
    if (Number.isNaN(validSinceUtc)) {
        return true; // fail closed — see header
    }

    const authTime = decodedToken?.auth_time;
    if (typeof authTime !== 'number' || Number.isNaN(authTime)) {
        return true; // fail closed — see header
    }

    const authTimeUtc = authTime * 1000;
    // Exact SDK comparison: strictly-less-than is revoked; equal is valid.
    return authTimeUtc < validSinceUtc;
}

// Authenticated-current-session check WITHOUT requiring admin role —
// authenticated, current Auth user exists, not disabled, refresh tokens
// not revoked since the presented token was minted. Used by
// requireCurrentAdmin below, and directly by callables (like bootstrapAdmin)
// whose caller is not required to already be an admin but whose session
// should still be current — a revoked or disabled account should not be
// able to perform a sensitive mutation merely because it once held a valid
// token, admin or not.
async function requireCurrentAuthenticatedUser(request) {
    const { getAuth } = require('firebase-admin/auth');
    const { HttpsError } = require('firebase-functions/v2/https');

    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Sign in first.');
    }

    let currentUser;
    try {
        currentUser = await getAuth().getUser(request.auth.uid);
    } catch (err) {
        const reason = err.code === 'auth/user-not-found' ? 'user_deleted' : 'user_lookup_failed';
        console.warn(`[admin-auth] rejected: ${reason}`);
        throw new HttpsError('permission-denied', 'Session no longer valid.');
    }
    if (currentUser.disabled) {
        console.warn('[admin-auth] rejected: user_disabled');
        throw new HttpsError('permission-denied', 'Session no longer valid.');
    }
    if (isTokenRevokedForUser(request.auth.token, currentUser)) {
        console.warn('[admin-auth] rejected: token_revoked');
        throw new HttpsError('permission-denied', 'Session no longer valid.');
    }

    return currentUser;
}

async function requireCurrentAdmin(request) {
    const { HttpsError } = require('firebase-functions/v2/https');

    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Sign in first.');
    }

    // Cheap, no-Auth-SDK-call fail-fast: rejects the common case (an
    // ordinary user who was never admin) before spending any Admin SDK
    // round-trip. This also preserves existing, intended behavior for a
    // NEWLY promoted admin whose current Auth state is already correct but
    // whose held ID token predates the promotion — they must still refresh
    // their token before admin functionality activates, exactly as before
    // this change; requireCurrentAdmin does not weaken that requirement.
    if (request.auth.token.role !== 'admin') {
        console.warn('[admin-auth] rejected: admin_stale_claim');
        throw new HttpsError('permission-denied', 'Admin only.');
    }

    // Fresh server-side state: closes demotion/deletion/disablement/
    // revocation, regardless of whether anything ever called
    // revokeRefreshTokens for this account. requireCurrentAuthenticatedUser
    // throws its own sanitized permission-denied for exists/disabled/
    // revoked failures; re-map to the 'Admin only.' message this call site
    // has always used so callers can't distinguish "never was admin" from
    // "was admin, session no longer valid" from the error text alone.
    let currentUser;
    try {
        currentUser = await requireCurrentAuthenticatedUser(request);
    } catch (err) {
        throw new HttpsError('permission-denied', 'Admin only.');
    }

    if (currentUser.customClaims?.role !== 'admin') {
        console.warn('[admin-auth] rejected: admin_stale_claim');
        throw new HttpsError('permission-denied', 'Admin only.');
    }

    // The admin caller is subject to the same product-access document as any
    // other user. This does not inspect the target, so an authorized admin
    // can still suspend or unsuspend a blocked account. A missing profile
    // does not deny.
    const { assertProductAccess } = require('./productAccess');
    await assertProductAccess(request.auth.uid);

    return currentUser;
}

module.exports = { requireCurrentAdmin, requireCurrentAuthenticatedUser, isTokenRevokedForUser };
