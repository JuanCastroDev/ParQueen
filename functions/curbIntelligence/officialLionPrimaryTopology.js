'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { APPROVED_LION } = require('./successorReleasePolicy');
const { normalizeBlockFaceId, CSCL_RESOURCE_ID } = require('./curbIdentity');
const { nyLongIslandUsFtToWgs84 } = require('./lionStatePlane');

const MAX_ENDPOINT_RESIDUAL_METERS = 2;
const seals = new WeakMap();
const SUFFIXES = Object.freeze({
  AVENUE: 'AVE',
  STREET: 'ST',
  BOULEVARD: 'BLVD',
  PLACE: 'PL',
  ROAD: 'RD',
  PARKWAY: 'PKWY',
  LANE: 'LN',
  DRIVE: 'DR',
  COURT: 'CT',
  TERRACE: 'TER',
  EXPRESSWAY: 'EXPY',
});

const closed = reason => Object.freeze({ ok: false, reason });

function digitKey(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  return text.replace(/^0+/, '') || '0';
}

function faceId(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return normalizeBlockFaceId(String(value));
  return normalizeBlockFaceId(typeof value === 'string' ? value : '');
}

function compactName(value) {
  const parts = String(value ?? '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const last = parts[parts.length - 1];
  if (SUFFIXES[last]) parts[parts.length - 1] = SUFFIXES[last];
  return parts.join(' ');
}

function endpoints(geometry) {
  const lines = geometry?.type === 'MultiLineString' ? geometry.coordinates : null;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!Array.isArray(first) || first.length < 2 || !Array.isArray(last) || last.length < 2) return null;
  const start = first[0];
  const end = last[last.length - 1];
  if (!Array.isArray(start) || !Array.isArray(end)) return null;
  if (![start[0], start[1], end[0], end[1]].every(Number.isFinite)) return null;
  return [start, end];
}

function meters(left, right) {
  const lat = ((left[1] + right[1]) / 2) * Math.PI / 180;
  const dLat = (right[1] - left[1]) * 111320;
  const dLng = (right[0] - left[0]) * 111320 * Math.cos(lat);
  return Math.hypot(dLat, dLng);
}

function sharesNode(segment, nodeId) {
  return digitKey(segment.nodeIdFrom) === nodeId || digitKey(segment.nodeIdTo) === nodeId;
}

function crossStreet(nodeId, subject, segments, nodeNames) {
  const incident = segments.filter(segment => sharesNode(segment, nodeId)
    && digitKey(segment.streetCode) !== digitKey(subject.streetCode));
  const codes = [...new Set(incident.map(segment => digitKey(segment.streetCode)).filter(Boolean))];
  if (codes.length !== 1) {
    return closed(codes.length === 0 ? 'lion_cross_street_missing' : 'lion_node_ambiguous');
  }
  const names = [...new Set(incident.map(segment => compactName(segment.street)).filter(Boolean))];
  if (names.length !== 1) return closed('lion_node_ambiguous');
  const onStreet = compactName(subject.street);
  const labels = nodeNames
    .filter(entry => digitKey(entry.nodeId) === nodeId)
    .map(entry => compactName(entry.name))
    .filter(Boolean);
  const foreign = [...new Set(labels.filter(label => label !== onStreet))];
  if (foreign.length !== 1 || foreign[0] !== names[0]) return closed('lion_node_name_conflict');
  const street = incident.find(segment => compactName(segment.street) === names[0])?.street;
  if (typeof street !== 'string' || !street.trim()) return closed('lion_cross_street_missing');
  return Object.freeze({ ok: true, street: street.trim() });
}

function geometryAgrees(csclGeometry, lionGeometry) {
  const cscl = endpoints(csclGeometry);
  const lion = endpoints(lionGeometry);
  if (!cscl || !lion) return closed('lion_geometry_incompatible');
  const forward = meters(cscl[0], lion[0]) <= MAX_ENDPOINT_RESIDUAL_METERS
    && meters(cscl[1], lion[1]) <= MAX_ENDPOINT_RESIDUAL_METERS;
  const reverse = meters(cscl[0], lion[1]) <= MAX_ENDPOINT_RESIDUAL_METERS
    && meters(cscl[1], lion[0]) <= MAX_ENDPOINT_RESIDUAL_METERS;
  if (reverse && !forward) return closed('lion_direction_mismatch');
  if (!forward || reverse) return closed('lion_geometry_incompatible');
  return Object.freeze({ ok: true });
}

