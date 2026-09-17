import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// The production redactor, so the error path is exercised exactly as it ships.
const { sanitizeError } = require('./redactForLog');

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(resolve(HERE, 'index.js'), 'utf-8');
const CLIENT_SRC = readFileSync(resolve(HERE, '../views/StreetParkingView.tsx'), 'utf-8');

/**
 * The live nfid-uabd schema, taken from the dataset's own X-SODA2-Fields header.
 * The fallback previously queried `street` and ordered by `objectid`, neither of
 * which exists — Socrata answered 400 on page 0, the loop `break`s on !res.ok, and
 * the fallback silently returned zero rows for every lookup in production. These
 * tests pin the query to columns that actually exist so it cannot regress quietly.
 */
const NFID_UABD_FIELDS = new Set([
  'order_number', 'record_type', 'order_type', 'borough', 'on_street', 'on_street_suffix',
  'from_street', 'from_street_suffix', 'to_street', 'to_street_suffix', 'side_of_street',
  'order_completed_on_date', 'sign_code', 'sign_description', 'sign_size',
  'sign_design_voided_on_date', 'sign_location', 'distance_from_intersection',
  'arrow_direction', 'facing_direction', 'sheeting_type', 'support', 'sign_notes',
  'sign_x_coord', 'sign_y_coord',
]);

/** Extracts a top-level `async function name(...) { ... }` by brace matching. */
function extractFn(src, name) {
  const start = src.indexOf('async function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

// Runs the REAL production function with an injected fetch — not a re-implementation.
// `_socrataToken` is injected too: in production it reads the bound Secret Manager
// param, which is not available to a unit run.
function loadQueryFn(fetchImpl, warn, token) {
  const body = extractFn(INDEX_SRC, '_queryNYCOpenData');
  // eslint-disable-next-line no-new-func
  return new Function('fetch', 'console', 'process', 'sanitizeError', '_socrataToken', body + '; return _queryNYCOpenData;')(
    fetchImpl,
    { log: () => {}, warn: warn || (() => {}) },
    { env: {} },
    sanitizeError,
    () => token || '',
  );
}

const okPage = (rows) => ({ ok: true, status: 200, json: async () => rows });
const row = (i) => ({
  order_number: 'P-' + i, record_type: 'Current', borough: 'Manhattan', on_street: 'BROADWAY',
  from_street: 'PRINCE STREET', to_street: 'SPRING STREET', side_of_street: 'W',
  sign_description: 'NO PARKING MONDAY-FRIDAY 8AM-6PM',
});
const paramsOf = (u) => new URL(u).searchParams;

describe('NYC Open Data fallback — query correctness', () => {
  let urls;
  beforeEach(() => { urls = []; });
  const capture = (res) => async (u) => {
    urls.push(u);
    return typeof res === 'function' ? res(urls.length - 1) : res;
  };

  it('1. the generated query references only columns that exist in nfid-uabd', async () => {
    const fn = loadQueryFn(capture(okPage([])));
    await fn('%BROADWAY%', 'Manhattan');
    const p = paramsOf(urls[0]);
    const where = p.get('$where');
    const idents = [...where.matchAll(/([a-z_][a-z0-9_]*)\s*(?:=|LIKE)/gi)].map((m) => m[1]);
    expect(idents.length).toBeGreaterThan(0);
    for (const id of idents) {
      expect(NFID_UABD_FIELDS.has(id), '$where references non-existent column "' + id + '"').toBe(true);
    }
    const order = p.get('$order');
    // ':id' is Socrata's system row key — valid for any dataset, so it is exempt
    // from the column check; any OTHER order value must be a real column.
    if (order && order !== ':id') {
      const col = order.replace(/\s+(ASC|DESC)$/i, '').trim();
      expect(NFID_UABD_FIELDS.has(col), '$order references non-existent column "' + col + '"').toBe(true);
    }
  });

  it('2. filters on on_street with the caller-supplied LIKE pattern', async () => {
    const fn = loadQueryFn(capture(okPage([])));
    await fn('%WEST 4 STREET%', 'Brooklyn');
    const where = paramsOf(urls[0]).get('$where');
    expect(where).toContain("on_street LIKE '%WEST 4 STREET%'");
    expect(where).toContain("record_type='Current'");
    expect(where).toContain("borough='Brooklyn'");
  });

  it('3. the removed street / objectid references cannot drift back in', () => {
    const q = extractFn(INDEX_SRC, '_queryNYCOpenData');
    expect(q).not.toMatch(/\bobjectid\b/);
    // `street LIKE` was the exact defect; `on_street LIKE` must not count as a match.
    expect(q).not.toMatch(/(?<!on_)\bstreet\s+LIKE/i);
    // provenance previously read r.order_no / r.objectid, neither of which exists
    expect(INDEX_SRC).not.toMatch(/\br\.order_no\b/);
    expect(INDEX_SRC).not.toMatch(/\br\.objectid\b/);
  });

  it('4. rows returned by Socrata are handed back for parsing, unmodified', async () => {
    const rows = [row(1), row(2), row(3)];
    const fn = loadQueryFn(capture(okPage(rows)));
    const out = await fn('%BROADWAY%', 'Manhattan');
    expect(out).toHaveLength(3);
    for (const f of ['sign_description', 'from_street', 'to_street', 'side_of_street', 'order_number']) {
      expect(out[0][f]).toBe(rows[0][f]);
    }
  });

  it('5. paginates across pages and stops on a short page', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => row(i));
    const fn = loadQueryFn(capture((n) => okPage(n === 0 ? full : full.slice(0, 10))));
    const out = await fn('%BROADWAY%', 'Manhattan');
    expect(urls).toHaveLength(2);
    expect(out).toHaveLength(1010);
    expect(paramsOf(urls[0]).get('$offset')).toBe('0');
    expect(paramsOf(urls[1]).get('$offset')).toBe('1000');
    expect(paramsOf(urls[0]).get('$limit')).toBe('1000');
  });

  it('5b. caps at MAX_PAGES even when every page is full', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => row(i));
    const fn = loadQueryFn(capture(okPage(full)));
    const out = await fn('%BROADWAY%', 'Manhattan');
    expect(urls).toHaveLength(3);
    expect(out).toHaveLength(3000);
  });

  it('5c. every page uses the same stable order key, so pages cannot overlap', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => row(i));
    const fn = loadQueryFn(capture(okPage(full)));
    await fn('%BROADWAY%', 'Manhattan');
    const orders = urls.map((u) => paramsOf(u).get('$order'));
    expect(new Set(orders).size).toBe(1);
    expect(orders[0]).toBe(':id');
  });

  for (const status of [400, 429, 500, 503]) {
    it('6. HTTP ' + status + ' degrades to zero rows without throwing or retrying', async () => {
      const warnings = [];
      const fn = loadQueryFn(capture({ ok: false, status }), (...a) => warnings.push(a.join(' ')));
      const out = await fn('%BROADWAY%', 'Manhattan');
      expect(out).toEqual([]);
      expect(urls).toHaveLength(1); // no retry, no outage amplification
      expect(warnings.join(' ')).toContain(String(status));
    });
  }

  it('6b. a network timeout/rejection degrades to zero rows without throwing', async () => {
    const fn = loadQueryFn(async () => { throw new Error('ETIMEDOUT'); });
    await expect(fn('%BROADWAY%', 'Manhattan')).resolves.toEqual([]);
  });

  it('6c. a partial outage keeps the rows already collected', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => row(i));
    const fn = loadQueryFn(capture((n) => (n === 0 ? okPage(full) : { ok: false, status: 503 })));
    const out = await fn('%BROADWAY%', 'Manhattan');
    expect(out).toHaveLength(1000);
  });
});

