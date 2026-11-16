'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { APPROVED_LION } = require('./successorReleasePolicy');
const { PINNED_ARTIFACT_SHA256 } = require('./runtimeSourceArtifact');

const INDEX_SCHEMA = 1;
const HEADER_BYTES = 168;
const MAGIC = Buffer.from('PQLIDX01', 'ascii');
// SHA-256 of the offline index built from the pinned LION 26B archive.
// A mismatch rejects the index. The request path does not scan the FileGDB.
const PINNED_RELATIONSHIP_INDEX_SHA256 = '19ef780fa3c4b18ef11c69febb68b471d85bc62eec98440f03822f9d9f345512';

let pinnedIndex = null;

function digitKey(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  return text.replace(/^0+/, '') || '0';
}

function uintKey(value) {
  const key = digitKey(value);
  if (!key) return null;
  const numeric = Number(key);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xFFFFFFFF) return null;
  return numeric;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(buffer) {
    this.chunks.push(buffer);
    this.length += buffer.length;
  }

  u8(value) {
    const buffer = Buffer.alloc(1);
    buffer.writeUInt8(value);
    this.push(buffer);
  }

  u16(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value);
    this.push(buffer);
  }

  u32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    this.push(buffer);
  }

  f64(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeDoubleLE(value);
    this.push(buffer);
  }

  text(value) {
    const encoded = Buffer.from(String(value ?? ''), 'utf8');
    if (encoded.length > 65535) {
      const error = new Error('lion_index_field_too_long');
      error.code = 'lion_index_field_too_long';
      throw error;
    }
    this.u16(encoded.length);
    if (encoded.length > 0) this.push(encoded);
  }

  concat() {
    return Buffer.concat(this.chunks, this.length);
  }
}

function textField(segment, field) {
  const value = segment?.[field];
  return value == null ? '' : String(value);
}

function endpointPair(geometry) {
  const lines = geometry?.type === 'MultiLineString' ? geometry.coordinates : null;
  const first = Array.isArray(lines) && Array.isArray(lines[0]) ? lines[0][0] : null;
  const lastLine = Array.isArray(lines) ? lines[lines.length - 1] : null;
  const last = Array.isArray(lastLine) ? lastLine[lastLine.length - 1] : null;
  if (!Array.isArray(first) || !Array.isArray(last)) return null;
  const values = [first[0], first[1], last[0], last[1]];
  if (!values.every(Number.isFinite)) return null;
  return values;
}

function writeSegment(writer, segment) {
  writer.text(textField(segment, 'physicalId'));
  writer.text(textField(segment, 'segmentId'));
  writer.text(textField(segment, 'street'));
  writer.text(textField(segment, 'streetCode'));
  writer.text(textField(segment, 'nodeIdFrom'));
  writer.text(textField(segment, 'nodeIdTo'));
  writer.text(textField(segment, 'leftBlockFaceId'));
  writer.text(textField(segment, 'rightBlockFaceId'));
  const ends = endpointPair(segment?.geometry);
  writer.u8(ends ? 1 : 0);
  if (ends) ends.forEach(value => writer.f64(value));
}

function writeName(writer, entry) {
  writer.text(textField(entry, 'nodeId'));
  writer.text(textField(entry, 'name'));
}

function directoryKey(value) {
  const digits = digitKey(value);
  if (!digits) return null;
  const key = uintKey(value);
  if (key == null) {
    const error = new Error('lion_index_id_range');
    error.code = 'lion_index_id_range';
    throw error;
  }
  return key;
}

function groupedOrdinals(records, field) {
  const groups = new Map();
  const unkeyed = [];
  records.forEach((record, ordinal) => {
    const key = directoryKey(record?.[field]);
    if (key == null) {
      unkeyed.push(ordinal);
      return;
    }
    const existing = groups.get(key);
    if (existing) existing.push(ordinal);
    else groups.set(key, [ordinal]);
  });
  const entries = [...groups.entries()]
    .map(([key, ordinals]) => ({ key, ordinals }))
    .sort((left, right) => left.key - right.key);
  return { entries, unkeyed };
}

function writeDirectory(entries) {
  const writer = new Writer();
  const ordinals = [];
  entries.forEach(entry => {
    writer.u32(entry.key);
    writer.u32(ordinals.length);
    writer.u32(entry.ordinals.length);
    ordinals.push(...entry.ordinals);
  });
  const ordinalWriter = new Writer();
  ordinals.forEach(ordinal => ordinalWriter.u32(ordinal));
  return {
    directory: writer.concat(),
    ordinals: ordinalWriter.concat(),
    count: entries.length,
  };
}

