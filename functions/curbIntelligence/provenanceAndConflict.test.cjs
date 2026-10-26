'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = 'C:/Users/jayca/AppData/Local/ParQueen/si-source-26c-05a/repo';
const SUCCESSOR_PATH = 'C:/Users/jayca/AppData/Local/ParQueen/si-source-26c-04c/artifacts/candidate-26c-pass1.json';
const ARTIFACT = path.join(ROOT, 'data/runtime-source/runtime-source-artifact.json');
const {
  bindServerSourceEvidence,
  coverServerSourceEvidence,
  ENRICHMENT_MODE,
  SHADOW_EVALUATION,
} = require(path.join(ROOT, 'functions/curbIntelligence/privateSourceContextRetention.js'));
const { buildCandidate, resolveCanonicalCurb } = require(path.join(ROOT, 'functions/curbIntelligence/canonicalCurbResolver.js'));
const { applyPilotAllowlist } = require(path.join(ROOT, 'functions/curbIntelligence/pilotSourceLoading.js'));
const { expandCoverageRecords } = require(path.join(ROOT, 'functions/curbIntelligence/pilotArtifactRecords.js'));
const {
  reviewRuntimeArtifactDocument,
  openRuntimeSourceArtifact,
  buildSuccessorRelease,
  PINNED_SOURCES,
  PINNED_ARTIFACT_SHA256,
  simulateDeploymentPilot,
} = require(path.join(ROOT, 'functions/curbIntelligence/runtimeSourceArtifact.js'));

const AMBIGUOUS = ['40227', '79167', '89943', '189709'];
const successorBytes = fs.readFileSync(SUCCESSOR_PATH);
const successor = JSON.parse(successorBytes.toString('utf8'));
const outcomes = successor.coverageManifest.authoritativeOutcomes;
const expanded = expandCoverageRecords(successor);
const byExpanded = new Map(expanded.map(record => [String(record.onStreet.physicalId), record]));
const coveredIds = expanded.map(record => record.onStreet.physicalId);
const bound = bindServerSourceEvidence(expanded);
const admission = successor.successorRelease.decision;
const indexed = coverServerSourceEvidence(bound, coveredIds, admission, outcomes);
const runtimeBytes = fs.readFileSync(ARTIFACT);
const trusted = openRuntimeSourceArtifact(runtimeBytes);
const runtimeDocument = JSON.parse(runtimeBytes.toString('utf8'));

function faces(id) {
  const record = byExpanded.get(id);
  return { left: record.leftBlockFaceId, right: record.rightBlockFaceId };
}

function lookup(evidence, physicalId, face) {
  return evidence.streetContextFor({
    sourceNative: { physicalid: physicalId },
    leftBlockFaceId: face?.left || '0000000001',
    rightBlockFaceId: face?.right || '0000000002',
  });
}

function ranked(physicalId, names = {}, face = {}) {
  const record = {
    projection: { csclSide: 'LEFT', tangent: { eastMeters: 1, northMeters: 0 } },
    sourceNative: {
      physicalid: physicalId,
      boroughcode: '2',
      full_street_name: names.onStreet || 'MARAN PLACE',
      from_street: names.fromStreet || 'WHITE PLAINS ROAD',
      to_street: names.toStreet || 'LURTING AVENUE',
      streetwidth: '34',
      globalid: `case-${physicalId}`,
      rw_type: '1',
      status: '2',
    },
    globalId: `case-${physicalId}`,
    sourceVersion: { resourceId: 'inkn-q76z', version: 'fixture-v2' },
    geometry: { type: 'MultiLineString', coordinates: [[[-74.001, 40.7], [-73.999, 40.7]]] },
    leftBlockFaceId: face.left || '1522613113',
    rightBlockFaceId: face.right || '1322604975',
  };
  return { best: record, group: { records: [record], reasonCodes: [] } };
}

