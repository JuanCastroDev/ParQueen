import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'functions/package.json'));
const {
  buildStreetRulesClosedCandidate,
  streetRulesReadDiff,
  loadProductionRules,
} = require('./curbIntelligence/streetRulesCandidate.js');

// The production file is what every rules test loads unless this process is
// explicitly asking for the unpublished two-line candidate. Interim artifact
// tests keep their own fixtures and are not redirected here.
export function streetRulesCandidateMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PARQUEEN_STREET_RULES_CANDIDATE === '1';
}

export function rulesTextUnderTest(env: NodeJS.ProcessEnv = process.env): string {
  const source = loadProductionRules(process.cwd());
  if (!streetRulesCandidateMode(env)) return source;
  const candidate = buildStreetRulesClosedCandidate(source);
  const diff = streetRulesReadDiff(source, candidate);
  const exact = diff.length === 2 && diff.every((change: { from?: string; to?: string }) => (
    change.from?.trim() === 'allow read: if true;'
    && change.to?.trim() === 'allow read: if false;'
  ));
  if (!exact) {
    throw new Error(`street rules candidate must change exactly two read permissions, saw ${JSON.stringify(diff)}`);
  }
  return candidate;
}