function encodeRelationshipIndex(input) {
  const segments = Array.isArray(input?.segments) ? input.segments : [];
  const names = Array.isArray(input?.names) ? input.names : [];
  const segmentBlob = new Writer();
  const segmentOffsets = new Writer();
  segments.forEach(segment => {
    segmentOffsets.u32(segmentBlob.length);
    writeSegment(segmentBlob, segment);
  });
  const nameBlob = new Writer();
  const nameOffsets = new Writer();
  names.forEach(entry => {
    nameOffsets.u32(nameBlob.length);
    writeName(nameBlob, entry);
  });
  const physical = groupedOrdinals(segments, 'physicalId');
  const nodes = new Map();
  segments.forEach((segment, ordinal) => {
    [segment?.nodeIdFrom, segment?.nodeIdTo].forEach(value => {
      const key = directoryKey(value);
      if (key == null) return;
      const existing = nodes.get(key);
      if (existing) {
        if (existing[existing.length - 1] !== ordinal) existing.push(ordinal);
      } else nodes.set(key, [ordinal]);
    });
  });
  const nodeEntries = [...nodes.entries()]
    .map(([key, ordinals]) => ({ key, ordinals }))
    .sort((left, right) => left.key - right.key);
  const nameGroups = groupedOrdinals(names, 'nodeId');
  const physicalDirectory = writeDirectory(physical.entries);
  const nodeDirectory = writeDirectory(nodeEntries);
  const nameDirectory = writeDirectory(nameGroups.entries);
  const unkeyedWriter = new Writer();
  physical.unkeyed.forEach(ordinal => unkeyedWriter.u32(ordinal));
  const nameUnkeyedWriter = new Writer();
  nameGroups.unkeyed.forEach(ordinal => nameUnkeyedWriter.u32(ordinal));
  const payload = Buffer.concat([
    segmentBlob.concat(),
    nameBlob.concat(),
    segmentOffsets.concat(),
    nameOffsets.concat(),
    physicalDirectory.directory,
    physicalDirectory.ordinals,
    nodeDirectory.directory,
    nodeDirectory.ordinals,
    nameDirectory.directory,
    nameDirectory.ordinals,
    unkeyedWriter.concat(),
    nameUnkeyedWriter.concat(),
  ]);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt16LE(INDEX_SCHEMA, 8);
  Buffer.from('26B', 'ascii').copy(header, 10);
  Buffer.from(input.lionSha256, 'hex').copy(header, 16);
  header.writeUInt32LE(input.lionByteLength, 48);
  Buffer.from(input.artifactSha256, 'hex').copy(header, 52);
  header.writeUInt32LE(segments.length, 84);
  header.writeUInt32LE(names.length, 88);
  header.writeUInt32LE(physical.entries.length, 92);
  header.writeUInt32LE(nodeEntries.length, 96);
  header.writeUInt32LE(nameGroups.entries.length, 100);
  header.writeUInt32LE(physical.entries.filter(entry => entry.ordinals.length !== 1).length, 104);
  header.writeUInt32LE(segmentBlob.length, 108);
  header.writeUInt32LE(nameBlob.length, 112);
  header.writeUInt32LE(physical.unkeyed.length, 116);
  header.writeUInt32LE(nameGroups.unkeyed.length, 120);
  createHash('sha256').update(payload).digest().copy(header, 128);
  return Buffer.concat([header, payload]);
}

function readText(buffer, offset) {
  if (offset + 2 > buffer.length) return null;
  const length = buffer.readUInt16LE(offset);
  const start = offset + 2;
  const end = start + length;
  if (end > buffer.length) return null;
  return { text: buffer.toString('utf8', start, end), offset: end };
}

function readSegment(buffer, offset) {
  const fields = ['physicalId', 'segmentId', 'street', 'streetCode', 'nodeIdFrom', 'nodeIdTo', 'leftBlockFaceId', 'rightBlockFaceId'];
  const segment = {};
  let cursor = offset;
  for (const field of fields) {
    const read = readText(buffer, cursor);
    if (!read) return null;
    segment[field] = read.text;
    cursor = read.offset;
  }
  if (cursor >= buffer.length) return null;
  const flag = buffer.readUInt8(cursor);
  cursor += 1;
  if (flag === 1) {
    if (cursor + 32 > buffer.length) return null;
    const values = [0, 1, 2, 3].map(index => buffer.readDoubleLE(cursor + index * 8));
    segment.geometry = {
      type: 'MultiLineString',
      coordinates: [[[values[0], values[1]], [values[2], values[3]]]],
    };
  } else if (flag === 0) {
    segment.geometry = null;
  } else return null;
  return segment;
}

function markOrdinals(seen, ordinals) {
  for (let index = 0; index < ordinals.length; index += 1) {
    const ordinal = ordinals[index];
    if (ordinal >= seen.length || seen[ordinal] === 1) return false;
    seen[ordinal] = 1;
  }
  return true;
}

