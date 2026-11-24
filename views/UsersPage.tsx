import React, { useState, useEffect } from 'react';
import type { Timestamp } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { fetchAllUsers, fetchUserDetail } from '../utils/adminReadService';
import {
  MoreVertical, Search, X, ShieldCheck, ShieldAlert, AlertTriangle,
  Info, Car, MapPin, Flag, ClipboardList, RefreshCw,
} from 'lucide-react';

// ── Local types ───────────────────────────────────────────────────────────────

// Minimal Timestamp-like interface — avoids re-importing Firestore Timestamp for helpers
type FsTs = { toDate(): Date };

interface TrustStats {
  handoffsCompleted?: number;
  handoffsCancelledByFinder?: number;
}

interface UserDoc {
  id: string;
  fullName?: string;
  username?: string;
  email?: string;
  phone?: string;
  phoneNumber?: string;
  avatar?: string;
  status?: string;
  trustScore?: number;
  trustStats?: TrustStats;
  createdAt?: Timestamp;
  suspendedAt?: Timestamp;
  suspendedBy?: string;
  suspensionReason?: string;
  unsuspendedAt?: Timestamp;
  unsuspendedBy?: string;
}

interface TrustEvent {
  id: string;
  statField: string;
  source?: string;
  processedAt?: Timestamp;
}

interface ParkingSessionData {
  userId?: string;
  active: boolean;
  streetName?: string;
  nextCleaningAt?: Timestamp | null;
  savedAt?: Timestamp;
  segmentId?: string | null;
  parkingSide?: string | null;
  reminderEnabled?: boolean;
  reminderSent?: boolean;
}

interface UserPing {
  id: string;
  lat: number;
  lng: number;
  status: string;
  address?: string;
  reportedAt: Timestamp;
  expiresAt: Timestamp;
  finderId?: string;
  finderName?: string;
  interestedUserId?: string;
  interestedUserName?: string;
  etaMinutes?: number | null;
}

interface UserReport {
  id: string;
  reportedUserId: string;
  reporterId: string;
  type?: string;
  reason: string;
  status: string;
  createdAt: Timestamp;
  adminNote?: string | null;
  reviewedAt?: Timestamp | null;
  reviewedBy?: string | null;
}

