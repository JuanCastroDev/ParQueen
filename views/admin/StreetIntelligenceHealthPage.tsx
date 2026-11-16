import React, { useState, useCallback } from 'react';
import { db } from '../../firebase';
import {
  collection, collectionGroup, getDocs, getCountFromServer,
  query, where,
} from 'firebase/firestore';
import { fetchDashboardCounts } from '../../utils/adminReadService';
import { segmentAllowsAuthoritativeRead } from '../../utils/canonicalCurbWriteAuthority';
import { RefreshCw, AlertCircle, CheckCircle, AlertTriangle } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HealthStats {
  totalSegments: number;
  activeSegments: number;
  sweepnycSegments: number;
  adminSegments: number;
  archivedSegments: number;
  needsReviewSegments: number;
  activeRules: number;
  unresolvedFailures: number;
}

interface BoroughRow {
  code: string;
  label: string;
  segments: number;
}

interface QualityCheck {
  label: string;
  count: number;
  severity: 'ok' | 'warn' | 'error';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BOROUGH_LABELS: Record<string, string> = {
  BX: 'Bronx', MN: 'Manhattan', BK: 'Brooklyn', QN: 'Queens', SI: 'Staten Island',
};
const BOROUGH_ORDER = ['BX', 'MN', 'BK', 'QN', 'SI'];

async function loadStats(): Promise<{
  stats: HealthStats;
  boroughRows: BoroughRow[];
  qualityChecks: QualityCheck[];
}> {
  // Fire all count queries + full segment load in parallel. streetSegments
  // reads are public (allow read: if true), so they stay direct client
  // queries. parseFailures is admin-only and no longer directly client
  // readable (see firestore.rules) — its unresolved count now comes from
  // the requireCurrentAdmin-gated adminReadView('dashboardCounts') callable,
  // which already computes this same aggregate for DashboardPage.tsx.
  const [
    totalSnap, activeSnap, sweepnycSnap, adminSnap,
    archivedSnap, reviewSnap, rulesSnap, dashboardCounts,
    segmentDocs,
  ] = await Promise.all([
    getCountFromServer(collection(db!, 'streetSegments')),
    getCountFromServer(query(collection(db!, 'streetSegments'), where('status', '==', 'active'))),
    getCountFromServer(query(collection(db!, 'streetSegments'), where('source', '==', 'sweepnyc'))),
    getCountFromServer(query(collection(db!, 'streetSegments'), where('source', '==', 'admin'))),
    getCountFromServer(query(collection(db!, 'streetSegments'), where('status', '==', 'archived'))),
    getCountFromServer(query(collection(db!, 'streetSegments'), where('status', '==', 'needs_review'))),
    // Collection group count: all active (not superseded) rules across all segments
    getCountFromServer(query(collectionGroup(db!, 'streetRules'), where('supersededAt', '==', null))),
    fetchDashboardCounts(),
    getDocs(collection(db!, 'streetSegments')),
  ]);
  const allSegmentDocs = [...segmentDocs.docs];

  const stats: HealthStats = {
    totalSegments: totalSnap.data().count,
    activeSegments: activeSnap.data().count,
    sweepnycSegments: sweepnycSnap.data().count,
    adminSegments: adminSnap.data().count,
    archivedSegments: archivedSnap.data().count,
    needsReviewSegments: reviewSnap.data().count,
    activeRules: rulesSnap.data().count,
    unresolvedFailures: dashboardCounts.parseFailures,
  };

  // Borough breakdown from loaded docs
  const boroughCounts: Record<string, number> = {};
  let unknownCount = 0;

  for (const d of allSegmentDocs) {
    const borough = d.data().borough as string | undefined;
    if (borough && BOROUGH_ORDER.includes(borough)) {
      boroughCounts[borough] = (boroughCounts[borough] ?? 0) + 1;
    } else {
      unknownCount++;
    }
  }

  const boroughRows: BoroughRow[] = BOROUGH_ORDER.map(code => ({
    code,
    label: BOROUGH_LABELS[code],
    segments: boroughCounts[code] ?? 0,
  }));
  if (unknownCount > 0) {
    boroughRows.push({ code: '—', label: 'Unknown / Missing', segments: unknownCount });
  }

  // Data quality checks from loaded docs
  let missingStatus = 0, missingSource = 0, missingScore = 0, missingProvenance = 0;
  for (const d of allSegmentDocs) {
    const data = d.data();
    if (data.status == null) missingStatus++;
    if (data.source == null) missingSource++;
    if (data.confidenceScore == null) missingScore++;
    if (data.provenance == null) missingProvenance++;
  }

  const qualityChecks: QualityCheck[] = [
    {
      label: 'Segments missing status',
      count: missingStatus,
      severity: missingStatus > 0 ? 'warn' : 'ok',
    },
    {
      label: 'Segments missing source',
      count: missingSource,
      severity: missingSource > 0 ? 'warn' : 'ok',
    },
    {
      label: 'Segments missing confidenceScore',
      count: missingScore,
      severity: missingScore > 0 ? 'warn' : 'ok',
    },
    {
      label: 'Segments missing provenance',
      count: missingProvenance,
      severity: missingProvenance > 0 ? 'warn' : 'ok',
    },
    {
      label: 'Segments needing review',
      count: stats.needsReviewSegments,
      severity: stats.needsReviewSegments > 0 ? 'warn' : 'ok',
    },
    {
      label: 'Archived segments',
      count: stats.archivedSegments,
      severity: 'ok', // informational only
    },
    {
      label: 'Unresolved parse failures',
      count: stats.unresolvedFailures,
      severity: stats.unresolvedFailures >= 10 ? 'error' : stats.unresolvedFailures > 0 ? 'warn' : 'ok',
    },
  ];

  return { stats, boroughRows, qualityChecks };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  label, value, warn = false, error = false,
}: {
  label: string;
  value: number | null;
  warn?: boolean;
  error?: boolean;
}) {
  const border = error
    ? 'border-red-300 bg-red-50'
    : warn
    ? 'border-yellow-300 bg-yellow-50'
    : 'border-gray-200 bg-white';
  const valueColor = error
    ? 'text-red-700'
    : warn
    ? 'text-yellow-700'
    : 'text-gray-900';

  return (
    <div className={`border rounded-xl p-4 ${border}`}>
      <p className="text-xs font-semibold text-gray-500 mb-1 leading-tight">{label}</p>
      <p className={`text-2xl font-bold ${valueColor}`}>
        {value === null ? <span className="text-gray-300">—</span> : value.toLocaleString()}
      </p>
    </div>
  );
}

