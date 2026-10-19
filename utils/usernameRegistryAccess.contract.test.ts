/**
 * F8 contract: firestore.rules allows only exact-doc `get` on usernames/{id}
 * (list/query denied). This static test pins every client reader of the
 * registry to single-document getDoc so a future list/query regression is
 * caught before it ships as a runtime permission-denied.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'functions', 'dist', 'android', 'ios', 'e2e', '.git', 'scripts', 'docs']);

function clientSources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) clientSources(full, out);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
}

const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('F8 — usernames registry client access is exact-doc get only', () => {
    it('NameEntryView checks availability with getDoc(doc(db, "usernames", norm))', () => {
        expect(read('views/NameEntryView.tsx')).toMatch(/getDoc\(\s*doc\(\s*db\s*,\s*['"]usernames['"]\s*,\s*norm\s*\)\s*\)/);
    });

    it('EditProfileView checks availability with getDoc(doc(db, "usernames", ...))', () => {
        expect(read('views/EditProfileView.tsx')).toMatch(/getDoc\(\s*doc\(\s*db\s*,\s*['"]usernames['"]\s*,/);
    });

    it('no client source lists or queries the usernames collection', () => {
        const offenders = clientSources(ROOT).filter((f) =>
            /collection\(\s*[\w!.]+\s*,\s*['"]usernames['"]/.test(readFileSync(f, 'utf8')));
        expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
    });
});
