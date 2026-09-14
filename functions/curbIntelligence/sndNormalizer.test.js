import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseSndCowRecord, buildOfficialAliasIndex, lookupOfficialAliases } = require('./sndNormalizer');
const snd26b = require('./fixtures/snd26bAliasFixtures');

const put = (line, from, to, value) => `${line.slice(0, from - 1)}${String(value).padEnd(to - from + 1).slice(0, to - from + 1)}${line.slice(to)}`;
function dataLine({ name, primary = 'V', principal = 'S', b10sc, featureType = ' ', horizontal = ' ' }) {
  let line = ' '.repeat(200);
  line = put(line, 1, 1, '1');
  line = put(line, 2, 2, b10sc[0]);
  line = put(line, 3, 34, name);
  line = put(line, 35, 35, primary);
  line = put(line, 36, 36, principal);
  line = put(line, 37, 47, b10sc);
  line = put(line, 51, 51, featureType);
  line = put(line, 54, 85, name);
  line = put(line, 108, 108, horizontal);
  return line;
}

function truncatedLine({ name, progenitorB10sc, firstWord = 'E' }) {
  let line = ' '.repeat(200);
  line = put(line, 1, 1, '1');
  line = put(line, 2, 2, progenitorB10sc[0]);
  line = put(line, 3, 34, name);
  line = put(line, 51, 51, 'S');
  line = put(line, 54, 54, '1');
  line = put(line, 55, 55, firstWord);
  line = put(line, 57, 67, progenitorB10sc);
  return line;
}

const source = { datasetId: 'w4v2-rv6b', release: '26b', archiveSha256: 'a'.repeat(64) };