function forgedDocument(mutate) {
  const document = JSON.parse(successorBytes.toString('utf8'));
  delete document.coverageManifest.authoritativeOutcomes;
  document.editions = { ...document.editions, lionPackage: '26B', sndPackage: '26B' };
  document.sources = { lion: PINNED_SOURCES.lion, snd: PINNED_SOURCES.snd, cscl: PINNED_SOURCES.cscl };
  document.successorRelease = buildSuccessorRelease(document.coverageManifest);
  if (mutate) mutate(document);
  return document;
}

const METADATA = { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 };
function resolverOptions(evidence, physicalId) {
  const row = ranked(physicalId).best;
  const raw = {
    ...row.sourceNative,
    globalid: row.globalId,
    l_blockfaceid: row.leftBlockFaceId,
    r_blockfaceid: row.rightBlockFaceId,
    the_geom: row.geometry,
    b5sc: '250420',
    street_name: 'MARAN PLACE',
    stname_label: 'Maran Place',
    from_level_code: '13',
    to_level_code: '13',
  };
  return {
    fetchFn: async url => ({ ok: true, json: async () => (String(url).includes('/api/views/') ? METADATA : [raw]) }),
    getSocrataToken: () => '',
    planimetricStore: { queryCurbs: async () => ({ candidates: [], completeness: { state: 'COMPLETE', reason: null }, sourceVersion: { resourceId: '5xvt-8cbk', version: 'fixture-plan-v1' } }) },
    requestNonce: `nonce-${physicalId}`,
    privateSourceContextEnrichment: ENRICHMENT_MODE,
    evaluationScope: SHADOW_EVALUATION,
    privateSourceEvidence: evidence,
  };
}

const location = { lat: 40.70005, lng: -74, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 2 };
const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
}

test('trusted 26B loader keeps the legacy contract', () => {
  assert.equal(trusted.ok, true);
  assert.equal(trusted.authoritativeOutcomes, 'legacy');
  const known = runtimeDocument.records.find(item => item.physicalId === '40227');
  const context = lookup(trusted, '40227', { left: known.leftBlockFaceId, right: known.rightBlockFaceId });
  assert.equal(context.ok, true);
  assert.equal(context.segmentId, '0147146');
  assert.equal(lookup(trusted, '999999999'), null);
  record('trusted-26b', 'PASS', { segment40227: context.segmentId, uncovered: null });
});

test('direct review of a genuine parsed 26B document is not self-authenticating', () => {
  const reviewed = reviewRuntimeArtifactDocument(runtimeDocument);
  assert.equal(reviewed.ok, false);
  assert.equal(reviewed.reason, 'unverified_artifact_provenance');
  record('parsed-26b-without-loader', 'PASS', { reason: reviewed.reason });
});

test('stripped and relabeled 26C document fails closed at review and at the resolver', async () => {
  const document = forgedDocument(value => {
    value.artifactSha256 = PINNED_ARTIFACT_SHA256;
    value.trusted = true;
    value.legacyMode = true;
    value.certified = true;
  });
  const reviewed = reviewRuntimeArtifactDocument(document);
  assert.equal(reviewed.ok, false);
  assert.equal(reviewed.reason, 'unverified_artifact_provenance');
  const opened = openRuntimeSourceArtifact(Buffer.from(`${JSON.stringify(document)}\n`));
  assert.equal(opened.reason, 'artifact_digest_mismatch');
  const resolution = await resolveCanonicalCurb(location, resolverOptions(reviewed, '40227'));
  assert.equal(resolution.state, 'UNSUPPORTED');
  assert.deepEqual(resolution.reasons, ['candidate_incomplete']);
  assert.equal(resolution.publicCurb, undefined);
  const candidate = buildCandidate(ranked('40227'), { evidence: reviewed });
  assert.equal(candidate, null);
  record('forged-26b-header', 'PASS', {
    reviewReason: reviewed.reason,
    openReason: opened.reason,
    resolver: resolution.state,
  });
});

test('caller legacy flags and a self-declared digest do not authorize legacy mode', () => {
  const reviewed = reviewRuntimeArtifactDocument(forgedDocument(value => {
    value.legacy = true;
    value.authoritativeOutcomes = null;
    value.coverageManifest.authoritativeOutcomes = null;
  }));
  assert.equal(reviewed.reason, 'unverified_artifact_provenance');
  record('caller-legacy-flags', 'PASS', { reason: reviewed.reason });
});

