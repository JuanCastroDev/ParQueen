'use strict';

// Server-owned admin read views — coordinated read-side remediation.
//
// The Admin Dashboard used to read users, reports, adminAuditLog,
// parkingSessions, parseFailures, and (for the finder/claimer-blind branch)
// spots directly against the client Firestore SDK, authorized by
// firestore.rules' token-only isAdmin() check. Exactly like the direct-write
// gap closed for streetSegments/streetRules, Rules cannot re-verify current
// server-side Auth state — a demoted/deleted/disabled admin's stale token
// could keep reading this data until the token naturally expired.
//
// Every view here is invoked only through adminReadView (functions/index.js),
// which calls requireCurrentAdmin(request) before dispatching. The client
// selects a view by a fixed enum name and may pass only the narrow,
// individually-validated params documented per view below — never an
// arbitrary collection, field list, filter, or query shape. Each view
// hard-bounds its own result size.
//
// Field selection matches exactly what the corresponding Admin Dashboard
// component already displays (see the view's original client file, noted
// per view) — nothing beyond that is returned.

const { HttpsError } = require('firebase-functions/v2/https');

const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 500;
const ENRICH_UID_MAX = 300;

// Shared cursor-pagination helper — same technique as
// adminBackfillStreetIntelligence's already-reviewed pagination. `baseQuery`
// must already have its where()/orderBy() applied; this only adds
// limit()/startAfter(). The cursor is a document ID scoped to
// `collectionName` — passing a snapshot (not raw field values) to
// startAfter() lets Firestore resolve correct ordering even for
// orderBy(createdAt)/orderBy(expiresAt) queries, not just orderBy(__name__).
// A syntactically-valid but unknown/foreign cursor ID simply fails the
// `.exists` check below and the query starts from the beginning — it can
// never resolve to a document outside `collectionName` since the lookup
// itself is scoped to that collection.
function validatePagination(params, maxLimit) {
  if (params.cursor !== undefined && params.cursor !== null && typeof params.cursor !== 'string') {
    throw new HttpsError('invalid-argument', 'cursor must be a string or null.');
  }
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit <= 0 || params.limit > maxLimit)) {
    throw new HttpsError('invalid-argument', `limit must be an integer between 1 and ${maxLimit}.`);
  }
}

async function paginateQuery(db, collectionName, baseQuery, params, defaultLimit, maxLimit) {
  validatePagination(params, maxLimit);
  const pageLimit = Number.isInteger(params.limit) ? params.limit : defaultLimit;
  const cursorId = typeof params.cursor === 'string' && params.cursor ? params.cursor : null;

  let q = baseQuery.limit(pageLimit);
  if (cursorId) {
    const cSnap = await db.collection(collectionName).doc(cursorId).get();
    if (cSnap.exists) q = q.startAfter(cSnap);
  }
  const snap = await q.get();
  const done = snap.size < pageLimit;
  return { snap, nextCursor: done ? null : snap.docs[snap.docs.length - 1].id, done };
}

// F3: who/why/when of a suspension lives in the admin-only
// users/{uid}/private/moderation doc. Legacy users suspended before that
// move still carry the fields on the public doc, so fall back to them.
function pickSuspensionFields(data, mod) {
  const src = mod || data;
  return {
    suspendedAt: src.suspendedAt ?? null,
    suspendedBy: src.suspendedBy ?? null,
    suspensionReason: src.suspensionReason ?? null,
    unsuspendedAt: src.unsuspendedAt ?? null,
    unsuspendedBy: src.unsuspendedBy ?? null,
  };
}

function pickUserListFields(id, data, mod = null) {
  return {
    id,
    fullName: data.fullName ?? null,
    username: data.username ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    phoneNumber: data.phoneNumber ?? null,
    avatar: data.avatar ?? null,
    status: data.status ?? null,
    trustScore: data.trustScore ?? null,
    trustStats: data.trustStats ?? null,
    createdAt: data.createdAt ?? null,
    ...pickSuspensionFields(data, mod),
  };
}

// Minimal enrichment shape — matches the UserInfo interface already used by
// ReportsPage.tsx/PingsPage.tsx/AuditLogPage.tsx for reporter/reported/finder
// display, never the full user document.
function pickUserInfo(data) {
  return {
    fullName: data.fullName ?? null,
    username: data.username ?? null,
    email: data.email ?? null,
  };
}

async function enrichUsers(db, uidsIn) {
  const uids = [...new Set(uidsIn)].filter(Boolean).slice(0, ENRICH_UID_MAX);
  const snaps = await Promise.all(uids.map(uid => db.collection('users').doc(uid).get()));
  const map = {};
  snaps.forEach((snap, i) => {
    if (snap.exists) map[uids[i]] = pickUserInfo(snap.data());
  });
  return map;
}

