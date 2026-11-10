import React, { useState, useEffect } from 'react';
import { filterAuthoritativeRules } from '../../utils/canonicalCurbWriteAuthority';
import { db } from '../../firebase';
import {
  collection, getDocs, query, orderBy, where,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { MapPin, Plus, Trash2, ChevronDown, ChevronUp, AlertCircle, CheckCircle, Wrench, Flag, RotateCcw } from 'lucide-react';
import { ParseFailuresPage } from './ParseFailuresPage';
import { StreetIntelligenceHealthPage } from './StreetIntelligenceHealthPage';
import {
  geocodeAddress, fetchStreetGeometry, computeGeohash, computeCrossRaw,
  SegmentDoc, SuspensionDoc, StreetRuleDoc,
} from '../../utils/streetIntelligence';

const BOROUGHS = [
  { code: 'MN', label: 'Manhattan' },
  { code: 'BK', label: 'Brooklyn' },
  { code: 'QN', label: 'Queens' },
  { code: 'BX', label: 'Bronx' },
  { code: 'SI', label: 'Staten Island' },
];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ── Add Segment Form ──────────────────────────────────────────────────────────

function AddSegmentForm({ onSaved }: { onSaved: () => void }) {
  const [streetName, setStreetName] = useState('');
  const [referenceAddress, setReferenceAddress] = useState('');
  const [borough, setBorough] = useState('BX');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!streetName.trim() || !referenceAddress.trim()) {
      setError('All fields are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // 1. Geocode the reference address to find the block
      const center = await geocodeAddress(referenceAddress.trim(), borough);
      if (!center) {
        setError('Could not find that address. Check and try again.');
        setSaving(false);
        return;
      }

      // 2. Fetch OSM street geometry near the address
      const geo = await fetchStreetGeometry(streetName.trim(), center.lat, center.lng);
      if (!geo) {
        setError('Could not find street geometry. Check the street name spelling.');
        setSaving(false);
        return;
      }

      // 3. Determine which side is the even-address side using the house number
      const houseMatch = referenceAddress.trim().match(/^(\d+)/);
      const houseNum = houseMatch ? parseInt(houseMatch[1]) : null;
      const cross = computeCrossRaw(center.lat, center.lng, geo.fromLat, geo.fromLng, geo.toLat, geo.toLng);
      const isEven = houseNum !== null ? houseNum % 2 === 0 : true;
      const evenSideIsPositiveCross = isEven ? cross > 0 : cross < 0;

      const centerLat = (geo.fromLat + geo.toLat) / 2;
      const centerLng = (geo.fromLng + geo.toLng) / 2;
      const geohash = computeGeohash(centerLat, centerLng);

      const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'adminAddSegment');
      await fn({
        cityId: 'nyc',
        streetName: streetName.trim(),
        referenceAddress: referenceAddress.trim(),
        fromCross: '',
        toCross: '',
        borough,
        fromLat: geo.fromLat,
        fromLng: geo.fromLng,
        toLat: geo.toLat,
        toLng: geo.toLng,
        centerLat,
        centerLng,
        bearing: geo.bearing,
        geohash,
        evenSideIsPositiveCross,
      });

      setStreetName('');
      setReferenceAddress('');
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
      <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">Add Street Segment</h3>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="col-span-2">
          <label className="text-xs font-semibold text-gray-500 mb-1 block">Street Name</label>
          <input
            value={streetName}
            onChange={e => setStreetName(e.target.value)}
            placeholder="Melville Street"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="col-span-2">
          <label className="text-xs font-semibold text-gray-500 mb-1 block">
            Reference Address <span className="font-normal text-gray-400">— any address on this block (used to identify even vs. odd side)</span>
          </label>
          <input
            value={referenceAddress}
            onChange={e => setReferenceAddress(e.target.value)}
            placeholder="1716 Melville Street"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-gray-500 mb-1 block">Borough</label>
          <select
            value={borough}
            onChange={e => setBorough(e.target.value)}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {BOROUGHS.map(b => <option key={b.code} value={b.code}>{b.label}</option>)}
          </select>
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-2 text-red-600 text-sm mb-3">
          <AlertCircle size={14} />
          {error}
        </div>
      )}
      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {saving ? 'Looking up street…' : 'Add Segment'}
      </button>
    </div>
  );
}

