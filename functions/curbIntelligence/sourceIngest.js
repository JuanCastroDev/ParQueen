'use strict';

const { createHash } = require('crypto');
const { normalizeCsclRow } = require('./csclNormalizer');
const { parseSndCowRecord } = require('./sndNormalizer');
const { extractSndCowLines } = require('./sndArchive');

const PINNED_SND_RELEASE = '26b';

const sameMetadata = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function createStats() {
  return { read: 0, accepted: 0, rejected: 0, rejectionReasons: {} };
}

function rejected(stats, reason) {
  stats.rejected += 1;
  stats.rejectionReasons[reason] = (stats.rejectionReasons[reason] || 0) + 1;
}

async function readAllPages(source, pageSize, orderBy, consume) {
  let offset = 0;
  while (true) {
    const rows = await source.readPage({ offset, limit: pageSize, orderBy });
    if (!Array.isArray(rows)) throw new Error('invalid_source_page');
    rows.forEach((row, index) => consume(row, offset + index));
    offset += rows.length;
    if (rows.length < pageSize) break;
  }
}

async function ingestCsclSource(source, options = {}) {
  const pageSize = options.pageSize || 1000;
  const before = await source.getMetadata();
  if (!before || before.resourceId !== 'inkn-q76z' || !before.version) {
    return { ok: false, reason: 'invalid_source_version' };
  }
  const stats = createStats();
  const records = [];
  await readAllPages(source, pageSize, ':id', row => {
    stats.read += 1;
    const normalized = normalizeCsclRow(row, before);
    if (!normalized.ok) return rejected(stats, normalized.reason);
    stats.accepted += 1;
    records.push(normalized.record);
  });
  const after = await source.getMetadata();
  if (!sameMetadata(before, after)) return { ok: false, reason: 'source_changed_during_ingest' };
  return { ok: true, sourceVersion: { ...before }, records, stats };
}

async function ingestSndSource(source, options = {}) {
  const before = await source.getMetadata();
  if (!before || before.datasetId !== 'w4v2-rv6b' || typeof before.release !== 'string' || !before.release.trim()) {
    return { ok: false, reason: 'invalid_source_version' };
  }
  const expectedRelease = options.expectedRelease || PINNED_SND_RELEASE;
  if (before.release.trim().toLowerCase() !== expectedRelease.toLowerCase()) {
    return { ok: false, reason: 'unexpected_snd_release', expected: expectedRelease, actual: before.release.trim() };
  }
  const archiveBytes = await source.readArchiveBytes();
  if (!Buffer.isBuffer(archiveBytes) && !(archiveBytes instanceof Uint8Array)) {
    return { ok: false, reason: 'invalid_archive_bytes' };
  }
  const sourceIdentity = {
    datasetId: 'w4v2-rv6b',
    release: before.release.trim(),
    archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
  };
  const extracted = extractSndCowLines(archiveBytes);
  if (!extracted.ok) return extracted;
  const stats = createStats();
  const records = [];
  let firstRecordFailure = null;
  extracted.lines.forEach((line, ordinal) => {
    stats.read += 1;
    const normalized = parseSndCowRecord(line, ordinal, sourceIdentity);
    if (!normalized.ok) {
      rejected(stats, normalized.reason);
      if (!firstRecordFailure) firstRecordFailure = normalized;
      return;
    }
    stats.accepted += 1;
    records.push(normalized.record);
  });
  const after = await source.getMetadata();
  if (!sameMetadata(before, after)) return { ok: false, reason: 'source_changed_during_ingest' };
  if (firstRecordFailure) {
    return {
      ok: false,
      reason: 'invalid_snd_record',
      ordinal: firstRecordFailure.ordinal,
      recordReason: firstRecordFailure.reason,
      stats,
    };
  }
  const header = records[0];
  if (!header || header.recordType !== 'HEADER') return { ok: false, reason: 'missing_snd_header' };
  if (header.release.toLowerCase() !== sourceIdentity.release.toLowerCase()) {
    return { ok: false, reason: 'snd_header_release_mismatch' };
  }
  if (header.declaredRecordCount !== stats.read) return { ok: false, reason: 'snd_record_count_mismatch' };
  return { ok: true, source: sourceIdentity, records, stats };
}

function createMemoryPagedSource({ metadata, rows = [], archiveBytes = null }) {
  return {
    calls: [],
    async getMetadata() { return { ...metadata }; },
    async readArchiveBytes() { return archiveBytes; },
    async readPage(query) {
      this.calls.push({ ...query });
      return rows.slice(query.offset, query.offset + query.limit);
    },
  };
}

module.exports = { PINNED_SND_RELEASE, ingestCsclSource, ingestSndSource, createMemoryPagedSource };