// Merges standard (createdAt-ordered) and legacy (performedAt-ordered)
// adminAuditLog entries, deduplicated by doc id — matches the identical
// merge logic previously duplicated in UsersPage.tsx and AuditLogPage.tsx.
function mergeAuditEntries(newDocs, legacyDocs) {
  const newEntries = newDocs.map(d => ({ id: d.id, ...d.data() }));
  const seen = new Set(newEntries.map(e => e.id));
  const legacyEntries = legacyDocs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(e => !seen.has(e.id));
  const effectiveTs = (e) => (e.createdAt ?? e.performedAt)?.toMillis?.() ?? 0;
  return [...newEntries, ...legacyEntries].sort((a, b) => effectiveTs(b) - effectiveTs(a));
}

// ─── dashboardCounts — DashboardPage.tsx ───────────────────────────────────
async function dashboardCounts(db, _params, { Timestamp }) {
  const now = Timestamp.now();
  const [users, pings, sessions, failures, review, reportsPending, recentUsersSnap] = await Promise.allSettled([
    db.collection('users').count().get(),
    db.collection('spots').where('expiresAt', '>', now).count().get(),
    db.collection('parkingSessions').where('active', '==', true).count().get(),
    db.collection('parseFailures').where('resolvedAt', '==', null).count().get(),
    db.collection('streetSegments').where('status', '==', 'needs_review').count().get(),
    db.collection('reports').where('status', '==', 'pending').count().get(),
    db.collection('users').orderBy('createdAt', 'desc').limit(5).get(),
  ]);
  const c = (r) => (r.status === 'fulfilled' ? r.value.data().count : 0);
  return {
    totalUsers: c(users),
    activePings: c(pings),
    activeSessions: c(sessions),
    parseFailures: c(failures),
    needsReview: c(review),
    reports: c(reportsPending),
    recentUsers: recentUsersSnap.status === 'fulfilled'
      ? recentUsersSnap.value.docs.map(d => ({
          id: d.id,
          fullName: d.data().fullName ?? null,
          username: d.data().username ?? null,
          status: d.data().status ?? null,
          createdAt: d.data().createdAt ?? null,
        }))
      : [],
  };
}

// ─── usersList — UsersPage.tsx table ───────────────────────────────────────
// Cursor-paginated (client loops until done — see runFullList in
// services/adminReadService.ts — mirroring adminBackfillStreetIntelligence's
// established pattern) so a single call is always bounded regardless of
// total user count, while the client still assembles the same full list the
// page's existing client-side search/filter UX depends on.
async function usersList(db, params) {
  const { snap, nextCursor, done } = await paginateQuery(
    db, 'users', db.collection('users').orderBy('__name__'), params, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT,
  );
  const modSnaps = snap.empty
    ? []
    : await db.getAll(...snap.docs.map(d => d.ref.collection('private').doc('moderation')));
  const users = snap.docs.map((d, i) => pickUserListFields(
    d.id, d.data(), modSnaps[i] && modSnaps[i].exists ? modSnaps[i].data() : null,
  ));
  return { users, nextCursor, done };
}

// ─── userDetail — UsersPage.tsx UserDetailsModal ───────────────────────────
// Bundles the 7 sub-queries the modal used to fire individually. Partial
// failures are tolerated per-section (matching the original Promise.allSettled
// behavior + per-section ErrorNote in the client) but errors are sanitized —
// never a raw Admin SDK error string.
async function userDetail(db, params) {
  if (typeof params.uid !== 'string' || !params.uid) {
    throw new HttpsError('invalid-argument', 'uid is required.');
  }
  const uid = params.uid;

  const results = await Promise.allSettled([
    db.collection('users').doc(uid).collection('processedTrustEvents').orderBy('processedAt', 'desc').limit(20).get(),
    db.collection('parkingSessions').doc(uid).get(),
    db.collection('spots').where('finderId', '==', uid).orderBy('reportedAt', 'desc').limit(5).get(),
    db.collection('reports').where('reportedUserId', '==', uid).limit(20).get(),
    db.collection('reports').where('reporterId', '==', uid).limit(20).get(),
    db.collection('adminAuditLog').where('targetUserId', '==', uid).limit(20).get(),
    db.collection('adminAuditLog').where('finderId', '==', uid).limit(20).get(),
  ]);
  const [trustRes, sessionRes, pingsRes, againstRes, filedRes, auditNewRes, auditLegacyRes] = results;
  const errors = {};

  const trustEvents = trustRes.status === 'fulfilled'
    ? trustRes.value.docs.map(d => ({ id: d.id, ...d.data() }))
    : (errors.trust = true, []);

  const session = sessionRes.status === 'fulfilled'
    ? (sessionRes.value.exists ? sessionRes.value.data() : null)
    : (errors.session = true, null);

  const recentPings = pingsRes.status === 'fulfilled'
    ? pingsRes.value.docs.map(d => ({ id: d.id, ...d.data() }))
    : (errors.pings = true, []);

  const sortByCreatedDesc = (docs) => docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

  const reportsAgainst = againstRes.status === 'fulfilled'
    ? sortByCreatedDesc(againstRes.value.docs)
    : (errors.reportsAgainst = true, []);

  const reportsFiled = filedRes.status === 'fulfilled'
    ? sortByCreatedDesc(filedRes.value.docs)
    : (errors.reportsFiled = true, []);

  const auditEntries = mergeAuditEntries(
    auditNewRes.status === 'fulfilled' ? auditNewRes.value.docs : [],
    auditLegacyRes.status === 'fulfilled' ? auditLegacyRes.value.docs : [],
  );
  if (auditNewRes.status === 'rejected' || auditLegacyRes.status === 'rejected') errors.audit = true;

  return { trustEvents, session, recentPings, reportsAgainst, reportsFiled, auditEntries, errors };
}

