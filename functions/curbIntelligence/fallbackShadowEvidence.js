'use strict';

function createFallbackShadowEvidence(input = {}) {
  if (input.existingDedup === true) return null;
  const selectedRows = input.selectedRows;
  const queryRows = input.queryEvidence?.rows;
  const reusable = Array.isArray(selectedRows) && Array.isArray(queryRows)
    && selectedRows.every(row => queryRows.includes(row));
  const complete = reusable && input.queryEvidence?.complete === true
    && input.queryEvidence?.sourceVersion?.resourceId === 'nfid-uabd';
  return {
    productionPath: 'nyc_open_data_fallback',
    dotEvidence: {
      selectedRows,
      complete,
      sourceVersion: complete ? input.queryEvidence.sourceVersion : null,
    },
    legacyEvidence: {
      segment: input.segment,
      activeRules: [input.rule],
    },
  };
}

module.exports = { createFallbackShadowEvidence };
