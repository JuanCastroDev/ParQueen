'use strict';

const DOT_FIELDS = Object.freeze([
  'order_number', 'record_type', 'order_type', 'borough', 'on_street', 'on_street_suffix',
  'from_street', 'from_street_suffix', 'to_street', 'to_street_suffix', 'side_of_street',
  'order_completed_on_date', 'sign_code', 'sign_description', 'sign_size',
  'sign_design_voided_on_date', 'sign_location', 'distance_from_intersection',
  'arrow_direction', 'facing_direction', 'sheeting_type', 'support', 'sign_notes',
  'sign_x_coord', 'sign_y_coord',
]);

const text = value => typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
const optionalNumber = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function validVersion(version) {
  return version?.resourceId === 'nfid-uabd'
    && typeof version.rowsUpdatedAt === 'string' && Number.isFinite(Date.parse(version.rowsUpdatedAt))
    && typeof version.viewLastModified === 'string' && Number.isFinite(Date.parse(version.viewLastModified));
}

function normalizeDotSignRow(row, sourceVersion) {
  if (!validVersion(sourceVersion)) return { ok: false, reason: 'invalid_source_version' };
  if (!row || row.record_type !== 'Current') return { ok: false, reason: 'not_current' };
  const orderNumber = text(row.order_number);
  const signCode = text(row.sign_code);
  const signDescription = typeof row.sign_description === 'string' && row.sign_description.trim()
    ? row.sign_description : null;
  if (!orderNumber || !signCode || !signDescription) return { ok: false, reason: 'invalid_sign_identity' };
  const borough = text(row.borough);
  const onStreet = text(row.on_street);
  const fromStreet = text(row.from_street);
  const toStreet = text(row.to_street);
  const side = text(row.side_of_street);
  if (!borough || !onStreet || !fromStreet || !['N', 'S', 'E', 'W'].includes(side)) {
    return { ok: false, reason: 'invalid_placement_evidence' };
  }
  const sourceNative = Object.fromEntries(DOT_FIELDS.map(field => [field, row[field] ?? null]));
  return {
    ok: true,
    record: {
      orderNumber,
      recordType: 'Current',
      orderType: text(row.order_type),
      borough,
      onStreet,
      onStreetSuffix: text(row.on_street_suffix),
      fromStreet,
      fromStreetSuffix: text(row.from_street_suffix),
      toStreet,
      toStreetSuffix: text(row.to_street_suffix),
      side,
      signCode,
      signDescription,
      signLocation: row.sign_location ?? null,
      distanceFromIntersection: optionalNumber(row.distance_from_intersection),
      arrowDirection: text(row.arrow_direction),
      facingDirection: text(row.facing_direction),
      projectedSignCoordinate: {
        x: optionalNumber(row.sign_x_coord),
        y: optionalNumber(row.sign_y_coord),
        // nfid-uabd does not publish a CRS for these projected-looking values.
        crs: null,
      },
      sourceVersion: { ...sourceVersion },
      sourceNative,
    },
  };
}

module.exports = { DOT_FIELDS, normalizeDotSignRow };
