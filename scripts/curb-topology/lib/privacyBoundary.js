'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const SKIP_DIRECTORIES = new Set(['.git', '.superpowers', 'node_modules', 'docs', 'data', 'test-results']);
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

const walk = (root, callback) => {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) walk(absolute, callback);
    else callback(absolute);
  }
};

const isProductionSource = file => SOURCE_EXTENSIONS.has(path.extname(file))
  && !/\.(?:test|spec|integration)\.[cm]?[jt]sx?$/.test(file);

const assertArtifactPrivacy = ({ repoRoot }) => {
  const offlineRoot = path.resolve(repoRoot, 'scripts', 'curb-topology');
  const forbiddenImports = [];
  walk(repoRoot, file => {
    if (!isProductionSource(file)) return;
    const absolute = path.resolve(file);
    if (absolute.startsWith(`${offlineRoot}${path.sep}`)) return;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : null;
      if (specifier.includes('scripts/curb-topology')
        || specifier.includes('curb-topology/lib')
        || (resolved && (resolved === offlineRoot || resolved.startsWith(`${offlineRoot}${path.sep}`)))) {
        forbiddenImports.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
      }
    }
  });

  const artifactsUnder = directory => {
    const matches = [];
    walk(path.join(repoRoot, directory), file => {
      const name = path.basename(file);
      if (/^shard-[a-f0-9]+-\d{3}\.json$/.test(name)
        || /canonical[-_]curb[-_]topology/i.test(file)
        || /curb[-_]topology/i.test(file)) {
        matches.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
      }
    });
    return matches;
  };
  const publicArtifacts = artifactsUnder('public');
  const distArtifacts = artifactsUnder('dist');
  if (forbiddenImports.length) throw new Error(`offline topology import outside tooling boundary: ${forbiddenImports.join(', ')}`);
  if (publicArtifacts.length) throw new Error(`public artifact exposure: ${publicArtifacts.join(', ')}`);
  if (distArtifacts.length) throw new Error(`dist artifact exposure: ${distArtifacts.join(', ')}`);
  return { ok: true, forbiddenImports, publicArtifacts, distArtifacts };
};

module.exports = { assertArtifactPrivacy };
