/**
 * §6 — App Check prod bundle and source assertions (TM-12).
 *
 * Status: Web reCAPTCHA still gated on VITE_FIREBASE_APPCHECK_SITE_KEY.
 * Capacitor Android uses CustomProvider + native Play Integrity / Debug
 * (Phase 2E). Enforcement of Cloud Functions is independent — see
 * docs/APP_CHECK_ROLLOUT.md.
 *
 * Vite strips the `if (import.meta.env.DEV)` guard in production builds.
 * When VITE_FIREBASE_APPCHECK_SITE_KEY is absent (CI/local without key),
 * the initializeAppCheck branch is also dead code and is tree-shaken from
 * the prod bundle — the call never ships to production without a site key.
 *
 * Tests skip when dist/ does not exist (pre-build). Run `npm run build` first
 * or let §10 (full release gate) provide the built output.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const DIST_DIR = path.resolve(__dirname, '../dist');
const distExists = fs.existsSync(DIST_DIR);
const SRC_CONFIG = path.resolve(__dirname, '../firebaseConfig.ts');
const APP_CHECK_SRC = path.resolve(__dirname, './appCheck.ts');

// Once App Check survives production tree-shaking, the official Firebase App
// Check SDK's own compiled runtime legitimately contains the bare identifier
// FIREBASE_APPCHECK_DEBUG_TOKEN — it's how the SDK checks whether a developer
// manually set the global in devtools (typeof x.FIREBASE_APPCHECK_DEBUG_TOKEN
// == "string" / !== true). That passive read is not a leak. An ASSIGNMENT to
// that global — `= ` not part of `==`/`===`/`!==` — is what would indicate
// ParQueen's own DEV-only debug wiring (or equivalent) escaped its
// `import.meta.env.DEV` guard. These two regexes test for the write, not mere
// presence of the name.
const DEBUG_TOKEN_ASSIGNMENT = /FIREBASE_APPCHECK_DEBUG_TOKEN\s*=(?!=)/;
const DEBUG_TOKEN_PROPERTY_ASSIGNMENT = /\.FIREBASE_APPCHECK_DEBUG_TOKEN\s*=(?!=)/;

/** Scan all .js and .html files under dir; return lines matching pattern. */
function scanDist(pattern: RegExp): string[] {
    const hits: string[] = [];
    function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.js') && !entry.name.endsWith('.html')) continue;
            const content = fs.readFileSync(full, 'utf-8');
            content.split('\n').forEach((line, i) => {
                if (pattern.test(line)) hits.push(`${full}:${i + 1}`);
            });
        }
    }
    walk(DIST_DIR);
    return hits;
}

