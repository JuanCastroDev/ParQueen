'use strict';

const PARK_NYC_RESOURCE_ID = 'e7yp-wx55';
const TIME_ZONE = 'America/New_York';
const DAY_NAMES = Object.freeze({
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu',
  Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
});
const DAYS = Object.freeze(Object.keys(DAY_NAMES));
const VEHICLE_CLASSES = Object.freeze({
  'All Vehicles': { vehicleClass: 'ALL_VEHICLES', passengerApplicable: true, commercialApplicable: true },
  'Commercial Only': { vehicleClass: 'COMMERCIAL_ONLY', passengerApplicable: false, commercialApplicable: true },
  'Dual (Commercial / All Vehicles)': { vehicleClass: 'DUAL', passengerApplicable: true, commercialApplicable: true },
  'Charter Bus Only': { vehicleClass: 'CHARTER_BUS_ONLY', passengerApplicable: false, commercialApplicable: false },
});

function unavailable(raw) {
  return typeof raw !== 'string' || raw.trim() === '' || raw.trim().toUpperCase() === 'N/A';
}

function parseMaximumDuration(raw) {
  if (unavailable(raw)) return { ok: false, reason: 'term_unavailable', raw };
  const match = raw.trim().match(/^(\d+)\s+Hours?$/);
  if (!match) return { ok: false, reason: 'unsupported_duration_format', raw };
  const hours = Number(match[1]);
  if (!Number.isSafeInteger(hours) || hours <= 0) {
    return { ok: false, reason: 'unsupported_duration_format', raw };
  }
  return { ok: true, minutes: hours * 60, raw };
}

