'use strict';

const { HttpsError } = require('firebase-functions/v2/https');

/**
 * Trims and lowercases an email address and rejects anything that is not a
 * plain ASCII addr-spec. No provider-specific rewriting (dots, +tags) — two
 * inboxes that differ only there stay distinct.
 *
 * Shared by the email OTP callables, the waitlist endpoints and the
 * Squarespace waitlist importer, so every path agrees on what one address is.
 */
function canonicalizeEmail(value) {
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', 'Valid email required.');
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[\x21-\x7e]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Valid email required.');
  }
  const parts = email.split('@');
  if (parts.length !== 2) throw new HttpsError('invalid-argument', 'Valid email required.');
  const [local, domain] = parts;
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) {
    throw new HttpsError('invalid-argument', 'Valid email required.');
  }
  const labels = domain.split('.');
  if (domain.length > 253 || labels.length < 2 || labels.some(label =>
      !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
      !/[a-z]/.test(labels.at(-1))) {
    throw new HttpsError('invalid-argument', 'Valid email required.');
  }
  return email;
}

module.exports = { canonicalizeEmail };
