'use strict';

const slice = (line, from, to) => line.slice(from - 1, to).trim();
const nullable = value => value || null;

function validSource(source) {
  return source && source.datasetId === 'w4v2-rv6b'
    && typeof source.release === 'string' && Boolean(source.release.trim())
    && typeof source.archiveSha256 === 'string' && /^[a-f0-9]{64}$/i.test(source.archiveSha256);
}

function codeParts(b10sc) {
  if (!/^\d{11}$/.test(b10sc)) return null;
  return {
    b5sc: b10sc.slice(0, 6),
    b7sc: b10sc.slice(0, 8),
    b10sc,
    localGroup: b10sc.slice(6, 8),
  };
}

function parseProgenitor(line, firstWordPosition, featurePosition, b10Position, topologyPosition) {
  const b10sc = slice(line, b10Position, b10Position + 10);
  const codes = codeParts(b10sc);
  if (!codes) return null;
  return {
    firstWord: nullable(slice(line, firstWordPosition, firstWordPosition)),
    geographicFeatureType: nullable(slice(line, featurePosition, featurePosition)),
    ...codes,
    horizontalTopology: nullable(slice(line, topologyPosition, topologyPosition)),
  };
}

function parseSndCowRecord(line, ordinal, source) {
  if (typeof line !== 'string' || line.length !== 200) {
    return { ok: false, reason: 'invalid_record_length', ordinal };
  }
  if (!Number.isInteger(ordinal) || ordinal < 0 || !validSource(source)) {
    return { ok: false, reason: 'invalid_record_provenance', ordinal };
  }
  if (line.startsWith('0000SND')) {
    return {
      ok: true,
      record: {
        ordinal,
        recordType: 'HEADER',
        key: slice(line, 1, 8),
        createdYyMmDd: slice(line, 9, 14),
        release: slice(line, 15, 18),
        declaredRecordCount: Number(slice(line, 19, 26)),
        source: { ...source },
      },
    };
  }
  if (line[0] !== '1' || !/^[1-5]$/.test(line[1])) {
    return { ok: false, reason: 'invalid_record_key', ordinal };
  }

  const sourceNativeName = slice(line, 3, 34);
  if (!sourceNativeName) return { ok: false, reason: 'invalid_record_key', ordinal };
  const geographicFeatureType = nullable(slice(line, 51, 51));
  const common = {
    ordinal,
    key: slice(line, 1, 34),
    borough: line[1],
    sourceNativeName,
    geographicFeatureType,
    numericNameIndicator: nullable(slice(line, 50, 50)),
    source: { ...source },
  };

  if (geographicFeatureType === 'S') {
    const count = Number(slice(line, 54, 54));
    if (count !== 1 && count !== 2) return { ok: false, reason: 'invalid_progenitor_count', ordinal };
    const progenitors = [parseProgenitor(line, 55, 56, 57, 68)];
    if (count === 2) progenitors.push(parseProgenitor(line, 71, 72, 73, 84));
    if (progenitors.some(value => !value)) return { ok: false, reason: 'invalid_progenitor_code', ordinal };
    return { ok: true, record: { ...common, recordType: 'S', progenitors } };
  }

  const b10sc = slice(line, 37, 47);
  const codes = codeParts(b10sc);
  if (!codes) return { ok: false, reason: 'invalid_street_code', ordinal };
  return {
    ok: true,
    record: {
      ...common,
      recordType: 'DATA',
      ...codes,
      primaryNameFlag: nullable(slice(line, 35, 35)),
      principalNameFlag: nullable(slice(line, 36, 36)),
      preferredNameFlag: null,
      horizontalTopology: nullable(slice(line, 108, 108)),
    },
  };
}

function provenance(record) {
  const fields = ['ordinal', 'recordType', 'key', 'borough', 'b5sc', 'b7sc', 'b10sc', 'localGroup',
    'primaryNameFlag', 'principalNameFlag', 'preferredNameFlag', 'geographicFeatureType', 'horizontalTopology', 'source'];
  return Object.fromEntries(fields.filter(field => record[field] !== undefined).map(field => [field, record[field]]));
}

function buildOfficialAliasIndex(records) {
  const byB7sc = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || !record.sourceNativeName) continue;
    if (record.recordType === 'DATA' && record.b7sc) {
      if (!byB7sc.has(record.b7sc)) byB7sc.set(record.b7sc, []);
      byB7sc.get(record.b7sc).push({
        sourceNativeName: record.sourceNativeName,
        relationship: 'same_official_local_group',
        provenance: provenance(record),
      });
    } else if (record.recordType === 'S') {
      for (const progenitor of record.progenitors || []) {
        if (!byB7sc.has(progenitor.b7sc)) byB7sc.set(progenitor.b7sc, []);
        byB7sc.get(progenitor.b7sc).push({
          sourceNativeName: record.sourceNativeName,
          relationship: 'front_truncated_progenitor',
          provenance: { ...provenance(record), progenitor: { ...progenitor } },
        });
      }
    }
  }
  for (const values of byB7sc.values()) {
    values.sort((a, b) => a.sourceNativeName.localeCompare(b.sourceNativeName)
      || a.provenance.ordinal - b.provenance.ordinal);
  }
  return { byB7sc };
}

function lookupOfficialAliases(index, query) {
  if (!query || !/^\d{6}$/.test(query.b5sc || '') || !query.b7sc) {
    return { ok: false, reason: 'official_alias_relationship_incomplete' };
  }
  if (!/^\d{8}$/.test(query.b7sc) || !query.b7sc.startsWith(query.b5sc)) {
    return { ok: false, reason: 'official_alias_relationship_incomplete' };
  }
  const relationships = index?.byB7sc?.get(query.b7sc);
  if (!relationships?.length) return { ok: false, reason: 'official_alias_missing' };
  return { ok: true, relationships: relationships.map(item => ({ ...item, provenance: { ...item.provenance } })) };
}

module.exports = { parseSndCowRecord, buildOfficialAliasIndex, lookupOfficialAliases };
