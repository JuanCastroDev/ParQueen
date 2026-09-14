'use strict';

const { parseNYCOpenDataSign } = require('../nycOpenDataNormalizer');

const CLEANING_IDENTITY_EXCEPTIONS_VERSION = '2026-09-14.1';
const STANDARD_BROOM_MARKER = '(SANITATION BROOM SYMBOL)';
const CONTEXTUAL_RIDER_CODES = new Set(['PS-6A', 'PS-7A']);

const normalizeSourceText = value => String(value || '')
  .toUpperCase()
  .replace(/\s+/g, ' ')
  .trim();

// These exceptions are deliberately exact code-and-description pairs from the
// reviewed NYC DOT source rows. They are not patterns and must not expand into
// fuzzy typo matching.
const REVIEWED_CLEANING_IDENTITY_EXCEPTIONS = new Map([
  ['PS-188B', normalizeSourceText('NO PARKING (SANITATION BRROM SYMBOL) MOON & STARS (SYMBOLS) FRIDAY 3AM-6AM <-> (SUPERSEDES SP-554C)')],
  ['PS-162BA', normalizeSourceText('NO PARKING (SANITATION BROOMM SYMBOL) FRIDAY 10:30AM-NOON --> (SUPERSEDES SP-401CA)')],
  ['PS-165BA', normalizeSourceText('NO PARKING (SANITATIOJN BROOM SYMBOL) MOON & STARS (SYMBOLS) 3AM-6AM EXCEPT SUNDAY --> (SUPERSEDES SP-795CA)')],
]);

function rejected(reason, row) {
  return {
    classified: false,
    reason,
    evidence: {
      signCode: typeof row?.sign_code === 'string' ? row.sign_code.trim().toUpperCase() : null,
      recordType: typeof row?.record_type === 'string' ? row.record_type.trim() : null,
      rawText: typeof row?.sign_description === 'string' ? row.sign_description : null,
      source: 'nyc_dot_sign_inventory',
    },
  };
}

function clockMinutes(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function classifyStreetCleaningSign(row, streetContext) {
  if (!row || typeof row !== 'object') return rejected('invalid_source_row', row);
  if (typeof row.sign_code !== 'string' || typeof row.sign_description !== 'string') {
    return rejected('invalid_source_row', row);
  }
  if (row.record_type !== 'Current') return rejected('not_current', row);

  const signCode = row.sign_code.trim().toUpperCase();
  const rawText = row.sign_description;
  const normalizedText = normalizeSourceText(rawText);

  if (CONTEXTUAL_RIDER_CODES.has(signCode)) return rejected('contextual_rider', row);
  if (
    signCode === 'SP-798C'
    || normalizedText.includes('TIMES & DAYS TO BE SPECIFIED')
    || normalizedText.includes('XYY-XYY')
  ) {
    return rejected('unresolved_template', row);
  }

  let identityKind = null;
  let exceptionTableVersion = null;
  if (normalizedText.includes(STANDARD_BROOM_MARKER)) {
    identityKind = 'standard_broom_marker';
  } else if (REVIEWED_CLEANING_IDENTITY_EXCEPTIONS.get(signCode) === normalizedText) {
    identityKind = 'reviewed_exception';
    exceptionTableVersion = CLEANING_IDENTITY_EXCEPTIONS_VERSION;
  } else {
    return rejected('unreviewed_cleaning_identity', row);
  }

  const parsed = parseNYCOpenDataSign(rawText, streetContext);
  if (!parsed || !Array.isArray(parsed.days) || parsed.days.length === 0) {
    return rejected('incomplete_schedule', row);
  }

  const start = clockMinutes(parsed.startTime);
  const end = clockMinutes(parsed.endTime);
  if (start === null || end === null) return rejected('incomplete_schedule', row);
  const durationMinutes = (end - start + 24 * 60) % (24 * 60);
  if (durationMinutes === 0) return rejected('incomplete_schedule', row);

  return {
    classified: true,
    schedule: { ...parsed, durationMinutes },
    evidence: {
      signCode,
      recordType: row.record_type,
      rawText,
      source: 'nyc_dot_sign_inventory',
      identityKind,
      exceptionTableVersion,
      parserProvenance: parsed.provenance,
    },
  };
}

module.exports = {
  CLEANING_IDENTITY_EXCEPTIONS_VERSION,
  REVIEWED_CLEANING_IDENTITY_EXCEPTIONS,
  classifyStreetCleaningSign,
};
