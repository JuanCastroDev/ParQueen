'use strict';
/**
 * Server-side log redaction for Cloud Functions (TM-17).
 * Mirrors utils/redactForLog.ts — keep the SENSITIVE regex in sync.
 *
 * Usage:
 *   const { redactForLog } = require('./redactForLog');
 *   console.log('user prefs', JSON.stringify(redactForLog(userData)));
 */

const SENSITIVE = /phone|email|token|fcm|lat\b|lng\b|lon\b|coordinate|message|body|text|content|prompt|response|reply|password|secret|credential|apikey|api_key|auth|otp|\bcode\b/i;

function redactForLog(obj, deep = false) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const out = {};
    for (const key of Object.keys(obj)) {
        if (SENSITIVE.test(key)) {
            out[key] = '[REDACTED]';
        } else if (deep && obj[key] !== null && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
            out[key] = redactForLog(obj[key], true);
        } else {
            out[key] = obj[key];
        }
    }
    return out;
}

// Allowlist patterns for error name and code — rejects arbitrary strings
// that could contain user data, stack paths, or API response fragments.
const SAFE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE_RE = /^[A-Za-z0-9_\-/]{0,64}$/;

/**
 * Safe error summary for console.error — never logs message, stack, or request body.
 * Returns only the allowlisted error class name and Firebase/HTTP error code.
 * Unexpected name/code values fall back to generic tokens.
 * Usage: console.error('op failed:', sanitizeError(err))
 */
function sanitizeError(err) {
    if (!err) return 'unknown';
    const rawName = typeof err.name === 'string' ? err.name : '';
    const rawCode = typeof err.code === 'string' ? err.code
        : Number.isInteger(err.code) ? String(err.code) // gRPC status codes
        : typeof err.status === 'number' ? String(err.status) : '';
    const name = SAFE_NAME_RE.test(rawName) ? rawName : 'Error';
    const code = SAFE_CODE_RE.test(rawCode) ? rawCode : '';
    return code ? `${name}/${code}` : name;
}

module.exports = { redactForLog, sanitizeError };
