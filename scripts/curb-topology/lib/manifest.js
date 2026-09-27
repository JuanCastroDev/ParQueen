'use strict';

const { canonicalJson, sha256 } = require('./canonicalJson');

const REQUIRED = Object.freeze({
  cscl_centerline: 'cscl-pub-centerline-v1',
  cscl_node: 'cscl-pub-node-v1',
  cscl_street_name: 'cscl-pub-street-name-v1',
  pavement_edge: 'pavement-edge-v1',
});

const requireString = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
};

const deterministicManifest = manifest => ({
  manifestSchemaVersion: manifest.manifestSchemaVersion,
  normalizationVersion: manifest.normalizationVersion,
  sources: [...manifest.sources]
    .map(source => ({ ...source }))
    .sort((a, b) => a.role.localeCompare(b.role)),
});

const manifestIdentity = manifest => sha256(canonicalJson(deterministicManifest(manifest)));

const validateSnapshotManifest = (manifest, inventory) => {
  if (!manifest || manifest.manifestSchemaVersion !== 1) throw new TypeError('unsupported manifest schema');
  requireString(manifest.normalizationVersion, 'normalizationVersion');
  if (!manifest.acquisition || Number.isNaN(Date.parse(manifest.acquisition.timestamp))) {
    throw new TypeError('acquisition timestamp is required');
  }
  if (!Array.isArray(manifest.sources)) throw new TypeError('sources are required');

  const byRole = new Map();
  for (const source of manifest.sources) {
    requireString(source.role, 'source role');
    if (byRole.has(source.role)) throw new TypeError(`duplicate source role: ${source.role}`);
    byRole.set(source.role, source);
  }

  for (const [role, schemaVersion] of Object.entries(REQUIRED)) {
    const source = byRole.get(role);
    if (!source) throw new TypeError(`missing required source: ${role}`);
    requireString(source.name, `${role} name`);
    requireString(source.officialUrl, `${role} officialUrl`);
    requireString(source.resourceId, `${role} resourceId`);
    requireString(source.releaseId, `${role} releaseId`);
    if (source.schemaVersion !== schemaVersion) throw new TypeError(`unsupported schema for ${role}`);
    if (!Number.isSafeInteger(source.byteSize) || source.byteSize <= 0) throw new TypeError(`invalid byteSize for ${role}`);
    if (!Number.isSafeInteger(source.rowCount) || source.rowCount < 0) throw new TypeError(`invalid rowCount for ${role}`);
    if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw new TypeError(`digest absent or invalid for ${role}`);
    if (!Array.isArray(source.requiredFields) || source.requiredFields.length === 0) {
      throw new TypeError(`requiredFields missing for ${role}`);
    }

    const actual = inventory && inventory[role];
    if (!actual) throw new TypeError(`inventory missing for ${role}`);
    if (actual.byteSize !== source.byteSize) throw new TypeError(`byte size mismatch for ${role}`);
    if (actual.rowCount !== source.rowCount) throw new TypeError(`row count incomplete for ${role}`);
    if (actual.sha256 !== source.sha256) throw new TypeError(`digest mismatch for ${role}`);
    const fields = new Set(actual.fields || []);
    for (const field of source.requiredFields) {
      if (!fields.has(field)) throw new TypeError(`required field ${field} missing from ${role}`);
    }
  }

  const csclReleases = new Set([...byRole.entries()]
    .filter(([role]) => role.startsWith('cscl_'))
    .map(([, source]) => source.releaseId));
  if (csclReleases.size !== 1) throw new TypeError('duplicate incompatible CSCL source versions');

  return {
    ok: true,
    manifestDigest: manifestIdentity(manifest),
    sourceRelease: {
      cscl: [...csclReleases][0],
      pavementEdge: byRole.get('pavement_edge').releaseId,
    },
  };
};

module.exports = { manifestIdentity, validateSnapshotManifest };