function QualityRow({ check }: { check: QualityCheck }) {
  const icon =
    check.severity === 'error' ? <AlertCircle size={14} className="text-red-500 shrink-0" /> :
    check.severity === 'warn'  ? <AlertTriangle size={14} className="text-yellow-500 shrink-0" /> :
                                 <CheckCircle size={14} className="text-green-500 shrink-0" />;

  const countColor =
    check.severity === 'error' ? 'text-red-600 font-bold' :
    check.severity === 'warn'  ? 'text-yellow-600 font-semibold' :
                                 'text-gray-500';

  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-sm text-gray-700">{check.label}</span>
      </div>
      <span className={`text-sm tabular-nums ${countColor}`}>
        {check.count === 0 ? <span className="text-gray-400">0</span> : check.count}
      </span>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function StreetIntelligenceHealthPage() {
  const [stats, setStats] = useState<HealthStats | null>(null);
  const [boroughRows, setBoroughRows] = useState<BoroughRow[]>([]);
  const [qualityChecks, setQualityChecks] = useState<QualityCheck[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loadStats();
      setStats(result.stats);
      setBoroughRows(result.boroughRows);
      setQualityChecks(result.qualityChecks);
      setLastLoaded(new Date());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load health data.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on first render
  React.useEffect(() => { load(); }, [load]);

  const hasWarnings = stats && (
    stats.needsReviewSegments > 0 ||
    stats.unresolvedFailures > 0 ||
    qualityChecks.some(c => c.severity !== 'ok')
  );

  return (
    <div>
      {/* Header row */}
      <div className="flex items-center justify-between mb-5">
        <div>
          {lastLoaded && (
            <p className="text-xs text-gray-400">
              Last loaded {lastLoaded.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </p>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-600 text-sm mb-5 p-3 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle size={15} />
          {error}
        </div>
      )}

      {/* ── Stat Cards ── */}
      <section className="mb-7">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Segments</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <StatCard label="Total Segments" value={stats?.totalSegments ?? null} />
          <StatCard label="Active" value={stats?.activeSegments ?? null} />
          <StatCard label="SweepNYC" value={stats?.sweepnycSegments ?? null} />
          <StatCard label="Admin-Created" value={stats?.adminSegments ?? null} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label="Archived"
            value={stats?.archivedSegments ?? null}
          />
          <StatCard
            label="Needs Review"
            value={stats?.needsReviewSegments ?? null}
            warn={(stats?.needsReviewSegments ?? 0) > 0}
          />
          <StatCard label="Active Rules" value={stats?.activeRules ?? null} />
          <StatCard
            label="Unresolved Parse Failures"
            value={stats?.unresolvedFailures ?? null}
            warn={(stats?.unresolvedFailures ?? 0) > 0 && (stats?.unresolvedFailures ?? 0) < 10}
            error={(stats?.unresolvedFailures ?? 0) >= 10}
          />
        </div>
      </section>

      {/* ── Borough Breakdown ── */}
      <section className="mb-7">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Borough Breakdown</p>
        {loading && !boroughRows.length ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Borough</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Segments</th>
                </tr>
              </thead>
              <tbody>
                {boroughRows.map(row => (
                  <tr key={row.code} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="font-semibold text-gray-700">{row.label}</span>
                      <span className="ml-1.5 text-xs text-gray-400">{row.code}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-700 font-medium">
                      {row.segments}
                    </td>
                  </tr>
                ))}
                {boroughRows.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-4 py-4 text-center text-sm text-gray-400">No data</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Data Quality Checks ── */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">Data Quality Checks</p>
          {hasWarnings && (
            <span className="text-xs font-semibold text-yellow-600 bg-yellow-50 border border-yellow-200 px-2 py-0.5 rounded-full">
              Attention needed
            </span>
          )}
        </div>
        {loading && !qualityChecks.length ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <div className="border border-gray-200 rounded-xl px-4 py-1 bg-white">
            {qualityChecks.map(c => (
              <QualityRow key={c.label} check={c} />
            ))}
          </div>
        )}
        {qualityChecks.some(c => c.label.startsWith('Segments missing') && c.count > 0) && (
          <p className="text-xs text-gray-400 mt-2">
            Run the schema backfill from the Segments tab → Data Maintenance to resolve missing fields.
          </p>
        )}
      </section>
    </div>
  );
}
