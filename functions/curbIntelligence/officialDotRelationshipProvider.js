'use strict';

const { normalizeBlockFaceId } = require('./curbIdentity');

const APPLICABILITY = Object.freeze({
  WHOLE_FACE: 'WHOLE_FACE',
  UNKNOWN: 'UNKNOWN',
});

const text = value => typeof value === 'string' && value.trim()
  ? value.trim().toUpperCase() : null;

// NYC DOT's official data dictionary defines P- and S- as block-front
// order_type values and B- as a multi-block blanket/stretch order_type.
function geometryForOrderType(orderType) {
  const value = text(orderType);
  if (value === 'P-' || value === 'S-') return 'BLOCK_FRONT';
  if (value === 'B-') return 'STRETCH';
  return 'UNKNOWN';
}

function sameSourceVersion(left, right) {
  return left?.resourceId === right?.resourceId
    && left?.rowsUpdatedAt === right?.rowsUpdatedAt
    && left?.viewLastModified === right?.viewLastModified;
}

function validDotVersion(value) {
  return value?.resourceId === 'nfid-uabd'
    && typeof value.rowsUpdatedAt === 'string' && Number.isFinite(Date.parse(value.rowsUpdatedAt))
    && typeof value.viewLastModified === 'string' && Number.isFinite(Date.parse(value.viewLastModified));
}

function resolverVersionToken(value) {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 128);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value)
    .filter(([, item]) => ['string', 'number'].includes(typeof item) && String(item).trim())
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return null;
  return entries.map(([key, item]) => `${key}:${String(item).trim()}`).join(',').slice(0, 256);
}

function orderContext(candidate) {
  return {
    geometry: geometryForOrderType(candidate.orderType),
    borough: text(candidate.borough),
    onStreet: text(candidate.onStreet),
    fromStreet: text(candidate.fromStreet),
    toStreet: text(candidate.toStreet),
    side: text(candidate.side),
    onStreetSuffix: text(candidate.onStreetSuffix),
    fromStreetSuffix: text(candidate.fromStreetSuffix),
    toStreetSuffix: text(candidate.toStreetSuffix),
  };
}

function sameContext(left, right) {
  return Object.keys(left).every(key => left[key] === right[key]);
}

function completeContext(context) {
  return Boolean(context.borough && context.onStreet && context.fromStreet && context.toStreet
    && ['N', 'S', 'E', 'W'].includes(context.side));
}

function hasSuffix(context) {
  return Boolean(context.onStreetSuffix || context.fromStreetSuffix || context.toStreetSuffix);
}

function groupByOrder(candidates) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const orderNumber = text(candidate?.orderNumber);
    if (!orderNumber) continue;
    if (!grouped.has(orderNumber)) grouped.set(orderNumber, []);
    grouped.get(orderNumber).push(candidate);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function snapshotReason(snapshot, candidates) {
  if (snapshot?.completeness?.state !== 'COMPLETE') return 'candidate_source_incomplete';
  if (!validDotVersion(snapshot?.sourceVersion)) return 'source_version_mismatch';
  if (candidates.some(row => !sameSourceVersion(row?.sourceVersion, snapshot.sourceVersion))) {
    return 'source_version_mismatch';
  }
  return null;
}

function baseReason(rows, context) {
  if (rows.some(row => row?.recordType !== 'Current')) return 'dot_order_location_incomplete';
  if (rows.some(row => !sameContext(orderContext(row), context))) return 'dot_order_location_conflict';
  if (!completeContext(context)) return 'dot_order_location_incomplete';
  if (hasSuffix(context)) return 'dot_suffix_unresolved';
  if (context.geometry === 'STRETCH') return 'dot_stretch_requires_decomposition';
  if (context.geometry !== 'BLOCK_FRONT') return 'dot_geometry_applicability_unknown';
  return null;
}

function normalizedResolverNames(value) {
  const names = value?.normalizedStreetNames;
  const onStreet = text(names?.onStreet);
  const crossStreetOne = text(names?.crossStreetOne);
  const crossStreetTwo = text(names?.crossStreetTwo);
  return onStreet && crossStreetOne && crossStreetTwo
    ? { onStreet, crossStreetOne, crossStreetTwo } : null;
}

function resolverFailureReason(value) {
  if (String(value?.returnCode || '').trim() === '46'
    || String(value?.reasonCode || '').toLowerCase().includes('ambig')) {
    return 'official_blockface_ambiguous';
  }
  return 'official_blockface_lookup_failed';
}