test('indexed 26C successor rejects the four ambiguous ids and keeps 194825 and Melville', async () => {
  assert.equal(indexed.ok, true);
  for (const id of AMBIGUOUS) {
    const context = lookup(indexed, id);
    assert.equal(context.ok, false);
    assert.equal(context.reason, 'contradictory_node_order');
    assert.equal(context.disposition, 'ambiguous');
    assert.equal(buildCandidate(ranked(id), { evidence: indexed }), null);
    const resolution = await resolveCanonicalCurb(location, resolverOptions(indexed, id));
    assert.equal(resolution.state, 'UNSUPPORTED');
    assert.deepEqual(resolution.reasons, ['candidate_incomplete']);
  }
  const supported = lookup(indexed, '194825', faces('194825'));
  assert.equal(supported.ok, true);
  assert.equal(supported.segmentId, '0185995');
  const melville = lookup(indexed, '98053', faces('98053'));
  assert.equal(melville.ok, true);
  assert.equal(melville.segmentId, '0085847');
  assert.equal(melville.fromStreet, 'VAN NEST AVENUE');
  const replaced = buildCandidate(ranked('98053', {
    fromStreet: 'NOT MELVILLE FROM',
    toStreet: 'NOT MELVILLE TO',
  }, faces('98053')), { evidence: indexed });
  assert.equal(replaced.identity.names.fromStreet, 'VAN NEST AVENUE');
  assert.equal(replaced.identity.names.toStreet, 'MORRIS PARK AVENUE');
  record('indexed-26c', 'PASS', { segment194825: supported.segmentId, melville: melville.segmentId });
});

test('accepted and rejected evidence for the same identity rejects the artifact', () => {
  const host = byExpanded.get('194825');
  const accepted = { ...host, onStreet: { ...host.onStreet, physicalId: '40227', segmentId: '0099999' } };
  const overlap = coverServerSourceEvidence(bindServerSourceEvidence([accepted]), ['40227'], admission, outcomes);
  assert.equal(overlap.ok, false);
  assert.equal(overlap.reason, 'contradictory_authoritative_outcomes');
  const synthetic = {
    ...host,
    onStreet: { ...host.onStreet, physicalId: '424242', segmentId: '0088888' },
  };
  const syntheticCover = coverServerSourceEvidence(
    bindServerSourceEvidence([synthetic]),
    ['424242'],
    admission,
    { representation: 'physical-id-reason-v1', rejectedIdentityCount: 1, entries: [['424242', 'contradictory_node_order']] },
  );
  assert.equal(syntheticCover.reason, 'contradictory_authoritative_outcomes');
  const padded = coverServerSourceEvidence(
    bindServerSourceEvidence([{ ...host, onStreet: { ...host.onStreet, physicalId: '040227', segmentId: '0099999' } }]),
    ['040227'],
    admission,
    { representation: 'physical-id-reason-v1', rejectedIdentityCount: 1, entries: [['40227', 'contradictory_node_order']] },
  );
  assert.equal(padded.reason, 'contradictory_authoritative_outcomes');
  record('outcome-conflict', 'PASS', { reason: overlap.reason });
});

