'use strict';

const VERSION_FIELDS = Object.freeze(['resourceId', 'rowsUpdatedAt', 'viewLastModified']);

function validTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function createSocrataSourceVersion(metadata, expectedResourceId) {
  if (!metadata || metadata.resourceId !== expectedResourceId) {
    return { ok: false, reason: 'resource_mismatch' };
  }
  if (!validTimestamp(metadata.rowsUpdatedAt) || !validTimestamp(metadata.viewLastModified)) {
    return { ok: false, reason: 'invalid_source_version' };
  }
  return {
    ok: true,
    sourceVersion: Object.fromEntries(VERSION_FIELDS.map(field => [field, metadata[field]])),
  };
}

function sameVersion(left, right) {
  return VERSION_FIELDS.every(field => left?.[field] === right?.[field]);
}

function createMemoryRuleCandidateStore(records, options = {}) {
  const source = createSocrataSourceVersion(options.sourceVersion, options.resourceId);
  const sourceVersion = source.ok ? source.sourceVersion : null;
  const maxCandidates = Number.isInteger(options.maxCandidates) && options.maxCandidates > 0
    ? options.maxCandidates : 100;
  const values = Array.isArray(records) ? [...records] : [];
  return {
    async queryCandidates(query) {
      if (!sourceVersion || typeof query?.matches !== 'function') {
        return {
          candidates: [],
          completeness: { state: 'INCOMPLETE', reason: 'invalid_query' },
          sourceVersion,
        };
      }
      const matching = values.filter(query.matches);
      const limited = matching.slice(0, maxCandidates);
      const reason = options.coverageComplete !== true ? 'coverage_gap'
        : matching.length > maxCandidates ? 'candidate_limit_reached' : null;
      return {
        candidates: limited,
        completeness: { state: reason ? 'INCOMPLETE' : 'COMPLETE', reason },
        sourceVersion,
      };
    },
  };
}

async function readConsistentCandidateSnapshot(source, query) {
  if (!source || typeof source.getMetadata !== 'function'
    || typeof source.readCandidates !== 'function' || typeof query?.resourceId !== 'string') {
    return { ok: false, reason: 'invalid_source_adapter' };
  }
  const before = createSocrataSourceVersion(await source.getMetadata(), query.resourceId);
  if (!before.ok) return before;
  const result = await source.readCandidates(query);
  if (!result || !Array.isArray(result.rows)) return { ok: false, reason: 'invalid_source_response' };
  const after = createSocrataSourceVersion(await source.getMetadata(), query.resourceId);
  if (!after.ok) return after;
  if (!sameVersion(before.sourceVersion, after.sourceVersion)) {
    return { ok: false, reason: 'source_changed_during_read' };
  }
  return {
    ok: true,
    candidates: result.rows,
    completeness: {
      state: result.truncated === true ? 'INCOMPLETE' : 'COMPLETE',
      reason: result.truncated === true ? 'source_query_truncated' : null,
    },
    sourceVersion: before.sourceVersion,
  };
}

module.exports = {
  createMemoryRuleCandidateStore,
  createSocrataSourceVersion,
  readConsistentCandidateSnapshot,
};
