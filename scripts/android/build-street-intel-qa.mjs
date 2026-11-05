import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..', '..');
const mode = 'streetintelqa';
const packageId = 'app.parqueen.qa';
const forbidden = [
  'AIzaSy',
  'parkqueen-46475363-ccf36.firebaseapp.com',
  'parkqueen-46475363-ccf36.firebasestorage.app',
  'www.gstatic.com/firebasejs',
];
const required = [
  'demo-parkqueen-functions-test',
  '127.0.0.1',
  '9099',
  '5001',
  '8080',
];

function fail(message) {
  console.error(`BLOCKED: ${message}`);
  process.exit(1);
}

function run(command, args, env, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) fail(`${command} ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}`);
}

const env = {
  ...process.env,
  MODE: mode,
  PARQUEEN_STREET_INTEL_QA: packageId,
  VITE_PARQUEEN_STREET_INTEL_QA: packageId,
};
delete env.VITE_PARQUEEN_DEMO_FIREBASE;

const tokenFile = 'C:/Users/jayca/GitWorktrees/blocked-users-manual-qa/.env.local';
if (!env.VITE_MAPBOX_TOKEN && existsSync(tokenFile)) {
  const match = readFileSync(tokenFile, 'utf8').match(/^VITE_MAPBOX_TOKEN=(.*)$/m);
  if (match?.[1]) env.VITE_MAPBOX_TOKEN = match[1].trim();
}
if (!env.VITE_MAPBOX_TOKEN) fail('Mapbox token is missing for the QA build.');
if (!env.VITE_MAPBOX_ANDROID_TOKEN) env.VITE_MAPBOX_ANDROID_TOKEN = env.VITE_MAPBOX_TOKEN;

writeFileSync(join(root, '.env.streetintelqa.local'), [
  `VITE_PARQUEEN_STREET_INTEL_QA=${packageId}`,
  `VITE_MAPBOX_TOKEN=${env.VITE_MAPBOX_TOKEN}`,
  `VITE_MAPBOX_ANDROID_TOKEN=${env.VITE_MAPBOX_ANDROID_TOKEN}`,
  '',
].join('\n'), 'utf8');

run(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--mode', mode], env);

const serviceWorker = `self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
`;
writeFileSync(join(root, 'dist', 'firebase-messaging-sw.js'), serviceWorker, 'utf8');

function scanDirectory(directory) {
  const hits = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      hits.push(...scanDirectory(path));
      continue;
    }
    if (info.size > 20 * 1024 * 1024) continue;
    const text = readFileSync(path).toString('latin1');
    for (const needle of forbidden) {
      if (text.includes(needle)) hits.push(`${path}: ${needle}`);
    }
  }
  return hits;
}

const distHits = scanDirectory(join(root, 'dist'));
if (distHits.length > 0) fail(`QA web bundle contains production Firebase material:\n${distHits.join('\n')}`);
const distText = readdirSync(join(root, 'dist', 'assets')).filter(name => name.endsWith('.js')).map(name => readFileSync(join(root, 'dist', 'assets', name), 'utf8')).join('\n');
const missing = required.filter(needle => !distText.includes(needle));
if (missing.length > 0) fail(`QA web bundle is missing demo emulator configuration: ${missing.join(', ')}`);

run(process.execPath, [join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'sync', 'android'], env);

const androidDir = join(root, 'android');
if (process.platform === 'win32') {
  run('cmd.exe', ['/d', '/c', 'gradlew.bat', 'assembleDebug', '-Pparqueen.qa=app.parqueen.qa'], env, androidDir);
} else {
  run(join(androidDir, 'gradlew'), ['assembleDebug', '-Pparqueen.qa=app.parqueen.qa'], env, androidDir);
}

const apk = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!existsSync(apk)) fail(`QA APK was not produced at ${apk}`);
const apkBuffer = readFileSync(apk);
const apkHits = new Set();
let offset = 0;
while (offset + 30 < apkBuffer.length && apkBuffer.readUInt32LE(offset) === 0x04034b50) {
  const method = apkBuffer.readUInt16LE(offset + 8);
  const compressedSize = apkBuffer.readUInt32LE(offset + 18);
  const nameLength = apkBuffer.readUInt16LE(offset + 26);
  const extraLength = apkBuffer.readUInt16LE(offset + 28);
  const name = apkBuffer.slice(offset + 30, offset + 30 + nameLength).toString('utf8');
  const dataStart = offset + 30 + nameLength + extraLength;
  const compressed = apkBuffer.slice(dataStart, dataStart + compressedSize);
  let body = compressed;
  if (method === 8) {
    try { body = inflateRawSync(compressed); } catch { body = Buffer.alloc(0); }
  }
  const text = body.toString('latin1');
  for (const needle of forbidden) {
    if (text.includes(needle)) apkHits.add(`${name}: ${needle}`);
  }
  offset = dataStart + compressedSize;
}
if (apkHits.size > 0) fail(`QA APK contains production Firebase material:\n${[...apkHits].join('\n')}`);

const aapt = 'C:/Users/jayca/AppData/Local/Android/Sdk/build-tools/36.0.0/aapt.exe';
const apksigner = 'C:/Users/jayca/AppData/Local/Android/Sdk/build-tools/36.0.0/apksigner.bat';
const badging = spawnSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8' });
const packageName = badging.stdout.match(/package: name='([^']+)'/)?.[1];
if (badging.status !== 0 || packageName !== 'app.parqueen.qa') {
  fail(`QA APK package id is ${packageName || 'missing'}, not app.parqueen.qa.`);
}
const signer = spawnSync('cmd.exe', ['/d', '/c', apksigner, 'verify', '--print-certs', apk], { encoding: 'utf8' });
const fingerprint = '269fd3fdeb292368bfc3c58780330437e48fb572251bd61b93389c69c29327af';
if (!signer.stdout.toLowerCase().includes(fingerprint)) fail('QA APK signing certificate does not match the installed QA package.');
console.log(`QA_APK ${apk}`);
