import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tempDirectories = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('topology artifact privacy boundary', () => {
  it('keeps offline modules and artifacts out of client, Hosting, and deployed Functions source', () => {
    const { assertArtifactPrivacy } = require('./lib/privacyBoundary');
    expect(assertArtifactPrivacy({ repoRoot: process.cwd() })).toMatchObject({
      ok: true,
      forbiddenImports: [],
      publicArtifacts: [],
      distArtifacts: [],
    });
  });

  it('detects an import from browser source into the offline tool boundary', () => {
    const { assertArtifactPrivacy } = require('./lib/privacyBoundary');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curb-topology-privacy-'));
    tempDirectories.push(root);
    fs.mkdirSync(path.join(root, 'utils'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts', 'curb-topology'), { recursive: true });
    fs.writeFileSync(path.join(root, 'utils', 'bad.ts'), "import '../scripts/curb-topology/lib/artifact';\n");

    expect(() => assertArtifactPrivacy({ repoRoot: root })).toThrow(/offline topology import/);
  });

  it('detects generated topology shards copied into public or dist', () => {
    const { assertArtifactPrivacy } = require('./lib/privacyBoundary');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curb-topology-public-'));
    tempDirectories.push(root);
    fs.mkdirSync(path.join(root, 'public', 'topology'), { recursive: true });
    fs.writeFileSync(path.join(root, 'public', 'topology', 'shard-a-000.json'), '{}');
    expect(() => assertArtifactPrivacy({ repoRoot: root })).toThrow(/public artifact/);
  });
});
