'use strict';

const MAX_BFI = 9_999_999_999;

const fail = value => {
  throw new TypeError(`Invalid BFI value: ${String(value)}`);
};

const normalizeBfi = value => {
  let digits;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BFI) return fail(value);
    digits = String(value);
  } else if (typeof value === 'string') {
    if (!/^[0-9]{1,10}$/.test(value)) return fail(value);
    digits = value;
  } else {
    return fail(value);
  }

  if (/^0+$/.test(digits)) return fail(value);
  return digits.padStart(10, '0');
};

module.exports = { normalizeBfi };
