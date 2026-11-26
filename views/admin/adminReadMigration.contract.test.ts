import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// AC-14 — source-contract supplement to the behavioral tests in
// DashboardPage.test.tsx / UsersPage.test.tsx / ReportsPage.test.tsx /
// AuditLogPage.test.tsx / PingsPage.test.tsx / ParseFailuresPage.test.tsx.
// Those tests prove each page actually calls its adminReadView-backed
// service function; this proves none of the six migrated pages (plus
// StreetIntelligenceHealthPage, whose protected counts come from the admin view) still
// contains a direct Firestore SDK call against a now-protected collection.

const root = process.cwd();
const readView = (path: string) => readFileSync(resolve(root, path), 'utf-8');

const PROTECTED_COLLECTIONS = [
  'users', 'reports', 'adminAuditLog', 'parkingSessions', 'parseFailures',
  'private', 'stats', 'adminBootstrap',
];

const DIRECT_FIRESTORE_CALLS = /\b(getDoc|getDocs|onSnapshot|collectionGroup|collection|addDoc|setDoc|updateDoc|deleteDoc|writeBatch|runTransaction)\s*\(/;

const MIGRATED_PAGES = [
  'views/DashboardPage.tsx',
  'views/UsersPage.tsx',
  'views/admin/ReportsPage.tsx',
  'views/admin/AuditLogPage.tsx',
  'views/admin/PingsPage.tsx',
  'views/admin/ParseFailuresPage.tsx',
  'views/admin/StreetIntelligenceHealthPage.tsx',
];

describe('AC-14 — no migrated admin page performs direct Firestore access for protected datasets', () => {
  for (const page of MIGRATED_PAGES) {
    it(`${page} contains no direct Firestore SDK call at all`, () => {
      const src = readView(page);
      // These six pages no longer need ANY direct Firestore access for
      // their protected data — every read goes through adminReadView.
      // StreetIntelligenceHealthPage is the one exception: it still reads
      // streetSegments directly, which is intentionally public
      // (allow read: if true) — see its own dedicated check below.
      if (page !== 'views/admin/StreetIntelligenceHealthPage.tsx') {
        expect(src).not.toMatch(DIRECT_FIRESTORE_CALLS);
        // A type-only import (erased at build time, grants no runtime
        // capability) is fine — e.g. `import type { Timestamp } from
        // 'firebase/firestore'` for local type annotations. A runtime
        // import of the module is not.
        expect(src).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+['"]firebase\/firestore['"]/m);
      }
    });
  }

  it('StreetIntelligenceHealthPage.tsx reads public streetSegments directly and schedule counts through the admin view', () => {
    const src = readView('views/admin/StreetIntelligenceHealthPage.tsx');
    expect(src).toMatch(/collection\(db!?,\s*['"]streetSegments['"]\)/);
    expect(src).not.toMatch(/collectionGroup\(db!?,\s*['"]streetRules['"]\)/);
    expect(src).toMatch(/fetchStreetIntelligenceHealth/);
    for (const name of PROTECTED_COLLECTIONS) {
      expect(src).not.toMatch(new RegExp(`collection\\(db!?,\\s*['"]${name}['"]`));
    }
    // parseFailures count now comes from fetchDashboardCounts, not a direct query.
    expect(src).toMatch(/fetchDashboardCounts/);
  });

  it('every migrated page imports its data from utils/adminReadService', () => {
    for (const page of MIGRATED_PAGES) {
      const src = readView(page);
      expect(src).toMatch(/from ['"].*utils\/adminReadService['"]/);
    }
  });
});
