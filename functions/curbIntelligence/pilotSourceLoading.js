'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Deployment-owned switch. A request body cannot change it.
const DEPLOYMENT_PILOT_ENABLED = false;
const PILOT_PRINCIPAL_ENV = 'SI_PILOT_PRINCIPAL_UID';
const ALLOWLIST_PATH = path.join(__dirname, 'pilot-source-allowlist.json');
const PHYSICAL_ID = /^\d{1,10}$/;

function deploymentPilotEnabled() {
  return DEPLOYMENT_PILOT_ENABLED === true;
}

function validPrincipal(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) return false;
  if (value.includes('*') || value.includes(',')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code > 0x7e) return false;
  }
  return true;
}

function readDeploymentPilotPrincipal(env = process.env) {
  const raw = env?.[PILOT_PRINCIPAL_ENV];
  return validPrincipal(raw) ? raw : '';
}

function ownerPilotAllows({ enabled, verifiedUid, principal, coverage } = {}) {
  if (enabled !== true) return false;
  if (!validPrincipal(principal) || verifiedUid !== principal) return false;
  return coverage?.restrictPhysicalIds === true
    && Array.isArray(coverage.physicalIds)
    && coverage.physicalIds.length > 0;
}

function canonicalPhysicalId(value) {
  if (typeof value !== 'string' || !PHYSICAL_ID.test(value)) return null;
  return value.replace(/^0+/, '') || '0';
}

function validatePilotAllowlist(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, reason: 'pilot_allowlist_closed' };
  }
  if (document.restrictPhysicalIds === false) {
    return { ok: true, document: { restrictPhysicalIds: false, physicalIds: [] } };
  }
  if (document.restrictPhysicalIds !== true || !Array.isArray(document.physicalIds)) {
    return { ok: false, reason: 'pilot_allowlist_closed' };
  }
  const physicalIds = [];
  for (const value of document.physicalIds) {
    const id = canonicalPhysicalId(value);
    if (!id || physicalIds.includes(id)) return { ok: false, reason: 'pilot_allowlist_closed' };
    physicalIds.push(id);
  }
  if (physicalIds.length === 0) return { ok: false, reason: 'pilot_allowlist_closed' };
  return { ok: true, document: { restrictPhysicalIds: true, physicalIds } };
}

function readPilotAllowlistDocument() {
  try {
    return validatePilotAllowlist(JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')));
  } catch {
    return { ok: false, reason: 'pilot_allowlist_closed' };
  }
}

function closePilotEvidence(evidence) {
  return Object.freeze({
    ok: true,
    owner: evidence.owner,
    reason: 'pilot_allowlist_closed',
    sourceAdmission: evidence.sourceAdmission,
    streetContextFor(record) {
      const inner = typeof evidence.streetContextFor === 'function' ? evidence.streetContextFor(record) : null;
      if (inner && inner.ok === false) return inner;
      return null;
    },
  });
}

function applyPilotAllowlist(evidence, document) {
  const validation = validatePilotAllowlist(document);
  if (evidence?.ok !== true) return evidence;
  if (!validation.ok || validation.document.restrictPhysicalIds !== true) {
    return closePilotEvidence(evidence);
  }
  const allowed = new Set(validation.document.physicalIds);
  return Object.freeze({
    ok: true,
    owner: evidence.owner,
    reason: null,
    sourceAdmission: evidence.sourceAdmission,
    streetContextFor(record) {
      const inner = evidence.streetContextFor(record);
      if (inner && inner.ok === false) return inner;
      const key = canonicalPhysicalId(String(record?.sourceNative?.physicalid ?? ''))
        || String(record?.sourceNative?.physicalid ?? '');
      if (!allowed.has(key)) return null;
      return inner;
    },
  });
}

module.exports = {
  ALLOWLIST_PATH,
  PILOT_PRINCIPAL_ENV,
  deploymentPilotEnabled,
  readDeploymentPilotPrincipal,
  ownerPilotAllows,
  validatePilotAllowlist,
  readPilotAllowlistDocument,
  applyPilotAllowlist,
};
