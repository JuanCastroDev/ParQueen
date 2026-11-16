export const RULES_PROJECT_ID = 'demo-parkqueen-rules-test';

export interface RulesEmulatorEndpoint {
  host: '127.0.0.1';
  port: number;
  endpoint: string;
}

export function readRulesEmulatorEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): RulesEmulatorEndpoint {
  const raw = env.FIRESTORE_EMULATOR_HOST?.trim() ?? '';
  const match = /^(127\.0\.0\.1|localhost):([0-9]{1,5})$/.exec(raw);
  if (!match) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST must be 127.0.0.1:<port>. Refusing to fall back to localhost:8080.',
    );
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('FIRESTORE_EMULATOR_HOST port is invalid.');
  }
  if (env.PARQUEEN_RULES_ISOLATED === '1' && (match[1] !== '127.0.0.1' || port !== 8181)) {
    throw new Error(
      port === 8080
        ? 'Isolated rules validation refuses port 8080.'
        : 'Isolated rules validation requires 127.0.0.1:8181.',
    );
  }
  const endpoint = `127.0.0.1:${port}`;
  env.FIRESTORE_EMULATOR_HOST = endpoint;
  return { host: '127.0.0.1', port, endpoint };
}

export function assertRulesProject(projectId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (projectId !== RULES_PROJECT_ID) {
    throw new Error('Firestore rules tests must use demo-parkqueen-rules-test.');
  }
  const cloud = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT;
  if (cloud && cloud !== RULES_PROJECT_ID) {
    throw new Error('Firestore rules tests refuse a different cloud project.');
  }
}