function evaluateOfficialLionRelationship(record, packet) {
  if (!record || !packet || !Array.isArray(packet.segments) || !Array.isArray(packet.nodeNames)) {
    return closed('lion_relationship_incomplete');
  }
  if (record.sourceVersion?.resourceId !== CSCL_RESOURCE_ID
    || typeof record.sourceVersion?.version !== 'string'
    || !record.sourceVersion.version.trim()) {
    return closed('lion_cscl_incompatible');
  }
  const physicalId = digitKey(record.sourceNative?.physicalid);
  const streetCode = digitKey(record.sourceNative?.b5sc);
  const left = faceId(record.leftBlockFaceId);
  const right = faceId(record.rightBlockFaceId);
  if (!physicalId || !streetCode || !left || !right || left === right) {
    return closed(!left || !right ? 'lion_bfi_missing' : 'lion_bfi_conflict');
  }
  const subjects = packet.segments.filter(segment => digitKey(segment.physicalId) === physicalId);
  const segmentIds = [...new Set(subjects.map(segment => digitKey(segment.segmentId)).filter(Boolean))];
  if (segmentIds.length !== 1 || subjects.length === 0) return closed('lion_physical_id_ambiguous');
  const subject = subjects[0];
  if (digitKey(subject.streetCode) !== streetCode) return closed('lion_street_code_mismatch');
  if (faceId(subject.leftBlockFaceId) !== left || faceId(subject.rightBlockFaceId) !== right) {
    return closed('lion_bfi_conflict');
  }
  const fromNode = digitKey(subject.nodeIdFrom);
  const toNode = digitKey(subject.nodeIdTo);
  if (!fromNode || !toNode || fromNode === toNode) return closed('lion_relationship_incomplete');
  const geometry = geometryAgrees(record.geometry, subject.geometry);
  if (!geometry.ok) return geometry;
  const fromStreet = crossStreet(fromNode, subject, packet.segments, packet.nodeNames);
  if (!fromStreet.ok) return fromStreet;
  const toStreet = crossStreet(toNode, subject, packet.segments, packet.nodeNames);
  if (!toStreet.ok) return toStreet;
  if (compactName(fromStreet.street) === compactName(toStreet.street)
    || compactName(fromStreet.street) === compactName(subject.street)
    || compactName(toStreet.street) === compactName(subject.street)) {
    return closed('lion_node_ambiguous');
  }
  return Object.freeze({
    ok: true,
    onStreet: String(subject.street).trim(),
    fromStreet: fromStreet.street,
    toStreet: toStreet.street,
    segmentId: String(subject.segmentId).trim(),
    certificationStatus: 'NOT_CERTIFIED',
    productionAuthoritative: false,
  });
}

