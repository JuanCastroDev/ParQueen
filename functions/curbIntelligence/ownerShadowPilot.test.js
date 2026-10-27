import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCanonicalCurb, buildCandidate, hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');
const { proveCanonicalCurbIdentity } = require('./canonicalCurbIdentityProof');
const { runCanonicalCurbOrchestrator } = require('./canonicalCurbOrchestrator');
const { createCurbTelemetry } = require('./curbTelemetry');
const {
  ARTIFACT_PATH,
  openRuntimeSourceArtifact,
  reviewRuntimeArtifactDocument,
  pilotRuntimeDependencies,
  attachOwnerPilot,
  simulateDeploymentPilot,
} = require('./runtimeSourceArtifact');
const {
  PILOT_PRINCIPAL_ENV,
  deploymentPilotEnabled,
  readDeploymentPilotPrincipal,
  ownerPilotAllows,
  readPilotAllowlistDocument,
} = require('./pilotSourceLoading');

const SYNTHETIC_PRINCIPAL = 'pilotfixture00000000000001';
const OTHER_PRINCIPAL = 'otherfixture00000000000002';
const SYNTHETIC_LOCATION = Object.freeze({
  lat: 40.70008, lng: -73.9995, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 2,
});

function localPilot(extra = {}) {
  return {
    deploymentOwner: 'parqueen-server-pilot',
    enabled: true,
    verifiedUid: SYNTHETIC_PRINCIPAL,
    principal: SYNTHETIC_PRINCIPAL,
    restrictPhysicalIds: true,
    physicalIds: ['5', '24', '85'],
    ...extra,
  };
}

function candidateGroup(record) {
  const sourceNative = {
    physicalid: String(record.physicalId),
    boroughcode: '1',
    full_street_name: record.street,
    streetwidth: '30',
    globalid: `retained-${record.physicalId}`,
  };
  const row = {
    globalId: sourceNative.globalid,
    sourceVersion: { resourceId: 'inkn-q76z', version: '1792226103:1744725948' },
    leftBlockFaceId: record.leftBlockFaceId,
    rightBlockFaceId: record.rightBlockFaceId,
    geometry: { type: 'MultiLineString', coordinates: [[[-74.01, 40.7], [-74.0, 40.71]]] },
    projection: { csclSide: 'LEFT', tangent: { eastMeters: 1, northMeters: 0 } },
    sourceNative,
  };
  return { best: row, group: { records: [row] } };
}

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

