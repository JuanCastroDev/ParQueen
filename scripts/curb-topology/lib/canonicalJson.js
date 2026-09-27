'use strict';

const crypto = require('node:crypto');

const normalize = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => {
      if (value[key] === undefined) throw new TypeError(`canonical JSON rejects undefined at ${key}`);
      return [key, normalize(value[key])];
    }));
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`);
};

const canonicalJson = value => JSON.stringify(normalize(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

module.exports = { canonicalJson, sha256 };
