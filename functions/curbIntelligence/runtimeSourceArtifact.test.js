import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const { resolveCanonicalCurb, hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');
const { proveCanonicalCurbIdentity } = require('./canonicalCurbIdentityProof');
const { runCanonicalCurbOrchestrator } = require('./canonicalCurbOrchestrator');
const {
  ARTIFACT_PATH,
  MAX_ARTIFACT_BYTES,
  PINNED_ARTIFACT_SHA256,
  PINNED_SOURCES,
  loadPinnedRuntimeArtifact,
  openRuntimeSourceArtifact,
  reviewRuntimeArtifactDocument,
  localRuntimeDependencies,
} = require('./runtimeSourceArtifact');

const RETAINED_CENTERLINE = [[[-74.017575674546, 40.706848105307], [-74.017121822757, 40.707470769174]]];
const SYNTHETIC_SIDE_LOCATION = Object.freeze({
  lat: 40.70718553307595, lng: -74.01741105206648, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 2,
});
const SYNTHETIC_CENTERLINE_BAND = Object.freeze({
  lat: 40.70716378654642, lng: -74.01735913255399, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 2,
});
const SYNTHETIC_ENDPOINT = Object.freeze({
  lat: 40.706856803949975, lng: -74.0175964422312, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 2,
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

const location = () => ({
  lat: 40.70008, lng: -73.9995, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 2,
});

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

function emulatorDependencies() {
  const previous = process.env.FUNCTIONS_EMULATOR;
  process.env.FUNCTIONS_EMULATOR = 'true';
  try {
    return localRuntimeDependencies();
  } finally {
    if (previous === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = previous;
  }
}

function readArtifact() {
  return readFileSync(ARTIFACT_PATH);
}

describe('pinned runtime source artifact', () => {
  // Parsing the pinned 43 MB artifact during the full suite exceeds Vitest's
  // default 5s on a loaded Windows checkout. Every assertion below stays.
  it('verifies the artifact digest separately from source certification', () => {
    const bytes = readArtifact();
    const document = JSON.parse(bytes.toString('utf8'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(PINNED_ARTIFACT_SHA256);
    expect(bytes.length).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
    expect(document.citywide).toBe(false);
    expect(document.coverage).toBe('IDENTIFIED_CROSS_STREET_PAIRS');
    expect(document.records.length).toBe(document.coverageManifest.unambiguousPairs);
    expect(document.records.length).toBeGreaterThan(2);
    expect(document.certificationStatus).toBe('NOT_CERTIFIED');
    expect(document.releaseCertification).toBe('BLOCKED');
    expect(document.editions).toMatchObject({
      lionPackage: '26B', sndPackage: '26B', pdfPageCitation: '26B', pdfTitle: '26C',
    });
    expect(document.sources.lion).toMatchObject(PINNED_SOURCES.lion);
    expect(document.sources.snd).toMatchObject(PINNED_SOURCES.snd);
    expect(document.sources.cscl).toMatchObject(PINNED_SOURCES.cscl);
    expect(loadPinnedRuntimeArtifact().sourceAdmission).toMatchObject({
      editionReconciled: true,
      releaseCandidate: 'ELIGIBLE_PENDING_OWNER_APPROVAL',
      sourceCertification: 'NOT_CERTIFIED',
      topologyAuthority: 'UNRESOLVED',
      active: false,
      ownerApproval: 'PENDING',
    });
    expect(document.successorRelease).toMatchObject({
      policyVersion: 'successor-release-candidate-1',
      frozenReadinessPolicy: 'ONE_CONSISTENT_RELEASE_OBSERVATION',
      coverage: 'IDENTIFIED_CROSS_STREET_PAIRS',
      citywide: false,
      active: false,
      ownerApproval: 'PENDING',
    });
    const battery = document.records.find(record => String(record.physicalId) === '5');
    expect(battery.streetCodes).toMatchObject({
      onStreet: '112670', fromStreet: '110115', toStreet: '110250',
    });
    expect(battery.primaryNames).toMatchObject({ fromStreet: '2 PLACE', toStreet: '3 PLACE' });
    const approved = structuredClone(document);
    approved.successorRelease.ownerApproval = 'APPROVED';
    approved.successorRelease.decision.ownerApproval = 'APPROVED';
    approved.successorRelease.decision.sourceCertification = 'CERTIFIED';
    const wrongFace = structuredClone(document);
    wrongFace.records.find(record => String(record.physicalId) === '5').leftBlockFaceId = '0000000001';
    expect(reviewRuntimeArtifactDocument(approved).reason).toBe('conflicting_source_version');
    expect(reviewRuntimeArtifactDocument(wrongFace).reason).toBe('conflicting_source_version');
    expect(localRuntimeDependencies()).toEqual({});
    const functionsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    expect(relative(functionsRoot, ARTIFACT_PATH).startsWith('..')).toBe(true);
    const renderScript = resolve(functionsRoot, '../data/runtime-source/render-runtime-source-artifact.js');
    expect(relative(functionsRoot, renderScript).startsWith('..')).toBe(true);
    const firebase = JSON.parse(readFileSync(new URL('../../firebase.json', import.meta.url), 'utf8'));
    expect(firebase.functions.source).toBe('functions');
  }, 20_000);

  it('loads the artifact in emulator mode and reaches buildCandidate without primary authority', async () => {
    const row = batteryRow();
    const seen = [];
    const blockfaceResolver = { resolve: vi.fn() };
    const dependencies = emulatorDependencies();
    const resolution = await resolveCanonicalCurb(location(), resolverOptions(row, {
      ...dependencies,
      privateSourceContextObserver: report => seen.push(report),
    }));
    const proof = await proveCanonicalCurbIdentity(resolution, { blockfaceResolver });

    expect(row.from_street).toBeUndefined();
    expect(row.to_street).toBeUndefined();
    expect(seen[0]).toMatchObject({
      identityReason: null,
      enrichment: {
        fromStreet: '2 PLACE',
        toStreet: '3 PLACE',
        physicalId: '5',
        segmentId: '0018126',
        certificationStatus: 'NOT_CERTIFIED',
        canonicalSupported: false,
        side: null,
      },
    });
    expect(seen[0].enrichment.fromNode.secondaryNames).toEqual(['SECOND PLACE']);
    expect(seen[0].enrichment.toNode.secondaryNames).toEqual(['THIRD PLACE']);
    expect(seen[0].enrichment.fromNode.nodeNames).toEqual([' 2 PL', ' BATTERY PL']);
    expect(resolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['topology_primary_required'] });
    expect(resolution.state).not.toBe('SUPPORTED');
    expect(hasPrimaryTopologyAuthority(resolution)).toBe(false);
    expect(proof).toEqual({ state: 'IDENTITY_NOT_PROVEN', reason: 'topology_primary_required' });
    expect(blockfaceResolver.resolve).not.toHaveBeenCalled();
  });

  it('lets the real classifier judge a synthetic offset from the retained centerline', async () => {
    const row = { ...batteryRow(), the_geom: { type: 'MultiLineString', coordinates: RETAINED_CENTERLINE } };
    const seen = [];
    const blockfaceResolver = { resolve: vi.fn() };
    const dependencies = emulatorDependencies();
    const resolution = await resolveCanonicalCurb(SYNTHETIC_SIDE_LOCATION, resolverOptions(row, {
      ...dependencies,
      privateSourceContextObserver: report => seen.push(report),
    }));
    const proof = await proveCanonicalCurbIdentity(resolution, { blockfaceResolver });
    const published = await runCanonicalCurbOrchestrator({
      protocolVersion: 2,
      location: SYNTHETIC_SIDE_LOCATION,
    }, resolverOptions(row, { ...dependencies, blockfaceResolver }));

    expect(row.from_street).toBeUndefined();
    expect(seen[0].enrichment.fromStreet).toBe('2 PLACE');
    expect(seen[0].enrichment.toStreet).toBe('3 PLACE');
    expect(resolution.classifierState).toBe('SUPPORTED');
    expect(resolution.classifierReasons).toEqual([]);
    expect(resolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['topology_primary_required'] });
    expect(hasPrimaryTopologyAuthority(resolution)).toBe(false);
    expect(proof.reason).toBe('topology_primary_required');
    expect(published).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
    expect(published.classifierState).toBeUndefined();
    expect(blockfaceResolver.resolve).not.toHaveBeenCalled();
  });

  it('keeps centerline and endpoint uncertainty from becoming primary authority', async () => {
    const row = { ...batteryRow(), the_geom: { type: 'MultiLineString', coordinates: RETAINED_CENTERLINE } };
    const dependencies = emulatorDependencies();
    const centerline = await resolveCanonicalCurb(SYNTHETIC_CENTERLINE_BAND, resolverOptions(row, dependencies));
    const endpoint = await resolveCanonicalCurb(SYNTHETIC_ENDPOINT, resolverOptions(row, dependencies));

    expect(centerline).toMatchObject({ state: 'UNSUPPORTED', reasons: ['ambiguity_unresolved'] });
    expect(endpoint).toMatchObject({ state: 'UNSUPPORTED', reasons: ['ambiguity_unresolved'] });
    expect(centerline.classifierState).toBeUndefined();
    expect(endpoint.classifierState).toBeUndefined();
    expect(hasPrimaryTopologyAuthority(centerline)).toBe(false);
    expect(hasPrimaryTopologyAuthority(endpoint)).toBe(false);
  });

  it('rejects a retrieval that is not an authoritative CSCL population', async () => {
    const dependencies = emulatorDependencies();
    const resolution = await resolveCanonicalCurb(SYNTHETIC_SIDE_LOCATION, {
      ...dependencies,
      candidateStore: {
        queryCandidates: async () => ({
          candidates: [],
          completeness: { state: 'INCOMPLETE', reason: 'source_unavailable' },
        }),
      },
      requestNonce: 'incomplete-population',
    });

    expect(resolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['authority_attestation_invalid'] });
    expect(resolution.classifierState).toBeUndefined();
    expect(hasPrimaryTopologyAuthority(resolution)).toBe(false);
  });

  it('keeps the production path closed and ignores client street fields', async () => {
    const blockfaceResolver = { resolve: vi.fn() };
    const disabled = await resolveCanonicalCurb(location(), resolverOptions(batteryRow()));
    const client = await runCanonicalCurbOrchestrator({
      protocolVersion: 2,
      location: location(),
      from_street: 'FAKE STREET',
      to_street: 'FAKE STREET',
      privateSourceContextEnrichment: 'shadow-uncertified-context',
      certificationStatus: 'CERTIFIED',
      artifactPath: ARTIFACT_PATH,
    }, {
      ...resolverOptions(batteryRow()),
      blockfaceResolver,
    });

    expect(process.env.FUNCTIONS_EMULATOR).toBeUndefined();
    expect(disabled).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_incomplete'] });
    expect(disabled.state).not.toBe('SUPPORTED');
    expect(client).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete' });
    expect(blockfaceResolver.resolve).not.toHaveBeenCalled();
  });

  it('fails closed when the pinned artifact is missing or its digest does not match', async () => {
    const originalRead = fs.readFileSync;
    const pinned = originalRead(ARTIFACT_PATH);
    const altered = Buffer.from(pinned);
    altered[altered.length - 2] ^= 1;
    const simulatedReads = { missing: 0, mismatch: 0 };
    let mode = 'missing';
    fs.readFileSync = function readPinnedArtifact(filePath, ...rest) {
      if (filePath !== ARTIFACT_PATH) return originalRead.call(this, filePath, ...rest);
      simulatedReads[mode] += 1;
      if (mode === 'missing') {
        const error = new Error(`ENOENT: no such file or directory, open '${ARTIFACT_PATH}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return Buffer.from(altered);
    };
    try {
      const missing = emulatorDependencies();
      const missingResolution = await resolveCanonicalCurb(location(), resolverOptions(batteryRow(), {
        ...missing,
        privateSourceContextObserver: report => { missing.report = report; },
      }));
      expect(simulatedReads.missing).toBeGreaterThan(0);
      expect(missing.privateSourceEvidence.reason).toBe('artifact_missing');
      expect(missingResolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_incomplete'] });
      expect(missing.report).toMatchObject({ enrichment: null, identityReason: 'artifact_missing' });

      mode = 'mismatch';
      const mismatched = emulatorDependencies();
      const mismatchedResolution = await resolveCanonicalCurb(location(), resolverOptions(batteryRow(), {
        ...mismatched,
        privateSourceContextObserver: report => { mismatched.report = report; },
      }));
      expect(simulatedReads.mismatch).toBeGreaterThan(0);
      expect(openRuntimeSourceArtifact(altered).reason).toBe('artifact_digest_mismatch');
      expect(mismatched.privateSourceEvidence.reason).toBe('artifact_digest_mismatch');
      expect(mismatchedResolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_incomplete'] });
      expect(mismatched.report.identityReason).toBe('artifact_digest_mismatch');
      expect(hasPrimaryTopologyAuthority(mismatchedResolution)).toBe(false);
    } finally {
      fs.readFileSync = originalRead;
    }
    expect(fs.readFileSync).toBe(originalRead);
    expect(Buffer.compare(originalRead(ARTIFACT_PATH), pinned)).toBe(0);
    expect(createHash('sha256').update(readArtifact()).digest('hex')).toBe(PINNED_ARTIFACT_SHA256);
  });

  it('fails closed for conflicting editions and ambiguous incident relationships', async () => {
    const document = JSON.parse(readArtifact().toString('utf8'));
    const conflicting = structuredClone(document);
    conflicting.editions.lionPackage = '26C';
    const ambiguous = structuredClone(document);
    const battery = ambiguous.records.find(record => String(record.physicalId) === '5');
    ambiguous.dictionaries.segments.push([
      '0099999', '1', 'WASHINGTON STREET', '199999', battery.nodeIdFrom, '0000001',
      'M', 'M', '01', '  ', '  ', '  ', '  ', '0', 'U',
    ]);
    battery.segments.push(ambiguous.dictionaries.segments.length - 1);
    const conflictingEvidence = reviewRuntimeArtifactDocument(conflicting);
    const ambiguousEvidence = reviewRuntimeArtifactDocument(ambiguous);
    const { ENRICHMENT_MODE, SHADOW_EVALUATION } = require('./privateSourceContextRetention');

    for (const [evidence, reason] of [
      [conflictingEvidence, 'conflicting_source_version'],
      [ambiguousEvidence, 'ambiguous_street_code'],
    ]) {
      const seen = [];
      const resolution = await resolveCanonicalCurb(location(), resolverOptions(batteryRow(), {
        privateSourceContextEnrichment: ENRICHMENT_MODE,
        evaluationScope: SHADOW_EVALUATION,
        privateSourceEvidence: evidence,
        privateSourceContextObserver: report => seen.push(report),
      }));
      expect(evidence.reason).toBe(reason);
      expect(resolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_incomplete'] });
      expect(resolution.state).not.toBe('SUPPORTED');
      expect(seen[0]).toMatchObject({ enrichment: null, identityReason: reason });
    }
  });

  it('leaves App Check, protocol v2, and the callable options unchanged', () => {
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const callable = index.slice(index.indexOf('exports.createSegmentFromSweepNYC'), index.indexOf('exports.createSegmentFromSweepNYC') + 1200);
    const runtimeStart = index.indexOf('async function _runCanonicalCurbV2');
    const runtime = index.slice(runtimeStart, index.indexOf('// ─── Hydrant', runtimeStart));
    expect(callable).toContain('enforceAppCheck: true');
    expect(callable).toContain("request.data?.protocolVersion !== 2");
    expect(runtime).toContain("process.env.FUNCTIONS_EMULATOR === 'true'");
    expect(runtime).toContain('localRuntimeDependencies()');
    expect(runtime).toContain('attachOwnerPilot(orchestratorDependencies, verifiedUid)');
    expect(runtime).not.toContain('pilotRuntimeDependencies(request');
    expect(runtime).not.toContain('request.data.uid');
    expect(runtime).not.toContain('from_street');
    expect(runtime).not.toContain('artifactPath');
  });
});