describe('owner-restricted shadow pilot', () => {
  it('fails closed without a deployment principal and ignores client fields', () => {
    expect(deploymentPilotEnabled()).toBe(false);
    const tracked = readFileSync(new URL('../.env.parkqueen-46475363-ccf36', import.meta.url), 'utf8');
    expect(tracked).not.toContain(PILOT_PRINCIPAL_ENV);
    expect(readDeploymentPilotPrincipal({})).toBe('');
    expect(readDeploymentPilotPrincipal({ [PILOT_PRINCIPAL_ENV]: '*' })).toBe('');
    expect(readDeploymentPilotPrincipal({ [PILOT_PRINCIPAL_ENV]: `${SYNTHETIC_PRINCIPAL},${OTHER_PRINCIPAL}` })).toBe('');
    const allowlist = readPilotAllowlistDocument();
    expect(allowlist.document.restrictPhysicalIds).toBe(false);
    expect(ownerPilotAllows({
      enabled: true,
      verifiedUid: SYNTHETIC_PRINCIPAL,
      principal: SYNTHETIC_PRINCIPAL,
      coverage: allowlist.document,
    })).toBe(false);
    expect(ownerPilotAllows({
      enabled: true,
      verifiedUid: OTHER_PRINCIPAL,
      principal: SYNTHETIC_PRINCIPAL,
      coverage: { restrictPhysicalIds: true, physicalIds: ['5'] },
    })).toBe(false);
    const previous = process.env[PILOT_PRINCIPAL_ENV];
    process.env[PILOT_PRINCIPAL_ENV] = SYNTHETIC_PRINCIPAL;
    const lines = [];
    const dependencies = { telemetry: createCurbTelemetry({ write: line => lines.push(JSON.parse(line)) }) };
    try {
      expect(pilotRuntimeDependencies(SYNTHETIC_PRINCIPAL)).toEqual({});
      expect(pilotRuntimeDependencies({ uid: SYNTHETIC_PRINCIPAL, mode: 'shadow' })).toEqual({});
      attachOwnerPilot(dependencies, SYNTHETIC_PRINCIPAL);
    } finally {
      if (previous === undefined) delete process.env[PILOT_PRINCIPAL_ENV];
      else process.env[PILOT_PRINCIPAL_ENV] = previous;
    }
    expect(dependencies.privateSourceEvidence).toBeUndefined();
    expect(lines).toEqual([{ event: 'curb_pilot_diagnostic', protocolVersion: 2, pilotStage: 'pilot_closed' }]);
    expect(JSON.stringify(lines)).not.toContain(SYNTHETIC_PRINCIPAL);
    expect(simulateDeploymentPilot(localPilot({ verifiedUid: OTHER_PRINCIPAL }))).toEqual({});
    expect(simulateDeploymentPilot(localPilot({ verifiedUid: undefined }))).toEqual({});
    expect(simulateDeploymentPilot(localPilot({ principal: '' }))).toEqual({});
    expect(simulateDeploymentPilot(localPilot({ uid: SYNTHETIC_PRINCIPAL }))).toEqual({});
    expect(simulateDeploymentPilot(localPilot({ mode: 'shadow' }))).toEqual({});
    expect(openRuntimeSourceArtifact(Buffer.from('not-the-pinned-artifact')).reason).toBe('artifact_digest_mismatch');
  });

  it('enriches only the authorized local coverage and withholds authority', async () => {
    const document = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'));
    const conflicting = { ...document, certificationStatus: 'CERTIFIED' };
    expect(reviewRuntimeArtifactDocument(conflicting).reason).toBe('conflicting_source_version');
    const lines = [];
    const telemetry = createCurbTelemetry({ write: line => lines.push(JSON.parse(line)) });
    const pilot = simulateDeploymentPilot(localPilot());
    expect(pilot.privateSourceEvidence.sourceAdmission.sourceCertification).toBe('NOT_CERTIFIED');
    const expected = {
      5: ['2 PLACE', '3 PLACE'],
      24: ['BATTERY PLACE', 'SOUTH END AVENUE'],
      85: ['COENTIES SLIP', 'COENTIES ALLEY'],
    };
    for (const [id, streets] of Object.entries(expected)) {
      const record = document.records.find(item => String(item.physicalId) === id);
      const failure = { reason: null, enrichment: null };
      const candidate = buildCandidate(candidateGroup(record), {
        evidence: pilot.privateSourceEvidence,
        identityFailure: failure,
      });
      expect(candidate.identity.names).toMatchObject({
        onStreet: record.street,
        fromStreet: streets[0],
        toStreet: streets[1],
      });
      expect(failure.enrichment).toMatchObject({
        fromStreet: streets[0], toStreet: streets[1], certificationStatus: 'NOT_CERTIFIED',
      });
    }
    const uncovered = document.coverageManifest.rejectionSamples.find(sample => sample.bucket === 'conflicting_code');
    const uncoveredFailure = { reason: null, enrichment: null };
    expect(buildCandidate(candidateGroup({
      physicalId: uncovered.physicalId,
      street: 'UNRESOLVED STREET',
      leftBlockFaceId: '1000000098',
      rightBlockFaceId: '1000000099',
    }), {
      evidence: pilot.privateSourceEvidence,
      identityFailure: uncoveredFailure,
    })).toBeNull();
    expect(uncoveredFailure.reason).toBe('invalid_street_context');

    const row = batteryRow();
    const persist = vi.fn();
    const blockfaceResolver = { resolve: vi.fn() };
    const opened = await runCanonicalCurbOrchestrator(
      { protocolVersion: 2, location: SYNTHETIC_LOCATION },
      resolverOptions(row, { ...pilot, telemetry, persistCanonicalCurb: persist, blockfaceResolver }),
    );
    const closed = await runCanonicalCurbOrchestrator(
      { protocolVersion: 2, location: SYNTHETIC_LOCATION },
      resolverOptions(row, { telemetry, persistCanonicalCurb: persist, blockfaceResolver }),
    );
    const resolution = await resolveCanonicalCurb(
      SYNTHETIC_LOCATION,
      resolverOptions(row, { ...pilot, telemetry, blockfaceResolver }),
    );
    const unavailable = await resolveCanonicalCurb(
      SYNTHETIC_LOCATION,
      resolverOptions(row, {
        ...pilot,
        telemetry,
        fetchFn: vi.fn(async () => ({ ok: false, status: 503, json: async () => [] })),
      }),
    );
    const proof = await proveCanonicalCurbIdentity(resolution, { blockfaceResolver });
    expect(opened).toMatchObject({ protocolVersion: 2, status: 'unsupported' });
    expect(opened.status).not.toBe('high_confidence');
    expect(closed).toMatchObject({ protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete' });
    expect(resolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['topology_primary_required'] });
    expect(unavailable.state).toBe('UNSUPPORTED');
    expect(hasPrimaryTopologyAuthority(resolution)).toBe(false);
    expect(hasPrimaryTopologyAuthority(unavailable)).toBe(false);
    expect(proof).toEqual({ state: 'IDENTITY_NOT_PROVEN', reason: 'topology_primary_required' });
    expect(blockfaceResolver.resolve).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    const stages = lines.map(line => line.pilotStage).filter(Boolean);
    expect(stages).toEqual([
      'cscl_admitted',
      'enrichment_accepted',
      'source_not_certified',
      'topology_primary_rejected',
      'native_proof_not_invoked',
      'cscl_admitted',
      'enrichment_accepted',
      'source_not_certified',
      'topology_primary_rejected',
      'native_proof_not_invoked',
    ]);
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(SYNTHETIC_PRINCIPAL);
    expect(logged).not.toContain('40.70008');
    expect(logged).not.toContain('app-check-token');
  });
});