function hashFile(filePath) {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  try {
    const stat = fs.fstatSync(descriptor);
    while (position < stat.size) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { byteLength: position, sha256: hash.digest('hex') };
}

function approvedArchive(filePath) {
  let identity;
  try {
    identity = hashFile(filePath);
  } catch {
    return null;
  }
  if (identity.sha256 !== APPROVED_LION.sha256
    || identity.byteLength !== APPROVED_LION.byteLength
    || APPROVED_LION.edition !== '26B') return null;
  return identity;
}

function extractArchive(archivePath, digest) {
  const destination = path.join(os.tmpdir(), `parqueen-lion-${digest.slice(0, 16)}`);
  const gdb = path.join(destination, 'lion', 'lion.gdb');
  if (!fs.existsSync(path.join(gdb, 'a00000001.gdbtable'))) {
    fs.mkdirSync(destination, { recursive: true });
    const extracted = spawnSync('tar', ['-xf', archivePath, '-C', destination], {
      stdio: 'pipe',
      windowsHide: true,
    });
    if (extracted.status !== 0 || !fs.existsSync(path.join(gdb, 'a00000001.gdbtable'))) return null;
  }
  return path.join(destination, 'lion');
}

function writeVrt(directory, name, sql) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OGRVRTDataSource>
  <OGRVRTLayer name="${name}">
    <SrcDataSource relativeToVRT="1">lion.gdb</SrcDataSource>
    <SrcSQL>${sql}</SrcSQL>
  </OGRVRTLayer>
</OGRVRTDataSource>
`;
  const file = path.join(directory, `${name}.vrt`);
  fs.writeFileSync(file, xml);
  return file;
}

function gdalRoot() {
  const configured = process.env.CURB_LION_GDAL_MODULE;
  if (typeof configured !== 'string' || !configured) return null;
  return path.resolve(configured, '..', '..', '..');
}

async function openGdalSession() {
  const root = gdalRoot();
  const configured = process.env.CURB_LION_GDAL_MODULE;
  if (!root || !configured) return null;
  const previous = process.cwd();
  process.chdir(root);
  try {
    const initGdalJs = require(configured);
    const gdal = await initGdalJs({
      useWorker: false,
      errorHandler: () => {},
      logHandler: () => {},
    });
    process.chdir(previous);
    const queryCache = new Map();
    return {
      async query(directory, name, sql) {
        const key = `${directory}\n${name}\n${sql}`;
        if (queryCache.has(key)) return queryCache.get(key);
        const pending = (async () => {
          const opened = await gdal.open(writeVrt(directory, name, sql));
          if (!opened.datasets || !opened.datasets[0]) return null;
          const info = await gdal.ogrinfo(opened.datasets[0], ['-features']);
          await gdal.close(opened.datasets[0]);
          const layer = (info.layers || [])[0] || {};
          return (layer.features || []).map(feature => ({
            attributes: feature.properties || {},
            geometry: feature.geometry || null,
          }));
        })();
        queryCache.set(key, pending);
        try {
          return await pending;
        } catch (error) {
          queryCache.delete(key);
          throw error;
        }
      },
    };
  } catch {
    process.chdir(previous);
    return null;
  }
}

function sqlNode(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  return text.padStart(7, '0');
}

function projectGeometry(geometry) {
  if (geometry?.type !== 'MultiLineString' || !Array.isArray(geometry.coordinates)) return null;
  const coordinates = geometry.coordinates.map(line => line.map(point => {
    const projected = nyLongIslandUsFtToWgs84(point[0], point[1]);
    return projected ? [projected[0], projected[1]] : null;
  }));
  if (coordinates.some(line => line.some(point => point == null))) return null;
  return { type: 'MultiLineString', coordinates };
}

function segmentFromFeature(feature) {
  const attributes = feature.attributes || {};
  const geometry = projectGeometry(feature.geometry);
  return {
    segmentId: attributes.SegmentID,
    physicalId: attributes.PhysicalID,
    street: attributes.Street,
    streetCode: attributes.StreetCode,
    nodeIdFrom: attributes.NodeIDFrom,
    nodeIdTo: attributes.NodeIDTo,
    leftBlockFaceId: attributes.LBlockFaceID,
    rightBlockFaceId: attributes.RBlockFaceID,
    geometry,
  };
}

function createCatalog(directory, session) {
  const cache = new Map();
  return Object.freeze({
    async packetFor(physicalId) {
      const key = digitKey(physicalId);
      if (!key) return null;
      if (cache.has(key)) return cache.get(key);
      const subjectFeatures = await session.query(
        directory,
        `subject-${key}`,
        `SELECT SegmentID, PhysicalID, Street, StreetCode, NodeIDFrom, NodeIDTo, LBlockFaceID, RBlockFaceID FROM lion WHERE PhysicalID = ${key}`,
      );
      const subject = subjectFeatures?.[0]?.attributes;
      const fromText = sqlNode(subject?.NodeIDFrom);
      const toText = sqlNode(subject?.NodeIDTo);
      if (!subjectFeatures || !fromText || !toText) {
        cache.set(key, null);
        return null;
      }
      const incidentFeatures = await session.query(
        directory,
        `incident-${key}`,
        `SELECT SegmentID, PhysicalID, Street, StreetCode, NodeIDFrom, NodeIDTo, LBlockFaceID, RBlockFaceID FROM lion WHERE NodeIDFrom IN ('${fromText}','${toText}') OR NodeIDTo IN ('${fromText}','${toText}')`,
      );
      const nameFeatures = await session.query(
        directory,
        `names-${key}`,
        `SELECT NODEID, STNAME FROM node_stname WHERE NODEID IN ('${fromText}','${toText}')`,
      );
      if (!incidentFeatures || !nameFeatures) {
        cache.set(key, null);
        return null;
      }
      const packet = Object.freeze({
        segments: incidentFeatures.map(segmentFromFeature),
        nodeNames: nameFeatures.map(feature => ({
          nodeId: feature.attributes.NODEID,
          name: feature.attributes.STNAME,
        })),
      });
      cache.set(key, packet);
      return packet;
    },
    async relationshipsFor(records) {
      const relationships = new Map();
      for (const record of records) {
        const packet = await this.packetFor(record?.sourceNative?.physicalid);
        relationships.set(record, packet
          ? evaluateOfficialLionRelationship(record, packet)
          : closed('lion_primary_unavailable'));
      }
      return relationships;
    },
  });
}

function sealCatalog(catalog) {
  const admitted = Object.freeze({
    ok: true,
    certificationStatus: 'NOT_CERTIFIED',
    productionAuthoritative: false,
    topologyApproved: false,
    async relationshipsFor(records) {
      return catalog.relationshipsFor(records);
    },
  });
  seals.set(admitted, catalog);
  return admitted;
}

function readOfficialLionPrimary(value) {
  return seals.has(value) ? value : null;
}

async function openApprovedLionArchive(archivePath) {
  if (typeof archivePath !== 'string' || !archivePath) return null;
  const identity = approvedArchive(archivePath);
  if (!identity) return null;
  const directory = extractArchive(archivePath, identity.sha256);
  const session = await openGdalSession();
  if (!directory || !session) return null;
  return sealCatalog(createCatalog(directory, session));
}

let admittedCatalog = null;

async function loadOfficialLionPrimary(env = process.env) {
  if (env.FUNCTIONS_EMULATOR !== 'true' || env.CURB_OFFICIAL_LION_PRIMARY !== 'local') return null;
  if (typeof env.CURB_LION_PRIMARY_ARCHIVE !== 'string') return null;
  if (admittedCatalog) return admittedCatalog;
  const admitted = await openApprovedLionArchive(env.CURB_LION_PRIMARY_ARCHIVE);
  if (admitted?.ok === true) admittedCatalog = admitted;
  return admitted;
}

module.exports = {
  MAX_ENDPOINT_RESIDUAL_METERS,
  evaluateOfficialLionRelationship,
  loadOfficialLionPrimary,
  openApprovedLionArchive,
  readOfficialLionPrimary,
};