function fullyCovered(seen) {
  for (let index = 0; index < seen.length; index += 1) {
    if (seen[index] !== 1) return false;
  }
  return true;
}

function directoryView(buffer, offset, count) {
  const bytes = count * 12;
  if (offset + bytes > buffer.length) return null;
  const keys = new Uint32Array(count);
  const starts = new Uint32Array(count);
  const counts = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    const cursor = offset + index * 12;
    keys[index] = buffer.readUInt32LE(cursor);
    starts[index] = buffer.readUInt32LE(cursor + 4);
    counts[index] = buffer.readUInt32LE(cursor + 8);
    if (index > 0 && keys[index] <= keys[index - 1]) return null;
  }
  return { keys, starts, counts, offset: offset + bytes };
}

function ordinalView(buffer, offset, count) {
  const bytes = count * 4;
  if (offset + bytes > buffer.length) return null;
  const ordinals = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) ordinals[index] = buffer.readUInt32LE(offset + index * 4);
  return { ordinals, offset: offset + bytes };
}

function findEntry(directory, key) {
  let low = 0;
  let high = directory.keys.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (directory.keys[mid] < key) low = mid + 1;
    else high = mid;
  }
  if (low >= directory.keys.length || directory.keys[low] !== key) return null;
  return { start: directory.starts[low], count: directory.counts[low] };
}