function parseClock(hourText, minuteText, meridiem) {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (!Number.isInteger(hour) || hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (hour === 12) hour = 0;
  if (meridiem.toUpperCase() === 'PM') hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function expandDays(raw) {
  const range = raw.match(/^([A-Za-z]+)-([A-Za-z]+)$/);
  if (range) {
    const start = DAYS.indexOf(range[1]);
    const end = DAYS.indexOf(range[2]);
    if (start < 0 || end < start) return null;
    return DAYS.slice(start, end + 1).map(day => DAY_NAMES[day]);
  }
  const names = raw.split(',').map(value => value.trim());
  if (!names.length || names.some(name => !DAY_NAMES[name])) return null;
  return names.map(name => DAY_NAMES[name]);
}

function parseMeterSchedule(raw) {
  if (unavailable(raw)) return { ok: false, reason: 'term_unavailable', raw };
  const windows = [];
  for (const clause of raw.split(';').map(value => value.trim())) {
    const match = clause.match(/^([A-Za-z]+(?:-[A-Za-z]+|(?:,\s*[A-Za-z]+)*))\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)-(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (!match) return { ok: false, reason: 'unsupported_schedule_format', raw };
    const normalizedDayText = match[1].split(/([,-])/).map(part => {
      const lower = part.toLowerCase();
      return DAYS.find(day => day.toLowerCase() === lower) || part;
    }).join('');
    const days = expandDays(normalizedDayText);
    const startTime = parseClock(match[2], match[3], match[4]);
    const endTime = parseClock(match[5], match[6], match[7]);
    if (!days || !startTime || !endTime || startTime === endTime) {
      return { ok: false, reason: 'unsupported_schedule_format', raw };
    }
    windows.push({ days, startTime, endTime, overnight: endTime < startTime });
  }
  return { ok: true, windows, raw, timeZone: TIME_ZONE };
}

function parseMeterRate(raw) {
  if (unavailable(raw)) return { ok: false, reason: 'term_unavailable', raw };
  const fixed = raw.trim().match(/^\$(\d+(?:\.\d{1,2})?)\s+per\s+(Hour|30 Minutes)$/i);
  if (fixed) {
    return { ok: true, kind: 'FIXED', amount: Number(fixed[1]), unitMinutes: fixed[2].toLowerCase() === 'hour' ? 60 : 30, raw };
  }
  const parts = raw.split('/').map(value => value.trim());
  if (parts.length >= 2) {
    const tiers = parts.map(part => part.match(/^\$(\d+(?:\.\d{1,2})?)\s+(\d+)(?:st|nd|rd|th)\s+Hour$/i));
    if (tiers.every(Boolean) && tiers.every((match, index) => Number(match[2]) === index + 1)) {
      return { ok: true, kind: 'TIERED_HOURLY', tiers: tiers.map(match => ({ ordinal: Number(match[2]), amount: Number(match[1]) })), raw };
    }
  }
  return { ok: false, reason: 'unsupported_rate_format', raw };
}

function parseMaximumCharge(raw) {
  if (unavailable(raw)) return { ok: false, reason: 'term_unavailable', raw };
  const match = raw.trim().match(/^\$(\d+(?:\.\d{1,2})?)$/);
  if (!match) return { ok: false, reason: 'unsupported_maximum_charge_format', raw };
  return { ok: true, amount: Number(match[1]), raw };
}

function validVersion(version) {
  return version && version.resourceId === PARK_NYC_RESOURCE_ID
    && typeof version.rowsUpdatedAt === 'string' && Number.isFinite(Date.parse(version.rowsUpdatedAt))
    && typeof version.viewLastModified === 'string' && Number.isFinite(Date.parse(version.viewLastModified));
}

function validGeometry(geometry) {
  return geometry && geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)
    && geometry.coordinates.length > 0 && geometry.coordinates.every(line => Array.isArray(line) && line.length >= 2
      && line.every(point => Array.isArray(point) && point.length >= 2
        && Number.isFinite(point[0]) && Number.isFinite(point[1])
        && point[0] >= -75 && point[0] <= -73 && point[1] >= 40 && point[1] <= 41.5));
}

function normalizeStreet(raw) {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').toUpperCase() : '';
}

function buildBranch(durationRaw, scheduleRaw, rateRaw, maximumChargeRaw) {
  const duration = parseMaximumDuration(durationRaw);
  const schedule = parseMeterSchedule(scheduleRaw);
  const rate = parseMeterRate(rateRaw);
  const maximumCharge = parseMaximumCharge(maximumChargeRaw);
  const essentialFailure = !duration.ok ? duration : (!schedule.ok ? schedule : null);
  return {
    complete: !essentialFailure,
    essentialReason: essentialFailure ? essentialFailure.reason : null,
    rateComplete: rate.ok && maximumCharge.ok,
    maximumMinutes: duration.ok ? duration.minutes : null,
    schedule,
    rate,
    maximumCharge,
    sourceNative: { duration: durationRaw, schedule: scheduleRaw, rate: rateRaw, maximumCharge: maximumChargeRaw },
  };
}

function normalizeParkNycRow(row, sourceVersion) {
  if (!validVersion(sourceVersion)) return { ok: false, reason: 'invalid_source_version' };
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { ok: false, reason: 'invalid_row' };
  const vehicle = VEHICLE_CLASSES[row.vehicle_ty];
  if (!vehicle) return { ok: false, reason: 'unknown_vehicle_class' };
  if (!validGeometry(row.the_geom)) return { ok: false, reason: 'invalid_meter_geometry' };
  const zoneId = typeof row.pay_by_cel === 'string' ? row.pay_by_cel.trim() : '';
  if (!/^\d+$/.test(zoneId)) return { ok: false, reason: 'invalid_zone_id' };
  const side = typeof row.side_of_st === 'string' ? row.side_of_st.trim().toUpperCase() : '';
  if (!['N', 'S', 'E', 'W'].includes(side)) return { ok: false, reason: 'invalid_side' };

  const passenger = vehicle.passengerApplicable
    ? buildBranch(row.all_vehicl, row.all_vehi_1, row.all_vehi_2, row.all_vehi_3) : null;
  const commercial = row.vehicle_ty === 'Commercial Only' || row.vehicle_ty === 'Dual (Commercial / All Vehicles)'
    ? buildBranch(row.commercial, row.commerci_1, row.commerci_2, row.commerci_3) : null;
  return {
    ok: true,
    record: {
      zoneId,
      ...vehicle,
      geometry: row.the_geom,
      borough: normalizeStreet(row.borough),
      onStreet: normalizeStreet(row.on_street),
      side,
      fromStreet: normalizeStreet(row.from_stree),
      toStreet: normalizeStreet(row.to_street),
      rateZone: row.meter_rate,
      shapeLength: row.shape_leng,
      branches: { passenger, commercial },
      sourceVersion: { ...sourceVersion },
      sourceNative: { ...row },
    },
  };
}

module.exports = {
  PARK_NYC_RESOURCE_ID,
  normalizeParkNycRow,
  parseMaximumDuration,
  parseMeterRate,
  parseMeterSchedule,
};