// Covers both new standard entries and legacy entries read from adminAuditLog
interface AuditEntry {
  id: string;
  action: string;
  // Standard fields
  targetType?: string;
  targetId?: string;
  targetUserId?: string | null;
  adminId?: string;
  adminEmail?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: Timestamp;
  // Legacy fields
  adminUid?: string;
  performedAt?: Timestamp;
  finderId?: string | null;
  spotId?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const trustScoreStyle = (score: number) => {
  if (score >= 85) return { text: 'text-green-700', bg: 'bg-green-50 border-green-200',    label: 'Established' };
  if (score >= 65) return { text: 'text-blue-700',  bg: 'bg-blue-50 border-blue-200',      label: 'Trusted' };
  if (score >= 40) return { text: 'text-yellow-700', bg: 'bg-yellow-50 border-yellow-200', label: 'New' };
  return              { text: 'text-red-700',   bg: 'bg-red-50 border-red-200',         label: 'Flagged' };
};

const statFieldLabel = (statField: string) => {
  if (statField === 'handoffsCompleted')            return 'Handoff Completed';
  if (statField === 'handoffsCancelledByFinder')    return 'Handoff Cancelled (Finder)';
  return statField;
};

const computeTrustFlags = (stats: TrustStats | undefined, score: number) => {
  const completed = stats?.handoffsCompleted ?? 0;
  const cancelled = stats?.handoffsCancelledByFinder ?? 0;
  const total = completed + cancelled;
  const flags: { icon: React.ReactNode; label: string; severity: 'high' | 'medium' | 'low' }[] = [];
  if (total >= 3 && cancelled / total > 0.4)
    flags.push({ icon: <ShieldAlert size={14} />, label: 'High Cancellation Rate', severity: 'high' });
  if (score < 40)
    flags.push({ icon: <ShieldAlert size={14} />, label: 'Low Trust Score', severity: 'high' });
  else if (score < 65)
    flags.push({ icon: <AlertTriangle size={14} />, label: 'Below Average Trust', severity: 'medium' });
  if (total === 0)
    flags.push({ icon: <Info size={14} />, label: 'No Trust Activity Yet', severity: 'low' });
  return flags;
};

const severityStyle: Record<string, string> = {
  high:   'bg-red-50 text-red-700 border-red-200',
  medium: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  low:    'bg-gray-50 text-gray-600 border-gray-200',
};

const formatDate = (ts: FsTs | null | undefined): string => {
  if (!ts?.toDate) return 'N/A';
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(ts.toDate());
};

const formatDateTime = (ts: FsTs | null | undefined): string => {
  if (!ts?.toDate) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(ts.toDate());
};

const isPingExpired = (ping: UserPing) => ping.expiresAt?.toDate().getTime() < Date.now();

const pingStatusLabel = (ping: UserPing) => {
  if (isPingExpired(ping)) return 'Expired';
  if (ping.status === 'interested') return 'Claimed';
  if (ping.status === 'occupied')   return 'Occupied';
  return 'Active';
};

const pingStatusClass = (ping: UserPing) => {
  if (isPingExpired(ping))          return 'bg-gray-100 text-gray-500';
  if (ping.status === 'interested') return 'bg-blue-100 text-blue-700';
  return 'bg-green-100 text-green-700';
};

const reportStatusClass = (status: string) => {
  if (status === 'pending')   return 'bg-amber-100 text-amber-700';
  if (status === 'reviewed')  return 'bg-green-100 text-green-700';
  if (status === 'dismissed') return 'bg-gray-100 text-gray-500';
  return 'bg-gray-100 text-gray-400';
};

// True if the entry only has legacy fields (no standard targetType/targetId/adminId)
const isLegacyEntry = (e: AuditEntry): boolean =>
  !e.targetType && !e.adminId;

// ── Suspend Modal ─────────────────────────────────────────────────────────────

const SuspendModal = ({
  user, isOpen, onClose, onConfirm,
}: {
  user: UserDoc | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) => {
  const [reason, setReason] = useState('');
  useEffect(() => { if (isOpen) setReason(''); }, [isOpen]);
  if (!isOpen || !user) return null;
  return (
    <div className="fixed inset-0 bg-black/50 flex justify-center items-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md">
        <h3 className="text-lg font-bold text-gray-800 mb-1">Suspend User</h3>
        <p className="text-sm text-gray-500 mb-4">
          Suspending <strong>{user.fullName || user.username || user.email}</strong>.
          This action is recorded in the admin audit log.
        </p>
        <label className="block text-sm font-semibold text-gray-700 mb-2">Reason (required)</label>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. Multiple abuse reports, repeated policy violations…"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
        />
        <div className="flex justify-end gap-3 mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg">
            Cancel
          </button>
          <button
            disabled={!reason.trim()}
            onClick={() => onConfirm(reason.trim())}
            className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
          >
            Suspend User
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Section wrapper ───────────────────────────────────────────────────────────

const Section = ({
  icon, title, badge, children,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: number;
  children: React.ReactNode;
}) => (
  <div>
    <h3 className="font-bold text-gray-500 mb-3 text-sm uppercase tracking-wider flex items-center gap-2">
      {icon}
      {title}
      {badge != null && badge > 0 && (
        <span className="px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-bold">{badge}</span>
      )}
    </h3>
    {children}
  </div>
);

// ── User Details Modal ────────────────────────────────────────────────────────

const UserDetailsModal = ({
  user, isOpen, onClose,
}: {
  user: UserDoc | null;
  isOpen: boolean;
  onClose: () => void;
}) => {
  const [trustEvents, setTrustEvents]       = useState<TrustEvent[]>([]);
  const [session, setSession]               = useState<ParkingSessionData | null>(null);
  const [recentPings, setRecentPings]       = useState<UserPing[]>([]);
  const [reportsAgainst, setReportsAgainst] = useState<UserReport[]>([]);
  const [reportsFiled, setReportsFiled]     = useState<UserReport[]>([]);
  const [auditEntries, setAuditEntries]     = useState<AuditEntry[]>([]);
  const [loading, setLoading]               = useState(false);
  const [errors, setErrors]                 = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isOpen || !user) {
      setTrustEvents([]); setSession(null); setRecentPings([]);
      setReportsAgainst([]); setReportsFiled([]); setAuditEntries([]);
      setErrors({});
      return;
    }

    setLoading(true);
    const uid = user.id;

    // Single bundled server-side read (adminReadView('userDetail'),
    // requireCurrentAdmin-gated) replaces the 7 direct Firestore queries this
    // modal used to fire individually. Per-section failures are still
    // tolerated (mirrors the previous Promise.allSettled UX), but error text
    // is now a generic sanitized message — never a raw Admin SDK error.
    fetchUserDetail(uid).then((data) => {
      setTrustEvents(data.trustEvents as TrustEvent[]);
      setSession(data.session as ParkingSessionData | null);
      setRecentPings(data.recentPings as UserPing[]);
      setReportsAgainst(data.reportsAgainst as UserReport[]);
      setReportsFiled(data.reportsFiled as UserReport[]);
      setAuditEntries(data.auditEntries as AuditEntry[]);

      const errs: Record<string, string> = {};
      for (const key of Object.keys(data.errors || {})) {
        errs[key] = 'Failed to load.';
      }
      setErrors(errs);
      setLoading(false);
    }).catch((e: unknown) => {
      setErrors({ trust: 'Failed to load.', session: 'Failed to load.', pings: 'Failed to load.', reportsAgainst: 'Failed to load.', reportsFiled: 'Failed to load.', audit: 'Failed to load.' });
      setLoading(false);
      console.error('User detail load failed:', e instanceof Error ? e.message : e);
    });
  }, [isOpen, user?.id]);

  if (!isOpen || !user) return null;

  const DetailItem = ({
    label, value, children,
  }: { label: string; value?: string | number; children?: React.ReactNode }) => (
    <div>
      <p className="text-sm font-medium text-gray-500">{label}</p>
      {children ?? <p className="text-gray-900 mt-1">{value ?? '—'}</p>}
    </div>
  );

  const ErrorNote = ({ msg }: { msg?: string }) =>
    msg ? <p className="text-xs text-red-500 mt-1">⚠ {msg}</p> : null;

  const userIsSuspended = user.status === 'Suspended' || user.status === 'suspended';
  const score      = user.trustScore ?? 75;
  const stats      = user.trustStats;
  const trustStyle = trustScoreStyle(score);
  const flags      = computeTrustFlags(stats, score);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl p-8 w-full max-w-2xl relative overflow-y-auto max-h-[90vh]">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-gray-600">
          <X size={24} />
        </button>

        {/* Header */}
        <div className="flex items-center space-x-4 mb-6">
          {user.avatar ? (
            <img src={user.avatar} alt="Avatar" className="w-16 h-16 rounded-full" />
          ) : (
            <div className="w-16 h-16 rounded-full bg-gray-200 flex items-center justify-center text-gray-400">
              <i className="fa-solid fa-user text-2xl" />
            </div>
          )}
          <div>
            <h2 className="text-2xl font-bold text-gray-800">{user.fullName || 'N/A'}</h2>
            <p className="text-sm text-gray-500">{user.email}</p>
            {user.username && <p className="text-sm text-gray-400">@{user.username}</p>}
          </div>
        </div>

        {loading && <p className="text-sm text-gray-400 mb-4">Loading investigation data…</p>}

        <div className="space-y-8">

          {/* General Details */}
          <Section icon={<Info size={14} />} title="General Details">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
              <DetailItem label="Join Date" value={formatDate(user.createdAt)} />
              <DetailItem label="Status">
                <span className={`px-2 py-1 text-xs font-semibold rounded-full ${userIsSuspended ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                  {user.status || 'Active'}
                </span>
              </DetailItem>
              <DetailItem label="UID">
                <p className="text-gray-600 text-xs font-mono mt-1">{user.id}</p>
              </DetailItem>
              <DetailItem label="Phone" value={user.phone || user.phoneNumber || '—'} />
              {userIsSuspended && (
                <>
                  <DetailItem label="Suspended At"   value={formatDateTime(user.suspendedAt)} />
                  <DetailItem label="Suspended By">
                    <p className="text-gray-600 text-xs font-mono mt-1">{user.suspendedBy || '—'}</p>
                  </DetailItem>
                  <DetailItem label="Suspension Reason" value={user.suspensionReason || '—'} />
                </>
              )}
              {user.unsuspendedAt && (
                <DetailItem label="Last Unsuspended" value={formatDateTime(user.unsuspendedAt)} />
              )}
            </div>
          </Section>

          {/* Trust Overview */}
          <Section icon={<ShieldCheck size={14} />} title="Trust Overview">
            <div className={`flex items-center gap-4 p-4 rounded-lg border mb-4 ${trustStyle.bg}`}>
              <ShieldCheck size={32} className={trustStyle.text} />
              <div>
                <p className={`text-3xl font-extrabold ${trustStyle.text}`}>{score}</p>
                <p className={`text-xs font-semibold uppercase tracking-wide ${trustStyle.text}`}>{trustStyle.label}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
              <DetailItem label="Handoffs Completed"  value={stats?.handoffsCompleted ?? 0} />
              <DetailItem label="Cancelled by Finder" value={stats?.handoffsCancelledByFinder ?? 0} />
            </div>
            <p className="text-xs text-gray-400 mt-3">Additional trust signals will appear here once tracked.</p>
          </Section>

          {/* Trust Flags */}
          {flags.length > 0 && (
            <Section icon={<AlertTriangle size={14} />} title="Trust Flags">
              <div className="space-y-2">
                {flags.map((flag, i) => (
                  <div key={i} className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium ${severityStyle[flag.severity]}`}>
                    {flag.icon}
                    <span>{flag.label}</span>
                    <span className="ml-auto text-xs uppercase tracking-wide opacity-60">{flag.severity}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Trust Events */}
          <Section icon={<ClipboardList size={14} />} title="Trust Events">
            <p className="text-xs text-gray-400 mb-2">Last 20 events</p>
            <ErrorNote msg={errors.trust} />
            {trustEvents.length === 0 && !errors.trust ? (
              <p className="text-gray-400 text-sm">No trust events recorded yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-100">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="bg-gray-50 text-xs text-gray-500 font-semibold uppercase">
                      <th className="px-3 py-2">Event</th>
                      <th className="px-3 py-2">Source</th>
                      <th className="px-3 py-2">Processed At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trustEvents.map(ev => (
                      <tr key={ev.id} className="border-t border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-2 font-medium text-gray-700">{statFieldLabel(ev.statField)}</td>
                        <td className="px-3 py-2 text-gray-500 capitalize">{ev.source || 'user'}</td>
                        <td className="px-3 py-2 text-gray-500">{formatDate(ev.processedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* Active Parking Session */}
          <Section icon={<Car size={14} />} title="Active Parking Session">
            <ErrorNote msg={errors.session} />
            {!errors.session && (!session || !session.active) && (
              <p className="text-gray-400 text-sm">No active parking session.</p>
            )}
            {session?.active && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                <DetailItem label="Street"                        value={session.streetName || '—'} />
                <DetailItem label="Session Started"               value={formatDateTime(session.savedAt)} />
                <DetailItem label="Next street cleaning"    value={formatDateTime(session.nextCleaningAt)} />
                <DetailItem label="Parking Side"                  value={session.parkingSide || '—'} />
                {session.segmentId && (
                  <DetailItem label="Segment ID">
                    <p className="text-xs font-mono text-gray-600 mt-1">{session.segmentId}</p>
                  </DetailItem>
                )}
                <DetailItem label="Reminder Enabled" value={session.reminderEnabled ? 'Yes' : 'No'} />
              </div>
            )}
          </Section>

          {/* Recent Parking Pings */}
          <Section icon={<MapPin size={14} />} title="Recent Parking Pings" badge={recentPings.length || undefined}>
            <ErrorNote msg={errors.pings} />
            {!errors.pings && recentPings.length === 0 ? (
              <p className="text-gray-400 text-sm">No recent parking pings.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-100">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="bg-gray-50 text-xs text-gray-500 font-semibold uppercase">
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Address</th>
                      <th className="px-3 py-2">Reported</th>
                      <th className="px-3 py-2">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentPings.map(ping => (
                      <tr key={ping.id} className="border-t border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-2">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${pingStatusClass(ping)}`}>
                            {pingStatusLabel(ping)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-gray-700 max-w-[160px] truncate">
                          {ping.address || `${ping.lat.toFixed(4)}, ${ping.lng.toFixed(4)}`}
                        </td>
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{formatDateTime(ping.reportedAt)}</td>
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{formatDateTime(ping.expiresAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* Reports */}
          <Section
            icon={<Flag size={14} />}
            title="Reports Involving This User"
            badge={(reportsAgainst.length + reportsFiled.length) || undefined}
          >
            <ErrorNote msg={errors.reportsAgainst || errors.reportsFiled} />

            <div className="mb-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Against this user ({reportsAgainst.length})
              </p>
              {reportsAgainst.length === 0 ? (
                <p className="text-gray-400 text-sm">No reports against this user.</p>
              ) : (
                <div className="space-y-2">
                  {reportsAgainst.map(r => (
                    <div key={r.id} className="border border-gray-100 rounded-lg p-3 text-sm bg-gray-50">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${reportStatusClass(r.status)}`}>{r.status}</span>
                        <span className="text-xs text-gray-400">{formatDateTime(r.createdAt)}</span>
                      </div>
                      <p className="text-gray-700 text-sm">{r.reason}</p>
                      {r.adminNote && <p className="text-xs text-gray-500 mt-1 italic">Admin: {r.adminNote}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Filed by this user ({reportsFiled.length})
              </p>
              {reportsFiled.length === 0 ? (
                <p className="text-gray-400 text-sm">No reports filed by this user.</p>
              ) : (
                <div className="space-y-2">
                  {reportsFiled.map(r => (
                    <div key={r.id} className="border border-gray-100 rounded-lg p-3 text-sm bg-gray-50">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${reportStatusClass(r.status)}`}>{r.status}</span>
                        <span className="text-xs text-gray-400">{formatDateTime(r.createdAt)}</span>
                        <span className="text-xs text-gray-400">
                          Reported UID: <span className="font-mono">{r.reportedUserId?.slice(0, 8)}…</span>
                        </span>
                      </div>
                      <p className="text-gray-700 text-sm">{r.reason}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>

          {/* Admin Audit History */}
          <Section icon={<ClipboardList size={14} />} title="Admin Audit History">
            <p className="text-xs text-gray-400 mb-2">
              Standard entries query by <code className="font-mono">targetUserId</code>.
              Legacy spot-deletion entries query by <code className="font-mono">finderId</code> (marked ↩).
              Suspensions are also reflected in General Details above.
            </p>
            <ErrorNote msg={errors.audit} />
            {!errors.audit && auditEntries.length === 0 ? (
              <p className="text-gray-400 text-sm">No admin audit history for this user.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-100">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="bg-gray-50 text-xs text-gray-500 font-semibold uppercase">
                      <th className="px-3 py-2">Action</th>
                      <th className="px-3 py-2">Target</th>
                      <th className="px-3 py-2">Reason</th>
                      <th className="px-3 py-2">Admin</th>
                      <th className="px-3 py-2">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditEntries.map(entry => (
                      <tr key={entry.id} className="border-t border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-2 font-medium text-gray-700">
                          {entry.action}
                          {isLegacyEntry(entry) && (
                            <span className="ml-1 text-xs text-gray-400" title="Legacy schema entry">↩</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-500">
                          {entry.targetType
                            ? <span className="capitalize">{entry.targetType}</span>
                            : entry.spotId
                              ? <span className="font-mono">{entry.spotId.slice(0, 10)}…</span>
                              : '—'}
                        </td>
                        <td className="px-3 py-2 text-gray-500">{entry.reason || '—'}</td>
                        <td className="px-3 py-2 text-xs font-mono text-gray-400">
                          {(entry.adminId ?? entry.adminUid)?.slice(0, 8) ?? '—'}…
                        </td>
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                          {formatDateTime(entry.createdAt ?? entry.performedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

        </div>
      </div>
    </div>
  );
};

// ── Main Page ─────────────────────────────────────────────────────────────────

export const UsersPage = () => {
  const [users, setUsers]               = useState<UserDoc[]>([]);
  const [loading, setLoading]           = useState(true);
  const [searchTerm, setSearchTerm]     = useState('');
  const [statusFilter, setStatusFilter] = useState<'All' | 'Active' | 'Suspended'>('All');
  const [openMenu, setOpenMenu]         = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<UserDoc | null>(null);
  const [isViewOpen, setViewOpen]       = useState(false);
  const [isSuspendOpen, setSuspendOpen] = useState(false);
  const [actionError, setActionError]   = useState<string | null>(null);
  const [loadError, setLoadError]       = useState<string | null>(null);

  const loadUsers = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const docs = await fetchAllUsers();
      setUsers(docs as UserDoc[]);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load users.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadUsers(); }, []);

  const filteredUsers = users.filter(user => {
    const term = searchTerm.toLowerCase();
    const matchesSearch = !term
      || (user.fullName    || '').toLowerCase().includes(term)
      || (user.username    || '').toLowerCase().includes(term)
      || (user.email       || '').toLowerCase().includes(term)
      || (user.phone       || '').toLowerCase().includes(term)
      || (user.phoneNumber || '').toLowerCase().includes(term);

    const userIsSuspended = user.status === 'Suspended' || user.status === 'suspended';
    const matchesStatus =
      statusFilter === 'All' ||
      (statusFilter === 'Suspended' && userIsSuspended) ||
      (statusFilter === 'Active' && !userIsSuspended);

    return matchesSearch && matchesStatus;
  });

  const openMenuFor = (user: UserDoc) => {
    setSelectedUser(user);
    setOpenMenu(user.id);
    setActionError(null);
  };

  const handleSuspend = async (reason: string) => {
    if (!selectedUser) return;
    setSuspendOpen(false);
    try {
      const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'adminSuspendUser');
      await fn({ userId: selectedUser.id, reason });
      await loadUsers();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Failed to suspend user.');
    }
  };

  const handleUnsuspend = async (user: UserDoc) => {
    setOpenMenu(null);
    try {
      const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'adminUnsuspendUser');
      await fn({ userId: user.id });
      await loadUsers();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Failed to unsuspend user.');
    }
  };

  const isSuspended = (user: UserDoc) => user.status === 'Suspended' || user.status === 'suspended';

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-800">User Management</h1>
        <button
          onClick={loadUsers}
          className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-lg hover:bg-gray-100"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {loadError && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
          <span className="font-semibold">Error:</span> {loadError}
        </div>
      )}

      {actionError && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
          <span className="font-semibold">Error:</span> {actionError}
          <button onClick={() => setActionError(null)} className="ml-auto text-[var(--color-danger)] hover:text-red-600">
            <X size={16} />
          </button>
        </div>
      )}

      <div className="bg-white p-6 rounded-xl shadow-md">
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search name, username, email, phone…"
              className="w-full bg-gray-100 rounded-lg pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="flex gap-1">
            {(['All', 'Active', 'Suspended'] as const).map(f => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-full transition-colors ${statusFilter === f ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-sm font-semibold text-gray-500 bg-gray-50">
                <th className="p-4">Name</th>
                <th className="p-4">Email</th>
                <th className="p-4">Username</th>
                <th className="p-4">Joined</th>
                <th className="p-4">Trust</th>
                <th className="p-4">Status</th>
                <th className="p-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && [1, 2, 3, 4, 5].map(i => (
                <tr key={i} className="border-b border-gray-100">
                  {[1, 2, 3, 4, 5, 6, 7].map(j => (
                    <td key={j} className="p-4">
                      <div className="h-4 bg-gray-200 rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))}
              {!loading && filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center p-8 text-gray-400">
                    No users match current filters.
                  </td>
                </tr>
              )}
              {!loading && filteredUsers.map(user => (
                <tr key={user.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="p-4 font-medium text-gray-800">
                    {user.fullName || (user.email ? user.email.split('@')[0] : 'Anonymous')}
                  </td>
                  <td className="p-4 text-gray-500 text-sm">{user.email || '—'}</td>
                  <td className="p-4 text-gray-500 text-sm">{user.username ? `@${user.username}` : '—'}</td>
                  <td className="p-4 text-gray-500 text-sm">{formatDate(user.createdAt)}</td>
                  <td className="p-4">
                    {user.trustScore != null ? (
                      <span className={`text-xs font-bold ${trustScoreStyle(user.trustScore).text}`}>
                        {user.trustScore}
                      </span>
                    ) : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 text-xs font-semibold rounded-full ${isSuspended(user) ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                      {isSuspended(user) ? 'Suspended' : 'Active'}
                    </span>
                  </td>
                  <td className="p-4 text-center relative">
                    <button onClick={() => openMenuFor(user)} className="p-2 rounded-full hover:bg-gray-200">
                      <MoreVertical size={18} />
                    </button>
                    {openMenu === user.id && (
                      <div className="absolute right-0 mt-1 w-44 bg-white rounded-xl shadow-xl z-10 border border-gray-100 py-1">
                        <button
                          onClick={() => { setOpenMenu(null); setViewOpen(true); }}
                          className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                        >
                          View Details
                        </button>
                        <div className="border-t border-gray-100 my-1" />
                        {isSuspended(user) ? (
                          <button
                            onClick={() => handleUnsuspend(user)}
                            className="w-full text-left px-4 py-2.5 text-sm text-green-600 font-semibold hover:bg-green-50"
                          >
                            Unsuspend
                          </button>
                        ) : (
                          <button
                            onClick={() => { setOpenMenu(null); setSuspendOpen(true); }}
                            className="w-full text-left px-4 py-2.5 text-sm text-red-600 font-semibold hover:bg-red-50"
                          >
                            Suspend…
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <UserDetailsModal user={selectedUser} isOpen={isViewOpen} onClose={() => setViewOpen(false)} />
      <SuspendModal
        user={selectedUser}
        isOpen={isSuspendOpen}
        onClose={() => setSuspendOpen(false)}
        onConfirm={handleSuspend}
      />
    </div>
  );
};