// ─── reportsList — ReportsPage.tsx ─────────────────────────────────────────
// The pre-migration client query (orderBy('createdAt','desc'), optionally
// where('status','==',f)) had NO limit() at all — it fetched every matching
// report. A flat 500 cap would silently truncate results once a deployment
// accumulates more than 500 reports in a status bucket. Cursor-paginated
// instead (same technique as usersList) so the client can reconstruct the
// exact old "all matching reports" result via ReportsPage's fetchReportsList
// loop, with no per-request unbounded scan on the server.
const REPORT_STATUSES = new Set(['pending', 'reviewed', 'dismissed', 'all']);
async function reportsList(db, params) {
  if (typeof params.status !== 'string' || !REPORT_STATUSES.has(params.status)) {
    throw new HttpsError('invalid-argument', "status must be one of pending/reviewed/dismissed/all.");
  }
  const baseQuery = params.status === 'all'
    ? db.collection('reports').orderBy('createdAt', 'desc')
    : db.collection('reports').where('status', '==', params.status).orderBy('createdAt', 'desc');
  const { snap, nextCursor, done } = await paginateQuery(db, 'reports', baseQuery, params, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const userMap = await enrichUsers(db, reports.flatMap(r => [r.reporterId, r.reportedUserId]));
  return { reports, userMap, nextCursor, done };
}

// ─── auditLogList — AuditLogPage.tsx ───────────────────────────────────────
async function auditLogList(db) {
  const [newSnap, legacySnap] = await Promise.allSettled([
    db.collection('adminAuditLog').orderBy('createdAt', 'desc').limit(80).get(),
    db.collection('adminAuditLog').orderBy('performedAt', 'desc').limit(20).get(),
  ]);
  const entries = mergeAuditEntries(
    newSnap.status === 'fulfilled' ? newSnap.value.docs : [],
    legacySnap.status === 'fulfilled' ? legacySnap.value.docs : [],
  );
  return { entries };
}

// ─── pingsList — PingsPage.tsx ─────────────────────────────────────────────
// The pre-migration client had two shapes: 'all' explicitly capped at
// limit(100) (preserved exactly below — parity, not a regression), while
// 'active'/'claimed'/'recent' had NO limit() at all. Those three are now
// cursor-paginated (same technique as usersList/reportsList) instead of a
// flat cap, so a busy period with >500 concurrently active pings cannot
// silently lose results — PingsPage's fetchPingsList loops pages to
// reconstruct the same complete result set the old unbounded query returned.
const PING_FILTERS = new Set(['active', 'claimed', 'recent', 'all']);
async function pingsList(db, params, { Timestamp }) {
  if (typeof params.filter !== 'string' || !PING_FILTERS.has(params.filter)) {
    throw new HttpsError('invalid-argument', 'filter must be one of active/claimed/recent/all.');
  }

  if (params.filter === 'all') {
    // Fixed single bounded page (matches the original client's own
    // limit(100) exactly) — cursor/limit are simply not meaningful here and
    // are ignored, consistent with every other fixed-shape view.
    const snap = await db.collection('spots').orderBy('reportedAt', 'desc').limit(100).get();
    const pings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const userMap = await enrichUsers(db, pings.map(p => p.finderId));
    return { pings, userMap, nextCursor: null, done: true };
  }

  const now = Timestamp.now();
  const yesterday = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
  const baseQuery = params.filter === 'recent'
    ? db.collection('spots').where('reportedAt', '>', yesterday).orderBy('reportedAt', 'desc')
    : db.collection('spots').where('expiresAt', '>', now).orderBy('expiresAt', 'asc');

  const { snap, nextCursor, done } = await paginateQuery(db, 'spots', baseQuery, params, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  let pings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (params.filter === 'claimed') {
    pings = pings.filter(p => p.status === 'interested' || p.status === 'occupied');
  }
  const userMap = await enrichUsers(db, pings.map(p => p.finderId));
  return { pings, userMap, nextCursor, done };
}

// ─── parseFailuresList — ParseFailuresPage.tsx ─────────────────────────────
async function parseFailuresList(db) {
  const snap = await db.collection('parseFailures').orderBy('count', 'desc').limit(100).get();
  return { failures: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
}

const ADMIN_READ_VIEWS = {
  dashboardCounts,
  usersList,
  userDetail,
  reportsList,
  auditLogList,
  pingsList,
  parseFailuresList,
};

module.exports = { ADMIN_READ_VIEWS };
