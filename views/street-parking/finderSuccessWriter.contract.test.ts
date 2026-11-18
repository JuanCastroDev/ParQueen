import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const legacyFinderSuccessWriter = ['complete', 'FinderConfirmed', 'Handoff'].join('');
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const skippedDirs = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'Pods',
  'build',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (skippedDirs.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    const dot = entry.lastIndexOf('.');
    if (dot >= 0 && sourceExtensions.has(entry.slice(dot))) out.push(full);
  }
  return out;
}

function read(rel: string) {
  return readFileSync(join(root, rel), 'utf8');
}

describe('finder success writer contract', () => {
  it('no live source still names the legacy finder success writer', () => {
    const hits = walk(root)
      .filter((file) => readFileSync(file, 'utf8').includes(legacyFinderSuccessWriter))
      .map((file) => relative(root, file));
    expect(hits).toEqual([]);
  });

  it('the live client exposes no finder confirmation writer or mandatory confirmation UI', () => {
    const flow = read('views/street-parking/useInterestFlow.ts');
    const writer = read('views/street-parking/attestParticipantSuccess.ts');
    const builder = read('utils/spotFeedback.ts');
    const terminal = read('views/street-parking/completeTerminalHandoff.ts');
    const spotCard = read('views/street-parking/SpotDetailsCard.tsx');
    expect(flow).not.toContain('submitFinderAttestation');
    expect(flow).not.toContain('handleFinderConfirmsArrival');
    expect(flow).not.toContain('finderPendingHandoff');
    expect(spotCard).not.toContain('t(\'claim_flow.driver_arrived\')');
    expect(writer).toContain('buildParticipantSuccessAttestation');
    expect(writer).toMatch(/setDoc\(feedbackRef,\s*feedback\)/);
    expect(writer).not.toMatch(/setDoc\([^)]*merge\s*:/);
    expect(writer).not.toMatch(/outcome:\s*['"]success['"]/);
    expect(builder).toContain("outcome: 'participant_success' as const");
    expect(builder).not.toMatch(/outcome:\s*['"]success['"]/);
    expect(terminal).not.toContain(legacyFinderSuccessWriter);
  });
});