// ── Cleaning Rule Form ────────────────────────────────────────────────────────

function AddRuleForm({ segmentId, onSaved }: { segmentId: string; onSaved: () => void }) {
  const [side, setSide] = useState<'even' | 'odd'>('even');
  const [days, setDays] = useState<string[]>([]);
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('11:00');
  const [saving, setSaving] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);

  const toggleDay = (d: string) => {
    setDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);
  };

  const handleSave = async () => {
    if (!days.length) return;
    setSaving(true);
    setRuleError(null);
    try {
      const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'adminAddCleaningRule');
      await fn({ segmentId, side, days, startTime, endTime });
      setDays([]);
      onSaved();
    } catch (e: unknown) {
      setRuleError(e instanceof Error ? e.message : 'Failed to save rule.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-50 rounded-lg p-4 mt-3">
      <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Add Cleaning Rule</p>
      <div className="flex flex-wrap gap-3 mb-3">
        <div>
          <label className="text-xs text-gray-500 mb-1 block">Side</label>
          <select value={side} onChange={e => setSide(e.target.value as 'even' | 'odd')} className="px-2 py-1 border border-gray-200 rounded text-sm text-gray-900 bg-white">
            <option value="even">Even addresses</option>
            <option value="odd">Odd addresses</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">Start</label>
          <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="px-2 py-1 border border-gray-200 rounded text-sm text-gray-900 bg-white" />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">End</label>
          <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} className="px-2 py-1 border border-gray-200 rounded text-sm text-gray-900 bg-white" />
        </div>
      </div>
      <div className="flex flex-wrap gap-1 mb-3">
        {DAYS.map(d => (
          <button
            key={d}
            onClick={() => toggleDay(d)}
            className={`px-2 py-1 text-xs font-semibold rounded transition-colors ${days.includes(d) ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}`}
          >
            {d}
          </button>
        ))}
      </div>
      <button
        onClick={handleSave}
        disabled={saving || !days.length}
        className="px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {saving ? 'Saving…' : 'Save Rule'}
      </button>
      {ruleError && (
        <div className="mt-2 flex items-center gap-1.5 text-red-600 text-xs">
          <AlertCircle size={11} />
          {ruleError}
        </div>
      )}
    </div>
  );
}

// ── Segment Row ───────────────────────────────────────────────────────────────