test('duplicate, truncated, empty, and malformed indexes do not authorize an identity', () => {
  const duplicateRejected = coverServerSourceEvidence(bound, coveredIds, admission, {
    representation: 'physical-id-reason-v1',
    rejectedIdentityCount: 2,
    entries: [['40227', 'contradictory_node_order'], ['040227', 'duplicate_lion_segment']],
  });
  assert.equal(duplicateRejected.reason, 'incomplete_authoritative_outcomes');
  const truncated = outcomes.entries.slice(0, 10);
  const countMismatch = coverServerSourceEvidence(bound, coveredIds, admission, {
    representation: 'physical-id-reason-v1',
    rejectedIdentityCount: outcomes.rejectedIdentityCount,
    entries: truncated,
  });
  assert.equal(countMismatch.reason, 'incomplete_authoritative_outcomes');
  const wrongVersion = coverServerSourceEvidence(bound, coveredIds, admission, {
    representation: 'physical-id-reason-v0',
    rejectedIdentityCount: 1,
    entries: [['40227', 'contradictory_node_order']],
  });
  assert.equal(wrongVersion.reason, 'incomplete_authoritative_outcomes');
  const numeric = coverServerSourceEvidence(bound, ['40227'], admission, {
    representation: 'physical-id-reason-v1',
    rejectedIdentityCount: 1,
    entries: [[40227, 'contradictory_node_order']],
  });
  assert.equal(numeric.ok, false);
  const empty = coverServerSourceEvidence(bound, coveredIds, admission, {
    representation: 'physical-id-reason-v1', rejectedIdentityCount: 0, entries: [],
  });
  assert.equal(empty.ok, true);
  assert.equal(lookup(empty, '40227').reason, 'identity_not_in_authoritative_source');
  assert.equal(buildCandidate(ranked('40227'), { evidence: empty }), null);
  record('malformed-index', 'PASS', { emptyReason: lookup(empty, '40227').reason });
});

test('omitted index does not become a legacy null context', () => {
  const absent = coverServerSourceEvidence(bound, coveredIds, admission);
  const context = lookup(absent, '40227');
  assert.equal(context.ok, false);
  assert.notEqual(context, null);
  assert.equal(buildCandidate(ranked('40227'), { evidence: absent }), null);
  record('omitted-index', 'PASS', { reason: context.reason });
});

test('explicit rejection is not replaced by a null pilot fallback', () => {
  const closed = applyPilotAllowlist(indexed, { restrictPhysicalIds: false, physicalIds: [] });
  const rejected = lookup(closed, '40227');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'contradictory_node_order');
  assert.equal(buildCandidate(ranked('40227'), { evidence: closed }), null);
  const explicit = { ok: true, streetContextFor: () => ({ ok: false, reason: 'missing_provenance' }) };
  assert.equal(buildCandidate(ranked('40227'), { evidence: explicit }), null);
  record('pilot-wrapper', 'PASS', { reason: rejected.reason });
});

test('post-review mutation and a failed validation do not become trusted', () => {
  const document = forgedDocument();
  const first = reviewRuntimeArtifactDocument(document);
  document.trustedArtifact = true;
  document.coverageManifest.authoritativeOutcomes = outcomes;
  document.records.push({ physicalId: '40227', segmentId: '0099999' });
  const second = reviewRuntimeArtifactDocument(document);
  assert.equal(first.reason, 'unverified_artifact_provenance');
  assert.equal(second.ok, false);
  assert.deepEqual(simulateDeploymentPilot({ trusted: true, certified: true }), {});
  const again = openRuntimeSourceArtifact(runtimeBytes);
  assert.equal(again.ok, true);
  assert.throws(() => { again.authoritativeOutcomes = 'legacy-forged'; });
  record('mutation-and-cache', 'PASS', { first: first.reason, second: second.reason });
});

test('compact Melville identity is unchanged on the original successor', () => {
  const record26c = successor.records.find(item => item.physicalId === '98053');
  assert.equal(record26c.segmentId, '0085847');
  assert.equal(record26c.streetCode, '250420');
  assert.deepEqual([record26c.nodeIdFrom, record26c.nodeIdTo], ['0052416', '0048539']);
  assert.equal(record26c.leftBlockFaceId, '1522611401');
  assert.equal(record26c.rightBlockFaceId, '1522607000');
  assert.equal(record26c.street, 'MELVILLE STREET');
  assert.equal(Object.hasOwn(record26c, 'coordinates'), false);
  record('melville-compact', 'PASS', { segmentId: record26c.segmentId });
});

test.after(() => {
  fs.writeFileSync('C:/Users/jayca/AppData/Local/ParQueen/si-source-26c-05a/scratch/provenance-case-log.json', JSON.stringify(results, null, 2));
});
