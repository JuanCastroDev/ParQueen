'use strict';

const { geohashForLocation } = require('geofire-common');
const { meterHostSegmentId } = require('./productMeterLookup');

function endpoints(geometry) {
  const line = geometry?.coordinates?.[0];
  if (!Array.isArray(line) || line.length < 2) return null;
  return {
    fromLng: line[0][0],
    fromLat: line[0][1],
    toLng: line[line.length - 1][0],
    toLat: line[line.length - 1][1],
    centerLng: (line[0][0] + line[line.length - 1][0]) / 2,
    centerLat: (line[0][1] + line[line.length - 1][1]) / 2,
  };
}

function computeBearing(fromLat, fromLng, toLat, toLng) {
  const dLon = ((toLng - fromLng) * Math.PI) / 180;
  const lat1 = (fromLat * Math.PI) / 180;
  const lat2 = (toLat * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function publicMeterWrite(product, now) {
  const schedules = product.windows.map(window => ({
    side: window.side,
    days: window.days,
    startTime: window.startTime,
    endTime: window.endTime,
  }));
  const meterTerms = {};
  if (Number.isInteger(product.maxStayMinutes)) meterTerms.maxStayMinutes = product.maxStayMinutes;
  if (product.rate?.display) meterTerms.rateDisplay = product.rate.display;
  return {
    type: 'meter',
    source: 'park_nyc',
    status: 'active',
    effectiveDate: now,
    supersededAt: null,
    schedules,
    meterTerms,
    lastSourceSync: new Date().toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}

async function persistPublicMeterRule({ db, Timestamp, segmentId, meter, productionResult } = {}) {
  if (!db || meter?.state !== 'supported' || !meter.product) return null;
  const now = Timestamp.now();
  const product = meter.product;
  const ruleWrite = publicMeterWrite(product, now);
  let resolvedId = typeof segmentId === 'string' && segmentId ? segmentId : null;
  let createdHost = false;
  let streetName = productionResult?.streetName || meter.hostHint?.streetName || null;
  const parkingSide = product.side;

  if (!resolvedId) {
    const hint = meter.hostHint;
    const geo = endpoints(hint?.geometry);
    if (!geo || !hint) return null;
    resolvedId = meterHostSegmentId(hint, parkingSide);
    const bearingRaw = computeBearing(geo.fromLat, geo.fromLng, geo.toLat, geo.toLng);
    const bearing = bearingRaw > 180
      ? computeBearing(geo.toLat, geo.toLng, geo.fromLat, geo.fromLng)
      : bearingRaw;
    const fromLat = bearingRaw > 180 ? geo.toLat : geo.fromLat;
    const fromLng = bearingRaw > 180 ? geo.toLng : geo.fromLng;
    const toLat = bearingRaw > 180 ? geo.fromLat : geo.toLat;
    const toLng = bearingRaw > 180 ? geo.fromLng : geo.toLng;
    const segRef = db.doc(`streetSegments/${resolvedId}`);
    const existing = await segRef.get();
    if (!existing.exists) {
      createdHost = true;
      await segRef.set({
        cityId: 'nyc',
        streetName: streetName || 'Street',
        fromCross: hint.fromCross || '',
        toCross: hint.toCross || '',
        borough: hint.borough || '',
        fromLat,
        fromLng,
        toLat,
        toLng,
        centerLat: geo.centerLat,
        centerLng: geo.centerLng,
        bearing,
        geohash: geohashForLocation([geo.centerLat, geo.centerLng]),
        evenSideIsPositiveCross: false,
        source: 'park_nyc',
        provenance: { provider: 'park_nyc' },
        status: 'active',
        confidenceScore: 0.95,
        blockFaceEvidence: { blockDecisive: true, sideResolved: true, parseComplete: true },
        confidence: { level: 'community', source: 'nyc_open_data', lastVerifiedAt: now, communityConfirmations: 0 },
        editedBy: 'system:park_nyc',
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  await db.doc(`streetSegments/${resolvedId}/streetRules/park_nyc_v1`).set(ruleWrite);
  return {
    success: true,
    segmentId: resolvedId,
    parkingSide,
    streetName,
    createdHost,
  };
}

module.exports = { persistPublicMeterRule, publicMeterWrite };