function createOfficialDotRelationshipProvider(options = {}) {
  const blockfaceResolver = options.blockfaceResolver;
  const providerId = typeof options.providerId === 'string' && options.providerId.trim()
    ? options.providerId.trim() : 'official-dot-blockface-relationship';

  return Object.freeze({
    async resolve(input = {}) {
      const snapshot = input.candidateSnapshot;
      const candidates = Array.isArray(snapshot?.candidates) ? snapshot.candidates : [];
      const groups = groupByOrder(candidates);
      const globalReason = snapshotReason(snapshot, candidates);
      const targetFace = normalizeBlockFaceId(input.resolution?.officialIdentity?.officialBlockFaceId);
      const orderApplicability = {};
      const orderReasons = {};
      const resolverVersions = new Set();
      const resolvedOrders = [];
      const officialNames = {
        onStreet: new Set(),
        crossStreetOne: new Set(),
        crossStreetTwo: new Set(),
      };

      for (const [orderNumber, rows] of groups) {
        const context = orderContext(rows[0]);
        orderApplicability[orderNumber] = APPLICABILITY.UNKNOWN;
        orderReasons[orderNumber] = [];

        const reason = globalReason || baseReason(rows, context);
        if (reason) {
          orderReasons[orderNumber].push(reason);
          continue;
        }
        if (!targetFace) {
          orderReasons[orderNumber].push('official_blockface_mismatch');
          continue;
        }
        if (!blockfaceResolver || typeof blockfaceResolver.resolve !== 'function') {
          orderReasons[orderNumber].push('official_blockface_lookup_unavailable');
          continue;
        }

        let resolved;
        try {
          resolved = await blockfaceResolver.resolve({
            borough: context.borough,
            onStreet: context.onStreet,
            crossStreetOne: context.fromStreet,
            crossStreetTwo: context.toStreet,
            compassDirection: context.side,
            signal: input.signal,
          });
        } catch {
          orderReasons[orderNumber].push('official_blockface_lookup_failed');
          continue;
        }

        if (resolverFailureReason(resolved) === 'official_blockface_ambiguous') {
          orderReasons[orderNumber].push('official_blockface_ambiguous');
          continue;
        }
        if (resolved?.ok !== true) {
          orderReasons[orderNumber].push(resolverFailureReason(resolved));
          continue;
        }
        const returnedFace = normalizeBlockFaceId(resolved.officialBlockFaceId);
        const names = normalizedResolverNames(resolved);
        const version = resolverVersionToken(resolved.sourceVersion);
        const returnCode = String(resolved.returnCode ?? '').trim();
        if (!returnedFace || !names || !version || !returnCode) {
          orderReasons[orderNumber].push('official_blockface_lookup_failed');
          continue;
        }
        if (returnedFace !== targetFace) {
          orderReasons[orderNumber].push('official_blockface_mismatch');
          continue;
        }

        orderApplicability[orderNumber] = APPLICABILITY.WHOLE_FACE;
        resolvedOrders.push(orderNumber);
        resolverVersions.add(version);
        officialNames.onStreet.add(names.onStreet);
        officialNames.crossStreetOne.add(names.crossStreetOne);
        officialNames.crossStreetTwo.add(names.crossStreetTwo);
      }

      if (resolverVersions.size > 1) {
        for (const orderNumber of resolvedOrders) {
          orderApplicability[orderNumber] = APPLICABILITY.UNKNOWN;
          orderReasons[orderNumber].push('source_version_mismatch');
        }
      }

      const anchor = candidates[0] ? orderContext(candidates[0]) : {};
      const streetNames = officialNames.onStreet.size
        ? [...officialNames.onStreet].sort() : [anchor.onStreet].filter(Boolean);
      const fromNames = officialNames.crossStreetOne.size
        ? [...officialNames.crossStreetOne].sort() : [anchor.fromStreet].filter(Boolean);
      const toNames = officialNames.crossStreetTwo.size
        ? [...officialNames.crossStreetTwo].sort() : [anchor.toStreet].filter(Boolean);
      const resolverVersion = resolverVersions.size === 1 ? [...resolverVersions][0] : null;
      const dotVersion = validDotVersion(snapshot?.sourceVersion)
        ? `${snapshot.sourceVersion.resourceId}@${snapshot.sourceVersion.rowsUpdatedAt}`
          + `#${snapshot.sourceVersion.viewLastModified}`
        : 'dot-version-unresolved';
      return {
        ok: true,
        faceContext: {
          curbIdentityState: input.resolution?.state,
          borough: anchor.borough,
          streetNames,
          fromNames,
          toNames,
          side: anchor.side,
          officialRelationship: {
            providerId,
            version: `${dotVersion}|blockface:${resolverVersion || 'unresolved'}`,
            orderApplicability,
          },
        },
        diagnostics: { orderReasons },
      };
    },
  });
}

module.exports = { createOfficialDotRelationshipProvider };
