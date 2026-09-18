'use strict';

const { normalizeDotSignRow } = require('./dotSignNormalizer');

function incomplete(reason, sourceVersion = null) {
  return { candidates: [], completeness: { state: 'INCOMPLETE', reason }, sourceVersion };
}

function createReusedDotSnapshot(evidence = {}) {
  const sourceVersion = evidence.sourceVersion || null;
  if (evidence.complete !== true) return incomplete('dot_evidence_incomplete', sourceVersion);
  if (!Array.isArray(evidence.selectedRows)) return incomplete('dot_evidence_malformed', sourceVersion);
  const rawOrders = new Set(evidence.selectedRows.map(row => (
    typeof row?.order_number === 'string' ? row.order_number.trim() : ''
  )).filter(Boolean));
  if (rawOrders.size !== 1) return incomplete('dot_order_count_invalid', sourceVersion);
  const normalized = evidence.selectedRows.map(row => normalizeDotSignRow(row, sourceVersion));
  if (normalized.some(value => value.ok !== true)) return incomplete('dot_evidence_malformed', sourceVersion);
  return {
    candidates: normalized.map(value => value.record),
    completeness: { state: 'COMPLETE', reason: null },
    sourceVersion: { ...sourceVersion },
  };
}

function createReusedDotCandidateSource(evidence = {}) {
  return Object.freeze({
    async query() {
      return createReusedDotSnapshot(evidence);
    },
  });
}

module.exports = { createReusedDotSnapshot, createReusedDotCandidateSource };
