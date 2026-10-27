import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as esm from './commitToHeadingDecision';

// Node require() path used by the Functions integration tests: the .cjs wrapper
// must expose the same two functions from the single ES module implementation.
const requireCjs = createRequire(import.meta.url);
const cjs = requireCjs('./commitToHeadingDecision.cjs');

const uid = 'claimer-1';
const cases = [
  [{ status: 'interested', interestedUserId: uid, claimState: 'committed' }, uid],
  [{ status: 'interested', interestedUserId: uid, claimState: 'heading' }, uid],
  [{ status: 'available', interestedUserId: null, claimState: null }, uid],
  [{ status: 'interested', interestedUserId: null, claimState: null }, uid],
  [{ status: 'interested', interestedUserId: 'someone-else', claimState: 'committed' }, uid],
  [null, uid],
  [{ status: 'interested', interestedUserId: uid, claimState: 'committed' }, ''],
] as const;

describe('commitToHeadingDecision module formats', () => {
  it('require() exposes both functions with the same behavior as the ES module', () => {
    expect(typeof cjs.decideCommitToHeading).toBe('function');
    expect(typeof cjs.buildHeadingUpdate).toBe('function');
    for (const [spot, who] of cases) {
      expect(cjs.decideCommitToHeading(spot, who)).toBe(esm.decideCommitToHeading(spot as any, who));
    }
    expect(cjs.decideCommitToHeading(cases[0][0], uid)).toBe('commit');
    expect(cjs.decideCommitToHeading(cases[1][0], uid)).toBe('already_heading');
    expect(cjs.decideCommitToHeading(cases[2][0], uid)).toBe('rejected');
    expect(cjs.buildHeadingUpdate(7, 'expiry')).toEqual(esm.buildHeadingUpdate(7, 'expiry'));
  });

  it('keeps one browser-safe implementation and a logic-free CommonJS wrapper', () => {
    const impl = readFileSync('utils/commitToHeadingDecision.mjs', 'utf8');
    const wrapper = readFileSync('utils/commitToHeadingDecision.cjs', 'utf8');
    expect(impl).not.toMatch(/^\s*module\.exports|\brequire\(\s*['"]/m);
    expect(impl).toMatch(/export function decideCommitToHeading\(/);
    expect(impl).toMatch(/export function buildHeadingUpdate\(/);
    expect(wrapper).toMatch(/module\.exports = require\('\.\/commitToHeadingDecision\.mjs'\);/);
    expect(wrapper).not.toMatch(/function /);
    // A CommonJS .js here is what the Vite dev server served untransformed (DEV-001).
    expect(existsSync('utils/commitToHeadingDecision.js')).toBe(false);
  });
});
