import React, { useState, useEffect } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { fetchParseFailuresList } from '../../utils/adminReadService';
import { AlertCircle, CheckCircle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { InlineLoader } from '../../components/LoadingScreen';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParseFailure {
  id: string;
  rawSignText: string;
  parserVersion: string;
  count: number;
  firstSeenAt: any;
  lastSeenAt: any;
  lat?: number;
  lng?: number;
  resolvedAt: any | null;
  resolvedBy?: string;
  resolutionNote?: string;
  resolutionType?: 'fixed' | 'expected_ignore';
}

type FilterMode = 'unresolved' | 'resolved' | 'ignored' | 'all';
type SortMode = 'frequent' | 'recent';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ponytail: inline from sweepnyc.ts — avoids exporting an internal function
function boroughFromCoords(lat?: number, lng?: number): string | null {
  if (lat == null || lng == null) return null;
  if (lat > 40.785 && lng > -73.935) return 'Bronx';
  if (lng < -74.03) return 'Staten Island';
  if (lat < 40.648) return 'Brooklyn';
  if (lng > -73.948 && lat < 40.775) return 'Queens';
  return 'Manhattan';
}

function formatTs(ts: any): string {
  if (!ts) return '—';
  const d: Date = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function CountBadge({ count }: { count: number }) {
  const cls =
    count >= 10 ? 'bg-red-100 text-red-700' :
    count >= 5  ? 'bg-yellow-100 text-yellow-700' :
                  'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${cls}`}>
      ×{count}
    </span>
  );
}

// ─── Resolve Form ─────────────────────────────────────────────────────────────

interface ResolveFormProps {
  type: 'fixed' | 'expected_ignore';
  onConfirm: (note: string) => void;
  onCancel: () => void;
  saving: boolean;
}

function ResolveForm({ type, onConfirm, onCancel, saving }: ResolveFormProps) {
  const [note, setNote] = useState('');
  const label = type === 'fixed' ? 'Mark Resolved' : 'Mark as Expected/Ignored';
  const placeholder = type === 'fixed'
    ? 'Optional: what was fixed? (e.g. parser updated for this format)'
    : 'Optional: why is this intentionally ignored? (e.g. No Standing signs — not street cleaning)';

  return (
    <div className="mt-3 bg-gray-50 rounded-lg p-3 border border-gray-200">
      <p className="text-xs font-semibold text-gray-600 mb-2">{label}</p>
      <textarea
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder={placeholder}
        rows={2}
        className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 text-gray-800 bg-white resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
      />
      <div className="flex gap-2">
        <button
          onClick={() => onConfirm(note)}
          disabled={saving}
          className="px-3 py-1.5 text-xs font-semibold rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : 'Confirm'}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-3 py-1.5 text-xs font-semibold rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Failure Row ──────────────────────────────────────────────────────────────

function FailureRow({ failure, onUpdated }: { failure: ParseFailure; onUpdated: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [resolveType, setResolveType] = useState<'fixed' | 'expected_ignore' | null>(null);
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const borough = boroughFromCoords(failure.lat, failure.lng);
  const isResolved = failure.resolvedAt != null;
  const isIgnored = failure.resolutionType === 'expected_ignore';

  const handleResolve = async (type: 'fixed' | 'expected_ignore', note: string) => {
    setSaving(true);
    setRowError(null);
    try {
      const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'adminResolveParseFailure');
      await fn({ failureId: failure.id, resolutionType: type, resolutionNote: note.trim() || null });
      setResolveType(null);
      onUpdated();
    } catch (e: unknown) {
      setRowError(e instanceof Error ? e.message : 'Failed to resolve. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleReopen = async () => {
    setSaving(true);
    setRowError(null);
    try {
      const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'adminReopenParseFailure');
      await fn({ failureId: failure.id });
      onUpdated();
    } catch (e: unknown) {
      setRowError(e instanceof Error ? e.message : 'Failed to reopen. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`border rounded-xl mb-2 overflow-hidden ${isResolved ? 'border-gray-200 bg-gray-50' : 'border-gray-300 bg-white'}`}>
      {/* Header row */}
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="mt-0.5 shrink-0">
          {isResolved
            ? <CheckCircle size={15} className={isIgnored ? 'text-gray-400' : 'text-green-500'} />
            : <AlertCircle size={15} className="text-[var(--color-danger)]" />}
        </div>

        <div className="flex-1 min-w-0">
          {/* Sign text — truncated by default */}
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-left w-full"
          >
            <p className={`text-sm font-mono leading-snug break-all ${isResolved ? 'text-gray-500' : 'text-gray-800'} ${expanded ? '' : 'line-clamp-2'}`}>
              {failure.rawSignText}
            </p>
          </button>

          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <CountBadge count={failure.count} />
            <span className="text-xs text-gray-400">v{failure.parserVersion}</span>
            {borough && <span className="text-xs text-gray-400">{borough}</span>}
            <span className="text-xs text-gray-400">
              First: {formatTs(failure.firstSeenAt)}
            </span>
            <span className="text-xs text-gray-400">
              Last: {formatTs(failure.lastSeenAt)}
            </span>
            {isResolved && (
              <span className={`text-xs font-medium ${isIgnored ? 'text-gray-400' : 'text-green-600'}`}>
                {isIgnored ? 'Ignored' : 'Resolved'} {formatTs(failure.resolvedAt)}
              </span>
            )}
          </div>

          {/* Resolution note */}
          {isResolved && failure.resolutionNote && (
            <p className="text-xs text-gray-500 mt-1 italic">"{failure.resolutionNote}"</p>
          )}
        </div>

        {/* Expand toggle */}
        <button onClick={() => setExpanded(e => !e)} className="shrink-0 text-gray-300 hover:text-gray-500 mt-0.5">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Expanded: actions */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-100">
          {resolveType ? (
            <ResolveForm
              type={resolveType}
              onConfirm={note => handleResolve(resolveType, note)}
              onCancel={() => setResolveType(null)}
              saving={saving}
            />
          ) : (
            <div className="flex flex-wrap gap-2 mt-3">
              {!isResolved && (
                <>
                  <button
                    onClick={() => setResolveType('fixed')}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors"
                  >
                    Mark Resolved
                  </button>
                  <button
                    onClick={() => setResolveType('expected_ignore')}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    Mark as Expected / Ignore
                  </button>
                </>
              )}
              {isResolved && (
                <button
                  onClick={handleReopen}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                >
                  <RefreshCw size={12} />
                  Reopen
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {rowError && (
        <div className="px-4 py-2 bg-red-50 border-t border-red-200 text-xs text-red-600 flex items-center gap-2">
          <AlertCircle size={12} />
          {rowError}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function ParseFailuresPage() {
  const [failures, setFailures] = useState<ParseFailure[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('unresolved');
  const [sort, setSort] = useState<SortMode>('frequent');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchParseFailuresList();
      setFailures(data.failures as ParseFailure[]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load parse failures.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Filter client-side — dataset is small (hundreds at most)
  const filtered = failures.filter(f => {
    if (filter === 'unresolved') return f.resolvedAt == null;
    if (filter === 'resolved') return f.resolvedAt != null && f.resolutionType !== 'expected_ignore';
    if (filter === 'ignored') return f.resolutionType === 'expected_ignore';
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'frequent') return (b.count ?? 0) - (a.count ?? 0);
    // recent: sort by lastSeenAt descending
    const ta = a.lastSeenAt?.toDate?.()?.getTime?.() ?? 0;
    const tb = b.lastSeenAt?.toDate?.()?.getTime?.() ?? 0;
    return tb - ta;
  });

  const unresolvedCount = failures.filter(f => f.resolvedAt == null).length;

  const FILTERS: { key: FilterMode; label: string }[] = [
    { key: 'unresolved', label: `Unresolved${unresolvedCount ? ` (${unresolvedCount})` : ''}` },
    { key: 'resolved', label: 'Resolved' },
    { key: 'ignored', label: 'Ignored' },
    { key: 'all', label: 'All' },
  ];

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <p className="w-full text-xs text-gray-400">Showing top 100 parse failures by frequency. Older or rare failures may not appear.</p>
        {/* Filter pills */}
        <div className="flex gap-1.5">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-full transition-colors ${
                filter === f.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Sort + refresh */}
        <div className="flex items-center gap-2">
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortMode)}
            className="text-xs border border-gray-200 rounded px-2 py-1.5 text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="frequent">Most Frequent</option>
            <option value="recent">Most Recent</option>
          </select>
          <button
            onClick={load}
            disabled={loading}
            className="p-1.5 text-gray-400 hover:text-gray-600 disabled:opacity-50 transition-colors"
            title="Refresh"
          >
            {loading ? <InlineLoader size={14} /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500 mb-4">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-red-200" /> ×10+ high frequency
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-yellow-200" /> ×5–9 medium
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-gray-200" /> ×1–4 low
        </span>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      {/* List */}
      {loading ? (
        <p className="text-sm text-gray-400">Loading failures…</p>
      ) : error ? null : sorted.length === 0 ? (
        <div className="text-center py-10 text-gray-400">
          <CheckCircle size={28} className="mx-auto mb-2 text-[var(--color-success)]" />
          <p className="text-sm font-medium">
            {filter === 'unresolved' ? 'No unresolved parse failures.' : 'Nothing here.'}
          </p>
        </div>
      ) : (
        <div>
          <p className="text-xs text-gray-400 mb-3">{sorted.length} result{sorted.length !== 1 ? 's' : ''}</p>
          {sorted.map(f => (
            <FailureRow key={f.id} failure={f} onUpdated={load} />
          ))}
        </div>
      )}
    </div>
  );
}
