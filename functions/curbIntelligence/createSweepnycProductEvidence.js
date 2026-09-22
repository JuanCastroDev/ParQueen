'use strict';

const RESOLVER_BOROUGH = Object.freeze({
  MN: 'MANHATTAN',
  BX: 'BRONX',
  BK: 'BROOKLYN',
  QN: 'QUEENS',
  SI: 'STATEN ISLAND',
});

function resolverBorough(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const code = value.trim().toUpperCase();
  if (RESOLVER_BOROUGH[code]) return RESOLVER_BOROUGH[code];
  const upper = value.trim().toUpperCase();
  if (Object.values(RESOLVER_BOROUGH).includes(upper)) return upper;
  return null;
}

function createSweepnycProductEvidence({ segment, rule } = {}) {
  if (!segment || !rule) return null;
  return {
    productionPath: 'sweepnyc',
    streetContext: {
      borough: resolverBorough(segment.borough),
      onStreet: segment.streetName || segment.onStreet || null,
      crossStreetOne: segment.fromCross || null,
      crossStreetTwo: segment.toCross || null,
    },
    legacyEvidence: {
      segment,
      activeRules: [rule],
    },
  };
}

module.exports = {
  resolverBorough,
  createSweepnycProductEvidence,
};
