import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCanonicalCurb, hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');
const { proveCanonicalCurbIdentity } = require('./canonicalCurbIdentityProof');
const {
  ARTIFACT_PATH,
  localRuntimeDependencies,
  pilotRuntimeDependencies,
  simulateDeploymentPilot,
} = require('./runtimeSourceArtifact');
const { ALLOWLIST_PATH, deploymentPilotEnabled, applyPilotAllowlist } = require('./pilotSourceLoading');

const SYNTHETIC_SIDE_LOCATION = Object.freeze({
  lat: 40.70008, lng: -73.9995, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 2,
});

function batteryRow() {
  return {
    globalid: 'retained-battery-place-row',
    physicalid: '5',
    b5sc: '112670',
    boroughcode: '1',
    rw_type: '1',
    full_street_name: 'BATTERY PLACE',
    street_name: 'BATTERY PLACE',
    stname_label: 'BATTERY PL',
    streetwidth: '42',
    from_level_code: 'M',
    to_level_code: 'M',
    status: '2',
    l_blockfaceid: '1222600642',
    r_blockfaceid: '1222604562',
    the_geom: { type: 'MultiLineString', coordinates: [[[-74.001, 40.7], [-73.999, 40.7]]] },
  };
}

function resolverOptions(row, extra = {}) {
  return {
    fetchFn: vi.fn(async url => ({
      ok: true,
      json: async () => (String(url).includes('/api/views/')
        ? { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 }
        : [row]),
    })),
    getSocrataToken: () => '',
    planimetricStore: {
      queryCurbs: vi.fn(async () => ({
        candidates: [],
        completeness: { state: 'COMPLETE', reason: null },
        sourceVersion: { resourceId: '5xvt-8cbk', version: 'fixture-plan-v1' },
      })),
    },
    requestNonce: 'request-nonce',
    ...extra,
  };
}

function contextFor(evidence, record) {
  return evidence.streetContextFor({
    sourceNative: { physicalid: record.physicalId },
    leftBlockFaceId: record.leftBlockFaceId,
    rightBlockFaceId: record.rightBlockFaceId,
  });
}

describe('deployment pilot source loading', () => {
  it('stays off unless a deployment-owned simulation authorizes the fixed artifact', async () => {
    expect(deploymentPilotEnabled()).toBe(false);
    expect(pilotRuntimeDependencies()).toEqual({});
    expect(pilotRuntimeDependencies({ ownerApproval: 'APPROVED', certificationStatus: 'CERTIFIED' })).toEqual({});
    expect(localRuntimeDependencies()).toEqual({});
    expect(simulateDeploymentPilot()).toEqual({});
    expect(simulateDeploymentPilot({
      deploymentOwner: 'parqueen-server-pilot',
      enabled: true,
      ownerApproval: 'APPROVED',
      certificationStatus: 'CERTIFIED',
      artifactPath: 'C:/tmp/other-artifact.json',
      mode: 'shadow',
    })).toEqual({});
    expect(JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')).restrictPhysicalIds).toBe(false);

    const authorization = {
      deploymentOwner: 'parqueen-server-pilot',
      enabled: true,
      verifiedUid: 'pilotfixture00000000000001',
      principal: 'pilotfixture00000000000001',
      restrictPhysicalIds: true,
      physicalIds: ['5', '24', '85'],
    };
    const pilot = simulateDeploymentPilot(authorization);
    const again = simulateDeploymentPilot(authorization);
    expect(again.privateSourceEvidence).toBe(pilot.privateSourceEvidence);
    expect(pilot.privateSourceEvidence.sourceAdmission).toMatchObject({
      sourceCertification: 'NOT_CERTIFIED',
      ownerApproval: 'PENDING',
      releaseCandidate: 'ELIGIBLE_PENDING_OWNER_APPROVAL',
      active: false,
    });
    const switched = simulateDeploymentPilot({
      deploymentOwner: 'parqueen-server-pilot',
      enabled: true,
      verifiedUid: 'pilotfixture00000000000001',
      principal: 'pilotfixture00000000000001',
      restrictPhysicalIds: false,
    });
    expect(switched).toEqual({});

    const document = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'));
    const battery = document.records.find(record => record.physicalId === '5');
    const westThames = document.records.find(record => record.physicalId === '24');
    const pearl = document.records.find(record => record.physicalId === '85');
    const outsideAllowlist = document.records.find(record => !['5', '24', '85'].includes(record.physicalId));
    expect(contextFor(pilot.privateSourceEvidence, battery)).toMatchObject({
      fromStreet: '2 PLACE', toStreet: '3 PLACE', segmentId: '0018126',
    });
    expect(contextFor(pilot.privateSourceEvidence, westThames).fromStreet).toBe(westThames.primaryNames.fromStreet);
    expect(contextFor(pilot.privateSourceEvidence, pearl).fromStreet).toBe(pearl.primaryNames.fromStreet);
    expect(contextFor(pilot.privateSourceEvidence, outsideAllowlist)).toBeNull();
    const closed = applyPilotAllowlist(pilot.privateSourceEvidence, {
      restrictPhysicalIds: false,
      physicalIds: [],
    });
    expect(contextFor(closed, battery)).toBeNull();

    const row = batteryRow();
    const seen = [];
    const blockfaceResolver = { resolve: vi.fn() };
    const resolution = await resolveCanonicalCurb(SYNTHETIC_SIDE_LOCATION, resolverOptions(row, {
      ...pilot,
      privateSourceContextObserver: report => seen.push(report),
    }));
    const proof = await proveCanonicalCurbIdentity(resolution, { blockfaceResolver });
    expect(row.from_street).toBeUndefined();
    expect(row.to_street).toBeUndefined();
    expect(seen[0].enrichment).toMatchObject({
      fromStreet: '2 PLACE', toStreet: '3 PLACE', certificationStatus: 'NOT_CERTIFIED', side: null,
    });
    expect(resolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['topology_primary_required'] });
    expect(hasPrimaryTopologyAuthority(resolution)).toBe(false);
    expect(proof).toEqual({ state: 'IDENTITY_NOT_PROVEN', reason: 'topology_primary_required' });
    expect(blockfaceResolver.resolve).not.toHaveBeenCalled();
  });

  it('keeps the pinned artifact outside the Functions upload', () => {
    expect(deploymentPilotEnabled()).toBe(false);
    const functionsRoot = fileURLToPath(new URL('..', import.meta.url));
    expect(relative(functionsRoot, ARTIFACT_PATH).startsWith('..')).toBe(true);
    expect(statSync(ARTIFACT_PATH).size).toBe(42965252);
    const firebase = JSON.parse(readFileSync(new URL('../../firebase.json', import.meta.url), 'utf8'));
    expect(firebase.functions.source).toBe('functions');
  });
});
