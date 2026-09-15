import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ingestCsclSource, ingestSndSource, createMemoryPagedSource } = require('./sourceIngest');

const csclRow = id => ({
  the_geom: { type: 'MultiLineString', coordinates: [[[-74.001, 40.71], [-74, 40.711]]] },
  globalid: id, physicalid: id, l_blockfaceid: '212261301', r_blockfaceid: '212260958',
});

function sndLine(name, b10sc) {
  const chars = Array(200).fill(' ');
  const put = (from, to, value) => String(value).padEnd(to - from + 1).slice(0, to - from + 1)
    .split('').forEach((char, index) => { chars[from - 1 + index] = char; });
  put(1, 1, '1'); put(2, 2, b10sc[0]); put(3, 34, name); put(35, 35, 'P');
  put(36, 36, 'F'); put(37, 47, b10sc); put(54, 85, name);
  return chars.join('');
}

function sndHeader(release, count) {
  return `${'0000SND'.padEnd(8)}${'260914'}${String(release).padEnd(4)}${String(count).padStart(8, '0')}`.padEnd(200);
}

function storedZip(name, content) {
  const fileName = Buffer.from(name);
  const data = Buffer.from(content, 'latin1');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const centralOffset = local.length + fileName.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + fileName.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, data, central, fileName, eocd]);
}

const sndArchive = rows => storedZip('snd26Bcow.txt', rows.join('\r\n'));

describe('official source ingestion boundary', () => {
  it('reads CSCL in stable pages and returns deterministic validation statistics', async () => {
    const source = createMemoryPagedSource({
      metadata: { resourceId: 'inkn-q76z', version: 'v1' },
      rows: [csclRow('b'), { ...csclRow('bad'), the_geom: null }, csclRow('a')],
      archiveBytes: null,
    });
    const result = await ingestCsclSource(source, { pageSize: 2 });
    expect(result.ok).toBe(true);
    expect(source.calls).toEqual([
      { offset: 0, limit: 2, orderBy: ':id' },
      { offset: 2, limit: 2, orderBy: ':id' },
    ]);
    expect(result.records.map(item => item.globalId)).toEqual(['b', 'a']);
    expect(result.stats).toEqual({ read: 3, accepted: 2, rejected: 1, rejectionReasons: { invalid_geometry: 1 } });
  });

  it('rejects a source-version change observed across CSCL pagination', async () => {
    let reads = 0;
    const source = createMemoryPagedSource({ metadata: { resourceId: 'inkn-q76z', version: 'v1' }, rows: [csclRow('a')] });
    source.getMetadata = async () => ({ resourceId: 'inkn-q76z', version: ++reads === 1 ? 'v1' : 'v2' });
    expect(await ingestCsclSource(source, { pageSize: 1 })).toEqual({ ok: false, reason: 'source_changed_during_ingest' });
  });

  it('pins SND release separately from a locally computed exact-archive digest', async () => {
    const archiveRows = [sndHeader('26b', 3), sndLine('6 AVENUE', '10000101000'), sndLine('AVENUE OF THE AMERICAS', '10000101001')];
    const bytes = sndArchive(archiveRows);
    const source = createMemoryPagedSource({
      metadata: { datasetId: 'w4v2-rv6b', release: '26b' },
      rows: [sndHeader('26b', 1)],
      archiveBytes: bytes,
    });
    const result = await ingestSndSource(source, { pageSize: 1 });
    expect(result.ok).toBe(true);
    expect(result.source.release).toBe('26b');
    expect(result.source.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.source.archiveSha256).not.toBe(result.source.release);
    expect(result.source).not.toHaveProperty('publishedChecksum');
    expect(result.records.map(item => item.ordinal)).toEqual([0, 1, 2]);
    expect(result.stats).toEqual({ read: 3, accepted: 3, rejected: 0, rejectionReasons: {} });
  });

  it('fails closed when SND release metadata changes during record paging', async () => {
    let reads = 0;
    const source = createMemoryPagedSource({
      metadata: { datasetId: 'w4v2-rv6b', release: '26b' }, rows: [],
      archiveBytes: sndArchive([sndHeader('26b', 2), sndLine('GOLD STREET', '10000501000')]),
    });
    source.getMetadata = async () => ({ datasetId: 'w4v2-rv6b', release: ++reads === 1 ? '26b' : '26c' });
    expect(await ingestSndSource(source)).toEqual({ ok: false, reason: 'source_changed_during_ingest' });
  });

  it('pins the reviewed official SND release instead of silently accepting a different archive', async () => {
    const source = createMemoryPagedSource({
      metadata: { datasetId: 'w4v2-rv6b', release: '26c' }, rows: [], archiveBytes: Buffer.from('archive'),
    });
    expect(await ingestSndSource(source)).toEqual({ ok: false, reason: 'unexpected_snd_release', expected: '26b', actual: '26c' });
  });

  it('rejects missing, mismatched, or inconsistent COW header provenance', async () => {
    const create = rows => createMemoryPagedSource({
      metadata: { datasetId: 'w4v2-rv6b', release: '26b' }, rows: [], archiveBytes: sndArchive(rows),
    });
    expect(await ingestSndSource(create([sndLine('GOLD STREET', '10000501000')]))).toEqual({ ok: false, reason: 'missing_snd_header' });
    expect(await ingestSndSource(create([sndHeader('26a', 1)]))).toEqual({ ok: false, reason: 'snd_header_release_mismatch' });
    expect(await ingestSndSource(create([sndHeader('26b', 2)]))).toEqual({ ok: false, reason: 'snd_record_count_mismatch' });
  });

  it('rejects malformed COW content instead of accepting incomplete alias evidence', async () => {
    const source = createMemoryPagedSource({
      metadata: { datasetId: 'w4v2-rv6b', release: '26b' }, rows: [],
      archiveBytes: sndArchive([sndHeader('26b', 3), sndLine('GOLD STREET', '10000501000'), 'malformed']),
    });
    expect(await ingestSndSource(source)).toMatchObject({
      ok: false, reason: 'invalid_snd_record', ordinal: 2, recordReason: 'invalid_record_length',
    });
  });
});