describe('NYC Open Data fallback — when Socrata is reached at all', () => {
  it('7. a cached streetSegments hit calls the CF (and therefore Socrata) zero times', () => {
    // The only zero-request guarantee lives client-side: the CF is invoked solely
    // when the geohash query found no active segment. (The server-side dedup on
    // streetSegments/{docId} runs AFTER the fetch, so it prevents a duplicate
    // WRITE, not a duplicate Socrata request.)
    const guard = CLIENT_SRC.indexOf('if (!candidates.length)');
    expect(guard).toBeGreaterThan(-1);
    const cfIdx = CLIENT_SRC.indexOf("'createSegmentFromSweepNYC'", guard);
    const nearestIdx = CLIENT_SRC.indexOf('const withDist', guard);
    expect(cfIdx).toBeGreaterThan(guard);
    expect(cfIdx).toBeLessThan(nearestIdx); // call sits inside the guarded block
  });

  it('8. a successful SweepNYC lookup bypasses the Socrata fallback', () => {
    const start = INDEX_SRC.indexOf('exports.createSegmentFromSweepNYC');
    const seg = INDEX_SRC.slice(start, start + 2000);
    const successGate = seg.indexOf('if (sweepResult.success || !_SWEEPNYC_FALLBACK_REASONS.has(sweepResult.reason))');
    const reasonGate = seg.indexOf('_SWEEPNYC_FALLBACK_REASONS.has(sweepResult.reason)');
    const fallbackCall = seg.indexOf('_fallbackToNYCOpenData(lat, lng)');
    expect(successGate).toBeGreaterThan(-1);
    expect(reasonGate).toBeGreaterThanOrEqual(successGate);
    expect(fallbackCall).toBeGreaterThan(reasonGate);
  });

  it('8b. only the four documented reasons fall through to Socrata', () => {
    const m = INDEX_SRC.match(/_SWEEPNYC_FALLBACK_REASONS = new Set\(\[([\s\S]*?)\]\)/);
    expect(m).toBeTruthy();
    const reasons = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(reasons).toEqual(['no_signs', 'no_sweepnyc_data', 'no_sweepnyc_notes', 'parse_failed']);
  });
});
