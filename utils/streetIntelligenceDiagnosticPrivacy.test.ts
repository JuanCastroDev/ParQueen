import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '..');
const parkingView = readFileSync(resolve(root, 'views/StreetParkingView.tsx'), 'utf8');
const card = readFileSync(resolve(root, 'views/street-parking/StreetIntelligenceCard.tsx'), 'utf8');

function diagnosticStatements(source: string) {
  return source.split('\n').filter(line => /console\.(?:log|warn|error)|\b(?:dbg|cdbg)\(/.test(line)).join('\n');
}

describe('Street Intelligence client diagnostic privacy', () => {
  it('does not emit precise locations, identities, raw payloads, or street/schedule details', () => {
    const diagnostics = diagnosticStatements(`${parkingView}\n${card}`);
    for (const forbidden of [
      'userLat', 'userLng', 'savedSpot coordinates', 'JSON.stringify(data)',
      'segmentStreetName', 'streetName:', 'c.streetName', 'nearest.id', 'segmentId:',
      'restrictionVersionId:', 'scheduleDescription=', 'JSON.stringify(s.days)',
      'console.warn(\'StreetIntelligenceCard load error:\', e)',
      'console.warn(\'Segment match failed:\', e)',
    ]) {
      expect(diagnostics).not.toContain(forbidden);
    }
    expect(diagnostics).not.toMatch(/console\.(?:log|warn|error)\([^\n;]*,\s*(?:e|err|error)\s*\)/);
  });
});