function SegmentRow({ seg, onDeleted }: { seg: SegmentDoc; onDeleted: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [rules, setRules] = useState<StreetRuleDoc[]>([]);
  const [loadingRules, setLoadingRules] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [segError, setSegError] = useState<string | null>(null);

  const loadRules = async () => {
    setLoadingRules(true);
    const snap = await getDocs(
      query(collection(db, 'streetSegments', seg.id, 'streetRules'), where('supersededAt', '==', null))
    );
    const loaded = snap.docs.map(d => ({ id: d.id, ...d.data() } as StreetRuleDoc));
    const selected = filterAuthoritativeRules(seg, loaded);
    setRules(selected.ok ? selected.rules : []);
    setLoadingRules(false);
  };

  const handleExpand = () => {
    if (!expanded) loadRules();
    setExpanded(e => !e);
  };

  const supersedRule = async (ruleId: string) => {
    try {
      const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'adminSupersedeRule');
      await fn({ segmentId: seg.id, ruleId });
      loadRules();
    } catch (e: unknown) {
      setSegError(e instanceof Error ? e.message : 'Failed to remove rule.');
    }
  };

  const callSegmentStatus = async (status: 'archived' | 'needs_review' | 'active', reason?: string) => {
    setDeleting(true);
    setSegError(null);
    try {
      const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'adminUpdateSegmentStatus');
      await fn({ segmentId: seg.id, status, reason: reason ?? null });
      onDeleted();
    } catch (e: unknown) {
      setSegError(e instanceof Error ? e.message : 'Action failed.');
      setDeleting(false);
    }
  };

  const archiveSegment = async () => {
    if (!confirm(`Archive segment "${seg.streetName}"? It will no longer be served to users but can be restored.`)) return;
    await callSegmentStatus('archived', 'Archived from admin dashboard');
  };

  const markNeedsReview = () => callSegmentStatus('needs_review', 'Marked needs review from admin dashboard');
  const markActive       = () => callSegmentStatus('active',       'Restored active from admin dashboard');

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden mb-3">
      <div className="flex items-center justify-between px-4 py-3 bg-white">
        <div>
          <p className="font-semibold text-gray-800 text-sm">{seg.streetName}</p>
          <p className="text-xs text-gray-500">{seg.referenceAddress || seg.fromCross} · {BOROUGHS.find(b => b.code === seg.borough)?.label}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            seg.status === 'archived' ? 'bg-gray-100 text-gray-500' :
            seg.status === 'needs_review' ? 'bg-yellow-100 text-yellow-700' :
            seg.source === 'sweepnyc' ? 'bg-purple-100 text-purple-700' :
            'bg-green-100 text-green-700'
          }`}>
            {seg.status === 'archived' ? 'Archived' :
             seg.status === 'needs_review' ? 'Needs Review' :
             seg.source === 'sweepnyc' ? 'SweepNYC' :
             'ParQueen Verified'}
          </span>
          {seg.status === 'active' && (
            <button onClick={markNeedsReview} className="p-1 text-[var(--color-warning)] hover:text-amber-600" title="Flag for review">
              <Flag size={15} />
            </button>
          )}
          {(seg.status === 'needs_review' || seg.status === 'archived') && (
            <button onClick={markActive} className="p-1 text-[var(--color-success)] hover:text-green-600" title="Restore as active">
              <RotateCcw size={15} />
            </button>
          )}
          <button onClick={handleExpand} className="p-1 text-gray-400 hover:text-gray-600">
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {seg.status !== 'archived' && (
            <button onClick={archiveSegment} disabled={deleting} className="p-1 text-[var(--color-danger)] hover:text-red-600 disabled:opacity-50" title="Archive segment (keeps history)">
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 bg-gray-50 border-t border-gray-100">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mt-3 mb-2">Cleaning Rules</p>
          {loadingRules ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : rules.length === 0 ? (
            <p className="text-xs text-gray-400">No rules yet.</p>
          ) : (
            <div className="space-y-2">
              {rules.map(rule => (
                rule.schedules.map((sched, i) => (
                  <div key={`${rule.id}-${i}`} className="flex items-center justify-between bg-white px-3 py-2 rounded-lg border border-gray-200 text-xs">
                    <span className="font-semibold text-gray-700">Side {sched.side}</span>
                    <span className="text-gray-500">{sched.days.join(' & ')}</span>
                    <span className="text-gray-500">{sched.startTime}–{sched.endTime}</span>
                    <button onClick={() => supersedRule(rule.id)} className="text-[var(--color-danger)] hover:text-red-600" title="Remove rule (supersedes, keeps history)">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))
              ))}
            </div>
          )}
          <AddRuleForm segmentId={seg.id} onSaved={loadRules} />
        </div>
      )}
      {segError && (
        <div className="px-4 py-2 bg-red-50 border-t border-red-200 text-xs text-red-600 flex items-center gap-2">
          <AlertCircle size={12} />
          {segError}
        </div>
      )}
    </div>
  );
}

// ── Suspensions Panel ─────────────────────────────────────────────────────────

function SuspensionsPanel() {
  const [suspensions, setSuspensions] = useState<SuspensionDoc[]>([]);
  const [date, setDate] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<'holiday' | 'emergency'>('holiday');
  const [saving, setSaving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const load = async () => {
    const snap = await getDocs(query(collection(db, 'suspensions'), orderBy('date', 'desc')));
    setSuspensions(snap.docs.map(d => ({ id: d.id, ...d.data() } as SuspensionDoc)));
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async () => {
    if (!date || !label) return;
    setSaving(true);
    setArchiveError(null);
    try {
      const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'adminAddSuspension');
      await fn({ date, label: label.trim(), type });
      setDate('');
      setLabel('');
      load();
    } catch (e: unknown) {
      setArchiveError(e instanceof Error ? e.message : 'Failed to add suspension.');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (id: string) => {
    setArchiveError(null);
    try {
      const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'adminArchiveSuspension');
      await fn({ suspensionId: id, reason: 'Archived from admin dashboard' });
      load();
    } catch (e: unknown) {
      setArchiveError(e instanceof Error ? e.message : 'Archive failed.');
    }
  };

  return (
    <div className="mt-8">
      <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">ASP Suspensions</h3>
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4">
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">Label</label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Martin Luther King Jr. Day" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">Type</label>
            <select value={type} onChange={e => setType(e.target.value as 'holiday' | 'emergency')} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
              <option value="holiday">Holiday</option>
              <option value="emergency">Emergency</option>
            </select>
          </div>
        </div>
        <button onClick={handleAdd} disabled={saving || !date || !label} className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
          {saving ? 'Saving…' : 'Add Suspension'}
        </button>
      </div>
      {archiveError && (
        <div className="mb-2 flex items-center gap-2 text-red-600 text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle size={12} />
          {archiveError}
        </div>
      )}
      <div className="space-y-2">
        {suspensions.filter(s => s.status !== 'archived').map(s => (
          <div key={s.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-gray-800">{s.label}</p>
              <p className="text-xs text-gray-500">{s.date} · {s.type}</p>
            </div>
            <button onClick={() => handleArchive(s.id)} className="text-[var(--color-danger)] hover:text-red-600" title="Remove suspension (archived, not deleted)">
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        {!suspensions.filter(s => s.status !== 'archived').length && <p className="text-sm text-gray-400">No suspensions on record.</p>}
      </div>
    </div>
  );
}

// ── Data Maintenance Panel ────────────────────────────────────────────────────

interface BackfillResult {
  segmentsScanned: number;
  segmentsUpdated: number;
  rulesScanned: number;
  rulesUpdated: number;
  dryRun: boolean;
}

interface BackfillPageResult extends BackfillResult {
  nextCursor: string | null;
  done: boolean;
}

// Calls the adminBackfillStreetIntelligence callable (requireCurrentAdmin-gated;
// see functions/index.js) repeatedly until it reports done:true, accumulating
// totals across pages. Replaces the old direct-Firestore-write implementation
// that used to live in utils/backfill.ts — that path was authorized only by
// firestore.rules' token-only isAdmin() check, which a stale admin token
// could still pass after demotion/deletion/disablement.
async function runBackfill(dryRun: boolean): Promise<BackfillResult> {
  const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'adminBackfillStreetIntelligence');
  const totals: BackfillResult = { segmentsScanned: 0, segmentsUpdated: 0, rulesScanned: 0, rulesUpdated: 0, dryRun };
  let cursor: string | null = null;
  let done = false;
  while (!done) {
    const res = await fn({ dryRun, cursor });
    const page = res.data as BackfillPageResult;
    totals.segmentsScanned += page.segmentsScanned;
    totals.segmentsUpdated += page.segmentsUpdated;
    totals.rulesScanned += page.rulesScanned;
    totals.rulesUpdated += page.rulesUpdated;
    cursor = page.nextCursor;
    done = page.done;
  }
  return totals;
}

function DataMaintenancePanel() {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<BackfillResult | null>(null);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runDryRun = async () => {
    setRunning(true);
    setError(null);
    setPreview(null);
    setApplied(false);
    try {
      const result = await runBackfill(true);
      setPreview(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Dry run failed.');
    } finally {
      setRunning(false);
    }
  };

  const applyBackfill = async () => {
    if (!confirm('Apply backfill? This will write missing schema fields to Firestore. The operation is safe and idempotent.')) return;
    setRunning(true);
    setError(null);
    try {
      const result = await runBackfill(false);
      setPreview(result);
      setApplied(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Backfill failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-8 border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-600">
          <Wrench size={15} />
          Data Maintenance
        </span>
        {open ? <ChevronUp size={15} className="text-gray-400" /> : <ChevronDown size={15} className="text-gray-400" />}
      </button>

      {open && (
        <div className="px-4 pb-5 pt-4 bg-white space-y-4">
          <div>
            <p className="text-sm font-semibold text-gray-800 mb-1">Schema Backfill</p>
            <p className="text-xs text-gray-500 mb-3">
              Adds missing <code className="bg-gray-100 px-1 rounded">status</code>,{' '}
              <code className="bg-gray-100 px-1 rounded">source</code>,{' '}
              <code className="bg-gray-100 px-1 rounded">confidenceScore</code>, and{' '}
              <code className="bg-gray-100 px-1 rounded">provenance</code> fields to existing
              segments and rules. Never overwrites existing values. Safe to run multiple times.
            </p>

            <div className="flex gap-2">
              <button
                onClick={runDryRun}
                disabled={running}
                className="px-3 py-1.5 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {running && !preview ? 'Scanning…' : 'Dry Run'}
              </button>
              {preview && !applied && (
                <button
                  onClick={applyBackfill}
                  disabled={running || (preview.segmentsUpdated === 0 && preview.rulesUpdated === 0)}
                  className="px-3 py-1.5 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {running ? 'Applying…' : `Apply (${preview.segmentsUpdated + preview.rulesUpdated} changes)`}
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-red-600 text-sm">
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          {preview && (
            <div className={`rounded-lg p-3 text-sm ${applied ? 'bg-green-50 border border-green-200' : 'bg-blue-50 border border-blue-200'}`}>
              <p className="font-semibold mb-1 text-gray-800">
                {applied ? '✓ Backfill applied' : 'Dry run results'}
              </p>
              <ul className="text-xs text-gray-600 space-y-0.5">
                <li>Segments scanned: <strong>{preview.segmentsScanned}</strong></li>
                <li>Segments {applied ? 'updated' : 'would update'}: <strong>{preview.segmentsUpdated}</strong></li>
                <li>Rules scanned: <strong>{preview.rulesScanned}</strong></li>
                <li>Rules {applied ? 'updated' : 'would update'}: <strong>{preview.rulesUpdated}</strong></li>
              </ul>
              {!applied && preview.segmentsUpdated === 0 && preview.rulesUpdated === 0 && (
                <p className="text-xs text-green-700 mt-1 font-medium">All documents already up to date.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type StatusFilter = 'active' | 'needs_review' | 'archived' | 'all';

export const StreetSegmentsPage = () => {
  const [segments, setSegments] = useState<SegmentDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'segments' | 'suspensions' | 'failures' | 'health'>('segments');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');

  const loadSegments = async (filter: StatusFilter = statusFilter) => {
    setLoading(true);
    const q = filter === 'all'
      ? query(collection(db, 'streetSegments'))
      : query(collection(db, 'streetSegments'), where('status', '==', filter));
    const snap = await getDocs(q);
    setSegments(
      snap.docs
        .map(d => ({ id: d.id, ...d.data() } as SegmentDoc))
        .sort((a, b) => a.streetName.localeCompare(b.streetName))
    );
    setLoading(false);
  };

  useEffect(() => { loadSegments(statusFilter); }, [statusFilter]);

  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Street Intelligence</h2>
        <p className="text-sm text-gray-500 mt-1">Manage street segments and parking rules for the ParQueen Street Intelligence system.</p>
      </div>

      <div className="flex gap-2 mb-6 border-b border-gray-200">
        {([
          { key: 'segments', label: 'Segments' },
          { key: 'suspensions', label: 'Suspensions' },
          { key: 'failures', label: 'Parse Failures' },
          { key: 'health', label: 'Health' },
        ] as const).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors -mb-px ${activeTab === tab.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'segments' && (
        <>
          <AddSegmentForm onSaved={() => loadSegments(statusFilter)} />
          <div className="flex gap-2 mb-4">
            {(['active', 'needs_review', 'archived', 'all'] as const).map(f => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`px-3 py-1 text-xs font-semibold rounded-full transition-colors ${statusFilter === f ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                {f === 'needs_review' ? 'Needs Review' : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          {loading ? (
            <p className="text-sm text-gray-400">Loading segments…</p>
          ) : segments.length === 0 ? (
            <p className="text-sm text-gray-400">No segments with status "{statusFilter}".</p>
          ) : (
            <div>
              {segments.map(seg => (
                <SegmentRow key={seg.id} seg={seg} onDeleted={() => loadSegments(statusFilter)} />
              ))}
            </div>
          )}
          <DataMaintenancePanel />
        </>
      )}

      {activeTab === 'suspensions' && <SuspensionsPanel />}

      {activeTab === 'failures' && <ParseFailuresPage />}

      {activeTab === 'health' && <StreetIntelligenceHealthPage />}
    </div>
  );
};