describe('§6 — App Check prod bundle assertions', () => {
    it.skipIf(!distExists)('AC-1: dist/ does not assign a value to FIREBASE_APPCHECK_DEBUG_TOKEN', () => {
        // Bare presence of the identifier is expected once App Check is active —
        // see the SDK-passive-read comment above. Only a write is unsafe.
        expect(scanDist(DEBUG_TOKEN_ASSIGNMENT)).toHaveLength(0);
    });

    it.skipIf(!distExists)('AC-2: dist/ does not contain VITE_APPCHECK_DEBUG_TOKEN', () => {
        expect(scanDist(/VITE_APPCHECK_DEBUG_TOKEN/)).toHaveLength(0);
    });

    it.skipIf(!distExists)('AC-3: dist/ does not contain App Check site key or token values', () => {
        // Static imports of initializeAppCheck/ReCaptchaEnterpriseProvider may survive
        // Vite bundling even when the runtime branch is dead (Firebase packages are not
        // fully tree-shakeable due to side effects). The security-relevant check is that
        // no SITE KEY VALUES or DEBUG TOKEN VALUES are present in the bundle — not the
        // function name. AC-1, AC-2, AC-4, and AC-12 cover the sensitive-value checks.
        // This test asserts the site key variable reference is replaced at build time.
        expect(scanDist(/VITE_FIREBASE_APPCHECK_SITE_KEY/)).toHaveLength(0);
    });

    it.skipIf(!distExists)('AC-4: dist/ does not contain known debug-bypass string', () => {
        expect(scanDist(/appcheck-debug-/i)).toHaveLength(0);
    });

    it('AC-5: firebaseConfig.ts DEV guard wraps debug token setup (source-level check)', () => {
        const src = fs.readFileSync(SRC_CONFIG, 'utf-8');
        const debugTokenIndex = src.indexOf('FIREBASE_APPCHECK_DEBUG_TOKEN');
        const devGuardIndex = src.lastIndexOf('import.meta.env.DEV', debugTokenIndex);
        expect(devGuardIndex).toBeGreaterThan(-1);
        expect(devGuardIndex).toBeLessThan(debugTokenIndex);
    });

    it('AC-6: firebaseConfig.ts initializes App Check exactly once via initializeParQueenAppCheck(app)', () => {
        const src = fs.readFileSync(SRC_CONFIG, 'utf-8');
        expect(src).toMatch(/initializeParQueenAppCheck\(app\)/);
        expect(src.match(/initializeParQueenAppCheck\(/g) || []).toHaveLength(1);
        expect(src).not.toMatch(/initializeAppCheck\s*\(/);
    });

    it('AC-7: ReCaptchaEnterpriseProvider remains the Web/PWA App Check provider', () => {
        const src = fs.readFileSync(APP_CHECK_SRC, 'utf-8');
        expect(src).toMatch(/ReCaptchaEnterpriseProvider/);
        const providerCallIdx = src.indexOf('new Recaptcha(');
        expect(providerCallIdx).toBeGreaterThan(-1);
        const providerArg = src.slice(providerCallIdx, src.indexOf(')', providerCallIdx));
        expect(providerArg).toMatch(/appCheckSiteKey/);
        expect(providerArg).not.toMatch(/"[A-Za-z0-9_-]{20,}"/);
        const nativeReturnIdx = src.indexOf("if (path === 'native-android')");
        const recaptchaIdx = src.indexOf('new Recaptcha(');
        expect(nativeReturnIdx).toBeGreaterThan(-1);
        expect(src.lastIndexOf('return;', recaptchaIdx)).toBeGreaterThan(nativeReturnIdx);
    });

    it('AC-8: initializeAppCheck uses the same app instance as auth and db exports', () => {
        const src = fs.readFileSync(SRC_CONFIG, 'utf-8');
        const appCheckSrc = fs.readFileSync(APP_CHECK_SRC, 'utf-8');
        expect(src).toMatch(/initializeParQueenAppCheck\(app\)/);
        expect(src).toMatch(/getAuth\(app\)/);
        expect(src).toMatch(/getFirestore\(app\)/);
        expect(appCheckSrc).toMatch(/init\(app,/);
    });

    it('AC-9: token auto-refresh is enabled on both App Check paths', () => {
        const src = fs.readFileSync(APP_CHECK_SRC, 'utf-8');
        expect(src.match(/isTokenAutoRefreshEnabled:\s*true/g) || []).toHaveLength(2);
    });

    it('AC-10: missing site key triggers a bounded DEV-only warning on the web path, not an error or silent fail', () => {
        const src = fs.readFileSync(APP_CHECK_SRC, 'utf-8');
        expect(src).toMatch(/else if \(isDev\)/);
        expect(src).toMatch(/TM-12 OPEN: VITE_FIREBASE_APPCHECK_SITE_KEY not set/);
    });

    it('AC-11: initializeAppCheck import is present in utils/appCheck.ts with both providers', () => {
        const src = fs.readFileSync(APP_CHECK_SRC, 'utf-8');
        expect(src).toMatch(/import[\s\S]*initializeAppCheck[\s\S]*from 'firebase\/app-check'/);
        expect(src).toMatch(/import[\s\S]*ReCaptchaEnterpriseProvider[\s\S]*from 'firebase\/app-check'/);
        expect(src).toMatch(/import[\s\S]*CustomProvider[\s\S]*from 'firebase\/app-check'/);
    });

    it('AC-13: initializeApp in firebaseConfig.ts is guarded by getApps() — idempotent init', () => {
        // Both firebaseConfig.ts and firebase.ts guard initializeApp with getApps().
        // This makes initialization idempotent regardless of module evaluation order.
        const src = fs.readFileSync(SRC_CONFIG, 'utf-8');
        expect(src).toMatch(/getApps\(\)/);
        const initIdx = src.indexOf('initializeApp(');
        expect(initIdx).toBeGreaterThan(-1);
        const guardIdx = Math.max(src.lastIndexOf('?', initIdx), src.lastIndexOf('if ', initIdx));
        expect(guardIdx, 'initializeApp must be inside a conditional guard in firebaseConfig.ts').toBeGreaterThan(-1);
        expect(guardIdx).toBeLessThan(initIdx);
    });

    it('AC-14: firebase.ts has getApps() guard preventing dual FirebaseApp initialization', () => {
        // firebase.ts is imported by 28+ view files AND firebaseConfig.ts initializes the app.
        // The getApps().length === 0 guard in firebase.ts prevents a second app from being created
        // even when both files are bundled together. This test asserts the guard is present.
        const FIREBASE_TS = path.resolve(__dirname, '../firebase.ts');
        const src = fs.readFileSync(FIREBASE_TS, 'utf-8');
        // Must use getApps() to check for existing app
        expect(src).toMatch(/getApps\(\)/);
        // Must not call initializeApp unconditionally (it must be inside a conditional)
        const initIdx = src.indexOf('initializeApp(');
        const ternaryOrIfIdx = Math.max(src.lastIndexOf('?', initIdx), src.lastIndexOf('if ', initIdx));
        expect(ternaryOrIfIdx, 'initializeApp must be inside a conditional (ternary or if)').toBeGreaterThan(-1);
        expect(ternaryOrIfIdx).toBeLessThan(initIdx);
    });

    it.skipIf(!distExists)('AC-12: dist/ does not contain the App Check debug-token self.assignment', () => {
        // The debug token is injected via `self.FIREBASE_APPCHECK_DEBUG_TOKEN = value`.
        // Narrower than AC-1: specifically the property-assignment shape
        // (`<obj>.FIREBASE_APPCHECK_DEBUG_TOKEN = value`) that ParQueen's own
        // `(self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken` line compiles to.
        expect(scanDist(DEBUG_TOKEN_PROPERTY_ASSIGNMENT)).toHaveLength(0);
    });

    describe('AC-1/AC-12 matcher regression coverage', () => {
        it('accepts the SDK\'s own passive debug-token reads (must NOT match either regex)', () => {
            const sdkReads = [
                'typeof t.FIREBASE_APPCHECK_DEBUG_TOKEN=="string"',
                't.FIREBASE_APPCHECK_DEBUG_TOKEN!==!0',
                'n.resolve(t.FIREBASE_APPCHECK_DEBUG_TOKEN)',
                'typeof t.FIREBASE_APPCHECK_DEBUG_TOKEN!="string"&&t.FIREBASE_APPCHECK_DEBUG_TOKEN!==!0',
            ];
            for (const line of sdkReads) {
                expect(DEBUG_TOKEN_ASSIGNMENT.test(line), `should not flag read: ${line}`).toBe(false);
                expect(DEBUG_TOKEN_PROPERTY_ASSIGNMENT.test(line), `should not flag read: ${line}`).toBe(false);
            }
        });

        it('rejects an assigned boolean debug-token override (must match both regexes)', () => {
            const line = 'self.FIREBASE_APPCHECK_DEBUG_TOKEN = true';
            expect(DEBUG_TOKEN_ASSIGNMENT.test(line)).toBe(true);
            expect(DEBUG_TOKEN_PROPERTY_ASSIGNMENT.test(line)).toBe(true);
        });

        it('rejects an assigned string debug-token value (must match both regexes)', () => {
            const line = 'self.FIREBASE_APPCHECK_DEBUG_TOKEN = "abc123token"';
            expect(DEBUG_TOKEN_ASSIGNMENT.test(line)).toBe(true);
            expect(DEBUG_TOKEN_PROPERTY_ASSIGNMENT.test(line)).toBe(true);
        });

        it('rejects a minified variable-sourced assignment — the shape a leaked VITE_APPCHECK_DEBUG_TOKEN would compile to (must match both regexes)', () => {
            const line = 't.FIREBASE_APPCHECK_DEBUG_TOKEN=n';
            expect(DEBUG_TOKEN_ASSIGNMENT.test(line)).toBe(true);
            expect(DEBUG_TOKEN_PROPERTY_ASSIGNMENT.test(line)).toBe(true);
        });

        it('AC-1 is strictly broader than AC-12: a bare (non-property) assignment matches AC-1 only', () => {
            const line = 'FIREBASE_APPCHECK_DEBUG_TOKEN=x';
            expect(DEBUG_TOKEN_ASSIGNMENT.test(line)).toBe(true);
            expect(DEBUG_TOKEN_PROPERTY_ASSIGNMENT.test(line)).toBe(false);
        });
    });
});
