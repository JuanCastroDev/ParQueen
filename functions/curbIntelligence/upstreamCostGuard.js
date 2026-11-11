'use strict';

const { createHash } = require('node:crypto');

const LOCATION_WINDOW_MS = 60 * 1000;
const LOCATION_LIMIT = 8;
const defaultBuckets = new Map();

function coarseLocationHash(uid, location) {
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const material = `${typeof uid === 'string' ? uid : 'anon'}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
  return createHash('sha256').update(material).digest('hex');
}

function enforceUpstreamCostGuard(input = {}, store = defaultBuckets) {
  const hashed = coarseLocationHash(input.uid, input.location);
  if (!hashed) return { ok: false, reason: 'location_quality', hashedLocationKey: null };
  const now = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const windowMs = Number.isFinite(input.windowMs) ? input.windowMs : LOCATION_WINDOW_MS;
  const limit = Number.isFinite(input.limit) ? input.limit : LOCATION_LIMIT;
  const bucket = store.get(hashed) || [];
  const recent = bucket.filter(ts => now - ts < windowMs);
  if (recent.length >= limit) {
    store.set(hashed, recent);
    return {
      ok: false,
      reason: 'source_unavailable',
      hashedLocationKey: hashed.slice(0, 16),
      limited: true,
    };
  }
  recent.push(now);
  store.set(hashed, recent);
  return { ok: true, hashedLocationKey: hashed.slice(0, 16), limited: false };
}

module.exports = {
  LOCATION_WINDOW_MS,
  LOCATION_LIMIT,
  coarseLocationHash,
  enforceUpstreamCostGuard,
};
