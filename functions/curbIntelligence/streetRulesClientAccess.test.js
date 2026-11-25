import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { STREET_RULES_CLIENTS } = require('./streetRulesClientAccess');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('streetRules client access inventory', () => {
  it('names every direct reader and keeps the production rules public', () => {
    const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
    expect(rules).toMatch(/match \/streetRules\/\{ruleId\} \{\s*allow read: if true;/);
    expect(rules).toMatch(/match \/\{path=\*\*\}\/streetRules\/\{ruleId\} \{\s*allow read: if true;/);
    const ids = STREET_RULES_CLIENTS.map(client => client.id);
    expect(ids).toEqual([
      'map-nearest-segment',
      'my-car-fallback',
      'parking-check-fallback',
      'saved-spot-open',
      'legacy-my-car',
      'legacy-parking-check',
      'admin-segment-list',
      'admin-health',
      'callable-persistence',
    ]);
    const read = (file) => readFileSync(path.join(root, file), 'utf8');
    const card = read('views/street-parking/StreetIntelligenceCard.tsx');
    const parking = read('views/assistant/ParkingCheckTool.tsx');
    const map = read('views/StreetParkingView.tsx');
    const health = read('views/admin/StreetIntelligenceHealthPage.tsx');
    const admin = read('views/admin/StreetSegmentsPage.tsx');
    const legacyCard = read('views/street-parking/legacy8650f23/StreetIntelligenceCard.tsx');
    const legacyParking = read('views/assistant/legacy8650f23/ParkingCheckTool.tsx');
    const persistence = read('functions/curbIntelligence/canonicalCurbPersistence.js');
    expect(card).toContain("collection(db, 'streetSegments', segmentId, 'streetRules')");
    expect(parking).toContain("collection(db, 'streetSegments', spot.segmentId, 'streetRules')");
    expect(map).toContain("collection(db, 'streetSegments')");
    expect(map).toContain('savedSpot.curbProtocolVersion === 2');
    expect(health).toContain("collectionGroup(db!, 'streetRules')");
    expect(admin).toContain("collection(db, 'streetSegments', seg.id, 'streetRules')");
    expect(legacyCard).toContain("collection(db, 'streetSegments', segmentId, 'streetRules')");
    expect(legacyParking).toContain("collection(db, 'streetSegments', spot.segmentId, 'streetRules')");
    expect(persistence).toContain('streetSegments/${key}/streetRules');
  });
});
