import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ARTIFACT_PATH,
  PACKAGED_ARTIFACT_PATH,
  PINNED_ARTIFACT_SHA256,
  resolveRuntimeArtifactPath,
  loadPinnedRuntimeArtifact,
  attachOwnerPilot,
  pilotRuntimeDependencies,
  simulateDeploymentPilot,
} = require('./runtimeSourceArtifact');
const { deploymentPilotEnabled } = require('./pilotSourceLoading');

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function callableSlice(source) {
  const start = source.indexOf('exports.createSegmentFromSweepNYC = onCall(');
  const end = source.indexOf('function _existingNYCOpenDataResult', start);
  return source.slice(start, end);
}

describe('main-compatible integrated release coverage', () => {
  it('environment overrides and a caller artifact path keep the pilot closed', () => {
    const previous = {
      mode: process.env.CURB_RESOLVER_MODE,
      product: process.env.CURB_PRODUCT_PATH,
      approval: process.env.OWNER_APPROVAL,
      pilot: process.env.DEPLOYMENT_PILOT_ENABLED,
    };
    process.env.CURB_RESOLVER_MODE = 'shadow';
    process.env.CURB_PRODUCT_PATH = 'on';
    process.env.OWNER_APPROVAL = 'APPROVED';
    process.env.DEPLOYMENT_PILOT_ENABLED = 'true';
    const events = [];
    const dependencies = {
      telemetry: { emit(event, payload) { events.push({ event, payload }); } },
    };
    try {
      expect(deploymentPilotEnabled()).toBe(false);
      expect(pilotRuntimeDependencies()).toEqual({});
      expect(pilotRuntimeDependencies({
        ownerApproval: 'APPROVED',
        certificationStatus: 'CERTIFIED',
      })).toEqual({});
      expect(simulateDeploymentPilot({
        deploymentOwner: 'parqueen-server-pilot',
        enabled: true,
        ownerApproval: 'APPROVED',
        artifactPath: 'C:/tmp/other.json',
      })).toEqual({});
      expect(attachOwnerPilot(dependencies, 'owner-aaa-111')).toEqual({});
      expect(Object.hasOwn(dependencies, 'privateSourceEvidence')).toBe(false);
      expect(events).toEqual([{
        event: 'curb_pilot_diagnostic',
        payload: { protocolVersion: 2, pilotStage: 'pilot_closed' },
      }]);
      expect(JSON.stringify(events)).not.toContain('owner-aaa-111');
    } finally {
      for (const [key, name] of [
        ['mode', 'CURB_RESOLVER_MODE'],
        ['product', 'CURB_PRODUCT_PATH'],
        ['approval', 'OWNER_APPROVAL'],
        ['pilot', 'DEPLOYMENT_PILOT_ENABLED'],
      ]) {
        if (previous[key] === undefined) delete process.env[name];
        else process.env[name] = previous[key];
      }
    }
  });

  it('the SweepNYC callable keeps the 30/3600 limit on the verified uid', () => {
    const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const slice = callableSlice(source);
    expect(slice).toContain("await checkRateLimit(uid, 'createSegmentFromSweepNYC', { limit: 30, windowSec: 3600 })");
    expect(slice).toContain('return canonicalV2Handler(request.data, request.auth.uid);');
    expect(slice).not.toContain('request.data.uid');
    expect(slice).not.toContain('request.data?.uid');
    expect(slice).toContain('enforceAppCheck: true');
    expect(slice).not.toContain('enforceAppCheck: false');
    expect(slice).toContain('request.data?.protocolVersion !== 2');
    const runtimeStart = source.indexOf('async function _runCanonicalCurbV2');
    const runtime = source.slice(runtimeStart, source.indexOf('// ─── Hydrant', runtimeStart));
    expect(runtime).toContain('attachOwnerPilot(orchestratorDependencies, verifiedUid)');
    expect(runtime).not.toContain('pilotRuntimeDependencies(request');
  });

  it('an empty packaged slot keeps the pinned 26B file, and a substitute cannot replace it', () => {
    const packagedDirectory = path.dirname(PACKAGED_ARTIFACT_PATH);
    const directoryExisted = fs.existsSync(packagedDirectory);
    expect(fs.existsSync(PACKAGED_ARTIFACT_PATH)).toBe(false);
    expect(resolveRuntimeArtifactPath()).toBe(ARTIFACT_PATH);
    expect(sha256(ARTIFACT_PATH)).toBe(PINNED_ARTIFACT_SHA256);

    fs.mkdirSync(packagedDirectory, { recursive: true });
    fs.writeFileSync(PACKAGED_ARTIFACT_PATH, '{"not":"the pinned artifact"}');
    const reads = [];
    const originalRead = fs.readFileSync;
    fs.readFileSync = function recordRead(filePath, ...rest) {
      reads.push(String(filePath));
      return originalRead.call(this, filePath, ...rest);
    };
    try {
      expect(resolveRuntimeArtifactPath()).toBe(PACKAGED_ARTIFACT_PATH);
      expect(loadPinnedRuntimeArtifact().reason).toBe('artifact_digest_mismatch');
      expect(reads).toContain(PACKAGED_ARTIFACT_PATH);
      expect(reads).not.toContain(ARTIFACT_PATH);
      expect(reads.some(filePath => /citywideCrossStreetCoverage|lion-snapshot|snd-w4v2/i.test(filePath))).toBe(false);
    } finally {
      fs.readFileSync = originalRead;
      fs.rmSync(PACKAGED_ARTIFACT_PATH, { force: true });
      if (!directoryExisted && fs.existsSync(packagedDirectory) && fs.readdirSync(packagedDirectory).length === 0) {
        fs.rmdirSync(packagedDirectory);
      }
    }

    expect(fs.existsSync(PACKAGED_ARTIFACT_PATH)).toBe(false);
    expect(resolveRuntimeArtifactPath()).toBe(ARTIFACT_PATH);
    expect(sha256(ARTIFACT_PATH)).toBe(PINNED_ARTIFACT_SHA256);
  });
});