function openRelationshipIndex(bytes, expected = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < HEADER_BYTES) return null;
  if (!bytes.subarray(0, 8).equals(MAGIC)) return null;
  if (bytes.readUInt16LE(8) !== INDEX_SCHEMA) return null;
  if (bytes.toString('ascii', 10, 13) !== '26B') return null;
  const lionSha256 = bytes.subarray(16, 48).toString('hex');
  const lionByteLength = bytes.readUInt32LE(48);
  const artifactSha256 = bytes.subarray(52, 84).toString('hex');
  const lionPin = expected.lionSha256 || APPROVED_LION.sha256;
  const lionBytes = expected.lionByteLength || APPROVED_LION.byteLength;
  const artifactPin = expected.artifactSha256 || PINNED_ARTIFACT_SHA256;
  if (lionSha256 !== lionPin || lionByteLength !== lionBytes || artifactSha256 !== artifactPin) return null;
  if (APPROVED_LION.edition !== '26B') return null;
  const segmentCount = bytes.readUInt32LE(84);
  const nameCount = bytes.readUInt32LE(88);
  const physicalCount = bytes.readUInt32LE(92);
  const nodeCount = bytes.readUInt32LE(96);
  const nameEntryCount = bytes.readUInt32LE(100);
  const ambiguousPhysicalCount = bytes.readUInt32LE(104);
  const segmentBlobLength = bytes.readUInt32LE(108);
  const nameBlobLength = bytes.readUInt32LE(112);
  const unkeyedCount = bytes.readUInt32LE(116);
  const nameUnkeyedCount = bytes.readUInt32LE(120);
  const payload = bytes.subarray(HEADER_BYTES);
  const contentHash = createHash('sha256').update(payload).digest('hex');
  if (contentHash !== bytes.subarray(128, 160).toString('hex')) return null;
  let cursor = HEADER_BYTES;
  const segmentBlobEnd = cursor + segmentBlobLength;
  const nameBlobStart = segmentBlobEnd;
  const nameBlobEnd = nameBlobStart + nameBlobLength;
  if (nameBlobEnd > bytes.length) return null;
  cursor = nameBlobEnd;
  const segmentOffsets = ordinalView(bytes, cursor, segmentCount);
  if (!segmentOffsets) return null;
  cursor = segmentOffsets.offset;
  const nameOffsets = ordinalView(bytes, cursor, nameCount);
  if (!nameOffsets) return null;
  cursor = nameOffsets.offset;
  const physical = directoryView(bytes, cursor, physicalCount);
  if (!physical) return null;
  cursor = physical.offset;
  const physicalOrdinals = ordinalView(bytes, cursor, segmentCount - unkeyedCount);
  if (!physicalOrdinals) return null;
  cursor = physicalOrdinals.offset;
  const nodes = directoryView(bytes, cursor, nodeCount);
  if (!nodes) return null;
  cursor = nodes.offset;
  let nodeOrdinalCount = 0;
  for (let index = 0; index < nodeCount; index += 1) nodeOrdinalCount += nodes.counts[index];
  const nodeOrdinals = ordinalView(bytes, cursor, nodeOrdinalCount);
  if (!nodeOrdinals) return null;
  cursor = nodeOrdinals.offset;
  const nameDirectory = directoryView(bytes, cursor, nameEntryCount);
  if (!nameDirectory) return null;
  cursor = nameDirectory.offset;
  const nameOrdinals = ordinalView(bytes, cursor, nameCount - nameUnkeyedCount);
  if (!nameOrdinals) return null;
  cursor = nameOrdinals.offset;
  const unkeyed = ordinalView(bytes, cursor, unkeyedCount);
  if (!unkeyed) return null;
  cursor = unkeyed.offset;
  const nameUnkeyed = ordinalView(bytes, cursor, nameUnkeyedCount);
  if (!nameUnkeyed || cursor !== bytes.length) return null;
  const seenSegments = new Uint8Array(segmentCount);
  if (!markOrdinals(seenSegments, physicalOrdinals.ordinals)) return null;
  if (!markOrdinals(seenSegments, unkeyed.ordinals) || !fullyCovered(seenSegments)) return null;
  for (let index = 0; index < physicalCount; index += 1) {
    const start = physical.starts[index];
    const count = physical.counts[index];
    if (count === 0 || start + count > physicalOrdinals.ordinals.length) return null;
  }
  let ambiguous = 0;
  for (let index = 0; index < physicalCount; index += 1) {
    if (physical.counts[index] !== 1) ambiguous += 1;
  }
  if (ambiguous !== ambiguousPhysicalCount) return null;
  for (let index = 0; index < nodeOrdinals.ordinals.length; index += 1) {
    if (nodeOrdinals.ordinals[index] >= segmentCount) return null;
  }
  const seenNames = new Uint8Array(nameCount);
  if (!markOrdinals(seenNames, nameOrdinals.ordinals)) return null;
  if (!markOrdinals(seenNames, nameUnkeyed.ordinals) || !fullyCovered(seenNames)) return null;

  function ordinalsFor(directory, lists, key) {
    const numeric = uintKey(key);
    if (numeric == null) return [];
    const entry = findEntry(directory, numeric);
    if (!entry) return [];
    if (entry.start + entry.count > lists.length) return null;
    return lists.subarray(entry.start, entry.start + entry.count);
  }

  return Object.freeze({
    segmentCount,
    nameCount,
    ambiguousPhysicalCount,
    lionSha256,
    lionByteLength,
    artifactSha256,
    packetFor(physicalId) {
      const key = uintKey(physicalId);
      if (key == null) return null;
      const entry = findEntry(physical, key);
      if (!entry || entry.count !== 1) return null;
      const subjectOrdinal = physicalOrdinals.ordinals[entry.start];
      const subject = readSegment(bytes, HEADER_BYTES + segmentOffsets.ordinals[subjectOrdinal]);
      if (!subject || uintKey(subject.nodeIdFrom) == null || uintKey(subject.nodeIdTo) == null) return null;
      const chosen = new Set();
      for (const nodeId of [subject.nodeIdFrom, subject.nodeIdTo]) {
        const linked = ordinalsFor(nodes, nodeOrdinals.ordinals, nodeId);
        if (!linked) return null;
        linked.forEach(ordinal => chosen.add(ordinal));
      }
      const ordered = [...chosen].sort((left, right) => left - right);
      const packetSegments = [];
      for (const ordinal of ordered) {
        const segment = readSegment(bytes, HEADER_BYTES + segmentOffsets.ordinals[ordinal]);
        if (!segment) return null;
        packetSegments.push(segment);
      }
      const packetNames = [];
      for (const nodeId of [subject.nodeIdFrom, subject.nodeIdTo]) {
        const linked = ordinalsFor(nameDirectory, nameOrdinals.ordinals, nodeId);
        if (!linked) return null;
        for (const ordinal of linked) {
          const node = readText(bytes, nameBlobStart + nameOffsets.ordinals[ordinal]);
          const name = node ? readText(bytes, node.offset) : null;
          if (!node || !name) return null;
          packetNames.push({ nodeId: node.text, name: name.text });
        }
      }
      return Object.freeze({
        segments: packetSegments,
        nodeNames: packetNames,
      });
    },
  });
}

function loadPinnedRelationshipIndex(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  if (!/^[a-f0-9]{64}$/.test(PINNED_RELATIONSHIP_INDEX_SHA256)
    || PINNED_RELATIONSHIP_INDEX_SHA256 === '0'.repeat(64)) return null;
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  const digest = sha256(bytes);
  if (digest !== PINNED_RELATIONSHIP_INDEX_SHA256) return null;
  if (pinnedIndex?.digest === digest) return pinnedIndex.index;
  const index = openRelationshipIndex(bytes);
  if (!index) return null;
  pinnedIndex = { digest, index };
  return index;
}

function relationshipIndexPath(archivePath) {
  if (typeof archivePath !== 'string' || archivePath.length === 0) return null;
  return `${archivePath}.relationship-index`;
}

module.exports = {
  INDEX_SCHEMA,
  PINNED_RELATIONSHIP_INDEX_SHA256,
  encodeRelationshipIndex,
  loadPinnedRelationshipIndex,
  openRelationshipIndex,
  relationshipIndexPath,
};
