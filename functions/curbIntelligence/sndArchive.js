'use strict';

const { inflateRawSync } = require('zlib');

const EOCD = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const MAX_COW_BYTES = 64 * 1024 * 1024;

function findEocd(bytes) {
  const first = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= first; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD) return offset;
  }
  return -1;
}

function extractSndCowLines(archiveBytes) {
  const bytes = Buffer.isBuffer(archiveBytes) ? archiveBytes : Buffer.from(archiveBytes || []);
  if (bytes.length < 22) return { ok: false, reason: 'invalid_snd_archive' };
  const eocd = findEocd(bytes);
  if (eocd < 0) return { ok: false, reason: 'invalid_snd_archive' };
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entries === 0
    || centralOffset + centralSize > bytes.length) {
    return { ok: false, reason: 'invalid_snd_archive' };
  }

  const matches = [];
  let offset = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_HEADER) {
      return { ok: false, reason: 'invalid_snd_archive' };
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) return { ok: false, reason: 'invalid_snd_archive' };
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (/(?:^|\/)snd[^/]*cow\.txt$/i.test(name)) {
      matches.push({ flags, method, compressedSize, uncompressedSize, localOffset });
    }
    offset = end;
  }
  if (matches.length !== 1) return { ok: false, reason: 'snd_cow_entry_missing_or_ambiguous' };

  const entry = matches[0];
  if ((entry.flags & 1) !== 0 || ![0, 8].includes(entry.method)
    || entry.uncompressedSize > MAX_COW_BYTES || entry.localOffset + 30 > bytes.length
    || bytes.readUInt32LE(entry.localOffset) !== LOCAL_HEADER) {
    return { ok: false, reason: 'unsupported_snd_archive' };
  }
  const localNameLength = bytes.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = bytes.readUInt16LE(entry.localOffset + 28);
  const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > bytes.length) return { ok: false, reason: 'invalid_snd_archive' };
  let content;
  try {
    const compressed = bytes.subarray(dataOffset, dataEnd);
    content = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, {
      maxOutputLength: Math.min(entry.uncompressedSize, MAX_COW_BYTES),
    });
  } catch {
    return { ok: false, reason: 'invalid_snd_archive' };
  }
  if (content.length !== entry.uncompressedSize || content.length > MAX_COW_BYTES) {
    return { ok: false, reason: 'invalid_snd_archive' };
  }
  const lines = content.toString('latin1').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.length ? { ok: true, lines } : { ok: false, reason: 'empty_snd_cow' };
}

module.exports = { extractSndCowLines };