describe('SND COW normalization', () => {
  it('retains record-level provenance for ordinary and front-truncated records', () => {
    const ordinary = parseSndCowRecord(dataLine({
      name: 'AVENUE OF THE AMERICAS', primary: 'P', principal: 'F', b10sc: '10000101000', horizontal: 'R',
    }), 17, source);
    expect(ordinary.ok).toBe(true);
    expect(ordinary.record).toMatchObject({
      ordinal: 17, recordType: 'DATA', key: '11AVENUE OF THE AMERICAS', borough: '1',
      sourceNativeName: 'AVENUE OF THE AMERICAS', b5sc: '100001', b7sc: '10000101',
      b10sc: '10000101000', localGroup: '01', primaryNameFlag: 'P', principalNameFlag: 'F',
      horizontalTopology: 'R', source,
    });
    expect(ordinary.record.preferredNameFlag).toBeNull();

    const truncated = parseSndCowRecord(truncatedLine({
      name: '170 STREET', progenitorB10sc: '21234502000', firstWord: 'E',
    }), 18, source);
    expect(truncated.record).toMatchObject({ ordinal: 18, recordType: 'S', sourceNativeName: '170 STREET' });
    expect(truncated.record.progenitors[0]).toEqual({
      firstWord: 'E', geographicFeatureType: null, b5sc: '212345', b7sc: '21234502',
      b10sc: '21234502000', localGroup: '02', horizontalTopology: null,
    });
  });

  it('builds aliases only from exact official local-group or progenitor relationships', () => {
    const records = [
      dataLine({ name: 'AVENUE OF THE AMERICAS', primary: 'P', principal: 'F', b10sc: '10000101000' }),
      dataLine({ name: '6 AVENUE', b10sc: '10000101001' }),
      dataLine({ name: '6 AVENUE SERVICE ROAD', b10sc: '10000102000', horizontal: 'R' }),
      dataLine({ name: 'SIXTH AVENUE', b10sc: '10000201000' }),
    ].map((line, index) => parseSndCowRecord(line, index + 1, source).record);
    const index = buildOfficialAliasIndex(records);
    const result = lookupOfficialAliases(index, { b5sc: '100001', b7sc: '10000101' });
    expect(result.ok).toBe(true);
    expect(result.relationships.map(item => item.sourceNativeName)).toEqual(['6 AVENUE', 'AVENUE OF THE AMERICAS']);
    expect(result.relationships.every(item => item.provenance.ordinal > 0)).toBe(true);
    expect(result.relationships.map(item => item.sourceNativeName)).not.toContain('6 AVENUE SERVICE ROAD');
    expect(result.relationships.map(item => item.sourceNativeName)).not.toContain('SIXTH AVENUE');
  });

  it('fails closed without an exact official local group', () => {
    const record = parseSndCowRecord(dataLine({ name: 'LA GUARDIA PLACE', b10sc: '10000301000' }), 1, source).record;
    const index = buildOfficialAliasIndex([record]);
    expect(lookupOfficialAliases(index, { b5sc: '100003' })).toEqual({ ok: false, reason: 'official_alias_relationship_incomplete' });
    expect(lookupOfficialAliases(index, { b5sc: '100004', b7sc: '10000401' })).toEqual({ ok: false, reason: 'official_alias_missing' });
  });

  it.each([
    ['short', 'invalid_record_length'],
    [' '.repeat(200), 'invalid_record_key'],
  ])('rejects malformed COW records', (line, reason) => {
    expect(parseSndCowRecord(line, 1, source)).toEqual({ ok: false, reason, ordinal: 1 });
  });

  it('keeps release identity separate from the locally computed archive digest', () => {
    const parsed = parseSndCowRecord(dataLine({ name: 'GOLD STREET', b10sc: '10000501000' }), 3, source);
    expect(parsed.record.source.release).toBe('26b');
    expect(parsed.record.source.archiveSha256).toBe('a'.repeat(64));
    expect(parsed.record.source).not.toHaveProperty('publishedChecksum');
  });

  it('preserves official SND 26b provenance and groups only real local-group aliases', () => {
    const parsedHeader = parseSndCowRecord(snd26b.header.cowRecord, snd26b.header.ordinal, snd26b.source);
    expect(parsedHeader.record).toMatchObject({
      recordType: 'HEADER', createdYyMmDd: '260417', release: '26B', declaredRecordCount: 121550,
    });
    expect(snd26b.source).toEqual({
      datasetId: 'w4v2-rv6b',
      release: '26b',
      archiveSha256: '545e3d7145f397f92cf251a63505ae668658a72ef68f8c0465b0a8e6d599f470',
    });

    const records = snd26b.records.map(({ ordinal, cowRecord }) => {
      const parsed = parseSndCowRecord(cowRecord, ordinal, snd26b.source);
      expect(parsed.ok).toBe(true);
      return parsed.record;
    });
    const index = buildOfficialAliasIndex(records);

    expect(lookupOfficialAliases(index, { b5sc: '110510', b7sc: '11051001' })
      .relationships.map(item => item.sourceNativeName))
      .toEqual(['6 AVENUE', 'AVENUE OF THE AMERICAS']);
    expect(lookupOfficialAliases(index, { b5sc: '110510', b7sc: '11051002' })
      .relationships.map(item => item.sourceNativeName))
      .toEqual(['6 AVENUE NORTHBOUND ROADBED']);
    expect(lookupOfficialAliases(index, { b5sc: '110510', b7sc: '11051003' })
      .relationships.map(item => item.sourceNativeName))
      .toEqual(['6 AVENUE SOUTHBOUND ROADBED']);
    expect(lookupOfficialAliases(index, { b5sc: '103802', b7sc: '10380201' })
      .relationships.map(item => item.sourceNativeName))
      .toEqual(['CAMP LA GUARDIA ROAD', 'CAMP LAGUARDIA ROAD']);
    expect(lookupOfficialAliases(index, { b5sc: '121190', b7sc: '12119001' })
      .relationships.map(item => item.sourceNativeName))
      .toEqual(['FORT WASHINGTON AVENUE']);

    const america = records.find(record => record.sourceNativeName === 'AVENUE OF THE AMERICAS');
    expect(america).toMatchObject({
      ordinal: 1886,
      recordType: 'DATA',
      key: '11AVENUE OF THE AMERICAS',
      borough: '1',
      b5sc: '110510',
      b7sc: '11051001',
      b10sc: '11051001030',
      localGroup: '01',
      primaryNameFlag: 'P',
      principalNameFlag: 'F',
      preferredNameFlag: null,
      source: snd26b.source,
    });
  });
});
