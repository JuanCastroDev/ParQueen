const LIVE_DEMO_PORTS = new Set(['8080', '9099', '9199', '5001', '4400', '4500']);

function isolatedPort(name: string): number {
  const raw = process.env[name] ?? '';
  if (!/^\d+$/.test(raw) || LIVE_DEMO_PORTS.has(raw)) {
    throw new Error(`${name} must be an isolated emulator port`);
  }
  return Number(raw);
}

export function rulesFirestorePort(): number {
  return isolatedPort('PARQUEEN_RULES_FIRESTORE_PORT');
}

export function rulesStoragePort(): number {
  return isolatedPort('PARQUEEN_RULES_STORAGE_PORT');
}
