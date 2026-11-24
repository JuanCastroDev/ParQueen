import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFile, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const {
  extractVerifiedBytes,
  openGdalSession,
  resolveGdalResourceDirectory,
} = require('./officialLionPrimaryTopology');
const { APPROVED_LION } = require('./successorReleasePolicy');

const ARCHIVE = process.env.CURB_LION_PRIMARY_ARCHIVE ?? '';
const GDAL = process.env.CURB_LION_GDAL_MODULE ?? '';
const liveGdal = ARCHIVE !== '' && GDAL !== '';

function layout(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gdal-root-'));
  const directory = join(root, 'node_modules', 'gdal3.js', 'dist', 'package');
  mkdirSync(directory, { recursive: true });
  if (options.wasm !== false) writeFileSync(join(directory, 'gdal3WebAssembly.wasm'), options.wasm ?? 'wasm-bytes');
  if (options.data !== false) writeFileSync(join(directory, 'gdal3WebAssembly.data'), options.data ?? 'data-bytes');
  const modulePath = join(directory, 'gdal3.node.js');
  writeFileSync(modulePath, options.source ?? `
    const fs = require('fs');
    module.exports = async function initGdalJs() {
      await new Promise(resolve => setImmediate(resolve));
      const relative = 'node_modules/gdal3.js/dist/package/gdal3WebAssembly.wasm';
      return {
        cwd: process.cwd(),
        wasm: fs.readFileSync(relative, 'utf8'),
        open() { return { datasets: [{}] }; },
        async ogrinfo() { return { layers: [] }; },
        async close() {},
      };
    };
  `);
  return { root, directory, modulePath };
}

