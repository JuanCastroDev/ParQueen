'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');

const source = readFileSync(join(__dirname, 'index.js'), 'utf8');
const start = source.indexOf('async function _tryCreateFromSweepNYC');
const end = source.indexOf('// ── Private helpers used by createSegmentFromSweepNYC');
const flow = source.slice(start, end);

describe('Street Intelligence production logging privacy', () => {
  it('does not place street, sign, blockface, or segment identity in backend log statements', () => {
    const logStatements = flow.split('\n').filter(line => /console\.(log|warn|error)/.test(line)).join('\n');
    for (const sensitiveReference of [
      'JSON.stringify', 'signText', 'streetCtx', 'streetNameForGeo', 'osmStreet',
      'dotName', 'likePattern', "groupKeys.join", 'fromStreet', 'toStreet',
      'unparsed[', 'docId', 'objectId',
    ]) {
      expect(logStatements).not.toContain(sensitiveReference);
    }
    expect(logStatements).not.toMatch(/crossStreets\s*[,)]/);
  });
});