describe('gdal3.js resource resolution', () => {
  it('resolves resources beside the configured module instead of three parents up', () => {
    const installed = layout();
    try {
      expect(resolveGdalResourceDirectory(installed.modulePath)).toBe(installed.directory);
      expect(resolveGdalResourceDirectory(installed.modulePath)).not.toBe(resolve(installed.directory, '..', '..', '..'));
    } finally {
      rmSync(installed.root, { recursive: true, force: true });
    }
  });

  it('refuses a missing, incompatible, or incomplete module', () => {
    const installed = layout({ wasm: false });
    const looseRoot = mkdtempSync(join(tmpdir(), 'gdal-loose-'));
    const looseModule = join(looseRoot, 'gdal3.node.js');
    writeFileSync(looseModule, 'module.exports = async function initGdalJs() { return {}; };');
    try {
      expect(resolveGdalResourceDirectory('')).toBeNull();
      expect(resolveGdalResourceDirectory(join(installed.root, 'missing.js'))).toBeNull();
      expect(resolveGdalResourceDirectory(installed.modulePath)).toBeNull();
      expect(resolveGdalResourceDirectory(looseModule)).toBeNull();
    } finally {
      rmSync(installed.root, { recursive: true, force: true });
      rmSync(looseRoot, { recursive: true, force: true });
    }
  });

  it('initializes from another working directory and restores it after success or failure', async () => {
    const previous = process.cwd();
    const installed = layout();
    const broken = layout({
      source: `
        module.exports = async function initGdalJs() {
          await new Promise(resolve => setImmediate(resolve));
          throw new Error('gdal init failed');
        };
      `,
    });
    const invalid = layout({
      source: 'module.exports = { open() {} };',
    });
    try {
      const session = await openGdalSession({ CURB_LION_GDAL_MODULE: installed.modulePath });
      expect(session).not.toBeNull();
      const opened = await session.query(installed.directory, 'probe', 'SELECT 1');
      expect(opened).toEqual([]);
      expect(process.cwd()).toBe(previous);

      expect(await openGdalSession({ CURB_LION_GDAL_MODULE: broken.modulePath })).toBeNull();
      expect(process.cwd()).toBe(previous);
      expect(await openGdalSession({ CURB_LION_GDAL_MODULE: invalid.modulePath })).toBeNull();
      expect(process.cwd()).toBe(previous);
      expect(() => readFileSync(join(previous, 'node_modules', 'gdal3.js', 'dist', 'package', 'gdal3WebAssembly.wasm'))).toThrow();
    } finally {
      process.chdir(previous);
      rmSync(installed.root, { recursive: true, force: true });
      rmSync(broken.root, { recursive: true, force: true });
      rmSync(invalid.root, { recursive: true, force: true });
    }
  });

  it('keeps the process working directory unchanged while initialization is in flight', async () => {
    const previous = process.cwd();
    const installed = layout({
      source: `
        module.exports = async function initGdalJs() {
          await new Promise(resolve => setTimeout(resolve, 30));
          if (process.cwd() !== ${JSON.stringify(previous)}) throw new Error('working directory changed');
          return {
            open() { return { datasets: [{}] }; },
            async ogrinfo() { return { layers: [] }; },
            async close() {},
          };
        };
      `,
    });
    try {
      const pending = openGdalSession({ CURB_LION_GDAL_MODULE: installed.modulePath });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(process.cwd()).toBe(previous);
      expect(await pending).not.toBeNull();
      expect(process.cwd()).toBe(previous);
    } finally {
      process.chdir(previous);
      rmSync(installed.root, { recursive: true, force: true });
    }
  });

  it('does not redirect unrelated reads while initialization is in flight', async () => {
    const previous = process.cwd();
    const installed = layout({
      source: `
        const fs = require('fs');
        module.exports = async function initGdalJs() {
          const own = fs.readFileSync('node_modules/gdal3.js/dist/package/gdal3WebAssembly.wasm', 'utf8');
          await new Promise(resolve => setTimeout(resolve, 40));
          if (own !== 'wasm-bytes') throw new Error('configured module resource was not readable');
          return {
            open() { return { datasets: [{}] }; },
            async ogrinfo() { return { layers: [] }; },
            async close() {},
          };
        };
      `,
    });
    const decoyRoot = mkdtempSync(join(tmpdir(), 'gdal-decoy-'));
    const decoy = join(decoyRoot, 'node_modules', 'gdal3.js', 'dist', 'package', 'gdal3WebAssembly.wasm');
    mkdirSync(join(decoyRoot, 'node_modules', 'gdal3.js', 'dist', 'package'), { recursive: true });
    writeFileSync(decoy, 'decoy-bytes');
    try {
      const pending = openGdalSession({ CURB_LION_GDAL_MODULE: installed.modulePath });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(readFileSync(decoy, 'utf8')).toBe('decoy-bytes');
      expect(await pending).not.toBeNull();
      expect(readFileSync(decoy, 'utf8')).toBe('decoy-bytes');
      expect(process.cwd()).toBe(previous);
    } finally {
      process.chdir(previous);
      rmSync(installed.root, { recursive: true, force: true });
      rmSync(decoyRoot, { recursive: true, force: true });
    }
  });

  it('rejects an empty resource and a directory placed where the WebAssembly file belongs', () => {
    const empty = layout({ wasm: '' });
    const directoryResource = layout();
    const wasmPath = join(directoryResource.directory, 'gdal3WebAssembly.wasm');
    rmSync(wasmPath);
    mkdirSync(wasmPath);
    try {
      expect(resolveGdalResourceDirectory(empty.modulePath)).toBeNull();
      expect(resolveGdalResourceDirectory(directoryResource.modulePath)).toBeNull();
      expect(readFileSync(join(empty.directory, 'gdal3WebAssembly.data'), 'utf8')).toBe('data-bytes');
    } finally {
      rmSync(empty.root, { recursive: true, force: true });
      rmSync(directoryResource.root, { recursive: true, force: true });
    }
  });

  it('does not redirect a traversed or suffixed path read by the configured module', async () => {
    const previous = process.cwd();
    const installed = layout();
    writeFileSync(join(installed.directory, 'secret.txt'), 'secret-bytes');
    writeFileSync(join(installed.directory, 'gdal3WebAssembly.wasm.extra'), 'extra-bytes');
    const packageDir = installed.directory.replaceAll('\\', '/');
    const traversedPath = `${packageDir}/gdal3WebAssembly.wasm/../secret.txt`;
    const lexicalPath = `${packageDir}/../package/secret.txt`;
    const suffixedPath = `${packageDir}/gdal3WebAssembly.wasm.extra`;
    writeFileSync(installed.modulePath, `
      const fs = require('fs');
      module.exports = async function initGdalJs() {
        const exact = fs.readFileSync('node_modules/gdal3.js/dist/package/gdal3WebAssembly.wasm', 'utf8');
        const suffixed = fs.readFileSync(${JSON.stringify(suffixedPath)}, 'utf8');
        const lexical = fs.readFileSync(${JSON.stringify(lexicalPath)}, 'utf8');
        let traversed = null;
        let traversedCode = null;
        try {
          traversed = fs.readFileSync(${JSON.stringify(traversedPath)}, 'utf8');
        } catch (error) {
          traversedCode = error.code;
        }
        if (exact !== 'wasm-bytes') throw new Error('authorized GDAL filename was not readable');
        if (suffixed !== 'extra-bytes') throw new Error('suffixed filename was redirected');
        if (lexical !== 'secret-bytes') throw new Error('directory traversal was redirected');
        const preserved = traversedCode === 'ENOTDIR' || traversed === 'secret-bytes';
        if (!preserved || traversed === 'wasm-bytes') throw new Error('file traversal was redirected');
        return {
          open() { return { datasets: [{}] }; },
          async ogrinfo() { return { layers: [] }; },
          async close() {},
        };
      };
    `);
    try {
      expect(await openGdalSession({ CURB_LION_GDAL_MODULE: installed.modulePath })).not.toBeNull();
      expect(process.cwd()).toBe(previous);
      expect(readFileSync(join(installed.directory, 'secret.txt'), 'utf8')).toBe('secret-bytes');
      expect(readFileSync(join(installed.directory, 'gdal3WebAssembly.wasm.extra'), 'utf8')).toBe('extra-bytes');
    } finally {
      process.chdir(previous);
      rmSync(installed.root, { recursive: true, force: true });
    }
  });

  it('serializes overlapping initialization and restores reads afterward', async () => {
    const previous = process.cwd();
    const orderPath = join(mkdtempSync(join(tmpdir(), 'gdal-order-')), 'order.txt');
    writeFileSync(orderPath, '');
    const moduleSource = (label) => `
      const fs = require('fs');
      module.exports = async function initGdalJs() {
        fs.appendFileSync(${JSON.stringify(orderPath)}, '${label}-start\\n');
        const own = fs.readFileSync('node_modules/gdal3.js/dist/package/gdal3WebAssembly.wasm', 'utf8');
        await new Promise(resolve => setTimeout(resolve, 40));
        if (own !== 'wasm-bytes') throw new Error('configured module resource was not readable');
        fs.appendFileSync(${JSON.stringify(orderPath)}, '${label}-end\\n');
        return {
          open() { return { datasets: [{}] }; },
          async ogrinfo() { return { layers: [] }; },
          async close() {},
        };
      };
    `;
    const first = layout({ source: moduleSource('A') });
    const second = layout({ source: moduleSource('B') });
    const decoyRoot = mkdtempSync(join(tmpdir(), 'gdal-decoy-'));
    const decoy = join(decoyRoot, 'node_modules', 'gdal3.js', 'dist', 'package', 'gdal3WebAssembly.wasm');
    mkdirSync(join(decoyRoot, 'node_modules', 'gdal3.js', 'dist', 'package'), { recursive: true });
    writeFileSync(decoy, 'decoy-bytes');
    try {
      const pending = Promise.all([
        openGdalSession({ CURB_LION_GDAL_MODULE: first.modulePath }),
        openGdalSession({ CURB_LION_GDAL_MODULE: second.modulePath }),
      ]);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(readFileSync(decoy, 'utf8')).toBe('decoy-bytes');
      expect(await new Promise((resolve, reject) => {
        readFile(decoy, 'utf8', (error, value) => error ? reject(error) : resolve(value));
      })).toBe('decoy-bytes');
      const sessions = await pending;
      expect(sessions[0]).not.toBeNull();
      expect(sessions[1]).not.toBeNull();
      expect(readFileSync(orderPath, 'utf8')).toBe('A-start\nA-end\nB-start\nB-end\n');
      expect(process.cwd()).toBe(previous);
      expect(readFileSync(decoy, 'utf8')).toBe('decoy-bytes');
      expect(() => readFileSync(join(previous, 'node_modules', 'gdal3.js', 'dist', 'package', 'gdal3WebAssembly.wasm'))).toThrow();
    } finally {
      process.chdir(previous);
      rmSync(first.root, { recursive: true, force: true });
      rmSync(second.root, { recursive: true, force: true });
      rmSync(decoyRoot, { recursive: true, force: true });
      rmSync(resolve(orderPath, '..'), { recursive: true, force: true });
    }
  });

  it('restores the original file reads after initialization fails', async () => {
    const previous = process.cwd();
    const broken = layout({
      source: `
        const fs = require('fs');
        module.exports = async function initGdalJs() {
          fs.readFileSync('node_modules/gdal3.js/dist/package/gdal3WebAssembly.wasm', 'utf8');
          await new Promise(resolve => setTimeout(resolve, 20));
          throw new Error('gdal init failed');
        };
      `,
    });
    const decoyRoot = mkdtempSync(join(tmpdir(), 'gdal-decoy-'));
    const decoy = join(decoyRoot, 'node_modules', 'gdal3.js', 'dist', 'package', 'gdal3WebAssembly.wasm');
    mkdirSync(join(decoyRoot, 'node_modules', 'gdal3.js', 'dist', 'package'), { recursive: true });
    writeFileSync(decoy, 'decoy-bytes');
    try {
      expect(await openGdalSession({ CURB_LION_GDAL_MODULE: broken.modulePath })).toBeNull();
      expect(process.cwd()).toBe(previous);
      expect(readFileSync(decoy, 'utf8')).toBe('decoy-bytes');
      expect(() => readFileSync(join(previous, 'node_modules', 'gdal3.js', 'dist', 'package', 'gdal3WebAssembly.wasm'))).toThrow();
    } finally {
      process.chdir(previous);
      rmSync(broken.root, { recursive: true, force: true });
      rmSync(decoyRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!liveGdal)('reads Melville Street from the approved LION 26B archive through gdal3.js', async () => {
    const bytes = readFileSync(ARCHIVE);
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(bytes.length).toBe(APPROVED_LION.byteLength);
    expect(digest).toBe(APPROVED_LION.sha256);
    const extracted = extractVerifiedBytes(bytes, digest);
    expect(extracted).not.toBeNull();
    try {
      const session = await openGdalSession({ CURB_LION_GDAL_MODULE: GDAL });
      expect(session).not.toBeNull();
      const features = await session.query(
        extracted.directory,
        'melville-98053',
        'SELECT SegmentID, PhysicalID, Street FROM lion WHERE PhysicalID = 98053',
      );
      expect(features).toHaveLength(1);
      expect(String(features[0].attributes.Street).trim()).toBe('MELVILLE STREET');
      expect(String(features[0].attributes.SegmentID).trim()).toBe('0085847');
      expect(String(features[0].attributes.PhysicalID).trim()).toBe('98053');
    } finally {
      rmSync(resolve(extracted.directory, '..', '..'), { recursive: true, force: true });
    }
  }, 120000);
});
