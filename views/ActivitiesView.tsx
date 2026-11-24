import React, { useState, useEffect, useRef } from 'react';
import { ChevronLeft, MapPin, Clock, ChevronDown, Handshake, ParkingSquare } from 'lucide-react';
import { db } from '../firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { t, useLang, getLang } from '../i18n';
import { InlineLoader, SectionLoader } from '../components/LoadingScreen';

interface HistoryItem {
  id: string;
  role: 'finder' | 'driver';
  rawAddress: string;
  status: string;
  statusLabelKey: string;
  timestamp: number;
}

const PAGE_SIZE = 20;

function formatStatusKey(role: string, spotStatus: string, outcome?: string): { status: string; statusLabelKey: string } {
  if (role === 'driver') {
    if (outcome === 'success') return { status: 'success', statusLabelKey: 'activity.status_parked' };
    if (outcome === 'failed') return { status: 'failed', statusLabelKey: 'activity.status_unsuccessful' };
    return { status: 'completed', statusLabelKey: 'activity.status_completed' };
  }
  if (spotStatus === 'occupied') return { status: 'success', statusLabelKey: 'activity.status_helped_driver' };
  if (spotStatus === 'interested') return { status: 'active', statusLabelKey: 'activity.status_in_progress' };
  if (spotStatus === 'available') return { status: 'active', statusLabelKey: 'activity.status_active' };
  return { status: 'expired', statusLabelKey: 'activity.status_expired' };
}

const STATUS_STYLES: Record<string, string> = {
  success: 'bg-green-500/10 text-[var(--color-success)] border-green-500/20',
  failed: 'bg-red-500/10 text-[var(--color-danger)] border-red-500/20',
  active: 'bg-blue-500/10 text-[var(--color-accent)] border-blue-500/20',
  completed: 'bg-gray-500/10 text-[var(--color-text-secondary)] border-[var(--color-border)]',
  expired: 'bg-gray-500/10 text-[var(--color-text-secondary)] border-[var(--color-border)]',
};

export const ActivitiesView = ({ user, onBack }: { user: any; onBack: () => void }) => {
  useLang();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Full history is fetched once and cached here; "Load More" pages through
  // this cache client-side instead of re-querying both collections from
  // scratch on every tap (the previous design re-downloaded the user's
  // entire spots + spotFeedback history again just to reveal 20 more
  // already-known items).
  const allHistoryRef = useRef<HistoryItem[]>([]);

  const showPage = (count: number) => {
    const all = allHistoryRef.current;
    setItems(all.slice(0, count));
    setHasMore(all.length > count);
  };

  const fetchHistory = async () => {
    if (!user?.id) return;

    try {
      const spotsQ = query(collection(db, 'spots'), where('finderId', '==', user.id));
      const spotsSnap = await getDocs(spotsQ);

      const finderItems: HistoryItem[] = spotsSnap.docs.map(d => {
        const s = d.data();
        const ts = s.reportedAt?.toMillis?.() || 0;
        const { status, statusLabelKey } = formatStatusKey('finder', s.status);
        return { id: `finder-${d.id}`, role: 'finder' as const, rawAddress: s.address || '', status, statusLabelKey, timestamp: ts };
      });

      const feedbackQ = query(collection(db, 'spotFeedback'), where('userId', '==', user.id));
      const feedbackSnap = await getDocs(feedbackQ);

      const driverItems: HistoryItem[] = feedbackSnap.docs.map(d => {
        const f = d.data();
        const ts = f.createdAt?.toMillis?.() || 0;
        const { status, statusLabelKey } = formatStatusKey('driver', '', f.outcome);
        return { id: `driver-${d.id}`, role: 'driver' as const, rawAddress: f.address || '', status, statusLabelKey, timestamp: ts };
      });

      allHistoryRef.current = [...finderItems, ...driverItems].sort((a, b) => b.timestamp - a.timestamp);
      showPage(PAGE_SIZE);
    } catch (err) {
      console.error('Error fetching parking history', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    allHistoryRef.current = [];
    fetchHistory();
  }, [user?.id]);

  const handleLoadMore = () => {
    if (loadingMore) return;
    setLoadingMore(true);
    showPage(items.length + PAGE_SIZE);
    setLoadingMore(false);
  };

  return (
    <div className="min-h-full bg-[var(--color-bg)] text-[var(--color-text)] pt-4 pb-20 px-4 max-w-md mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <button onClick={onBack} aria-label={t('activity.back_aria')} className="w-10 h-10 rounded-full flex items-center justify-center bg-white/5 border border-[var(--color-border)] text-[var(--color-text)] hover:bg-white/10 transition-all shrink-0">
          <ChevronLeft size={20} />
        </button>
        <div>
          <h1 className="text-xl font-bold text-[var(--color-text)] tracking-wide">{t('activity.title')}</h1>
          <p className="text-xs text-[var(--color-text-secondary)]">{t('activity.subtitle')}</p>
        </div>
      </div>

      {loading ? (
        <SectionLoader label={t('common.loading')} className="p-10" />
      ) : items.length === 0 ? (
        <div className="text-center p-10 text-[var(--color-text-secondary)] bg-[var(--color-card)] border border-[var(--color-border)] backdrop-blur-md rounded-2xl">
          <MapPin className="mx-auto mb-3.5 opacity-80" size={32} />
          <p className="text-sm">{t('activity.no_history')}</p>
          <p className="text-xs mt-1">{t('activity.no_history_hint')}</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map(item => {
            const locale = getLang() === 'es' ? 'es' : 'en-US';
            const displayDate = item.timestamp ? new Date(item.timestamp).toLocaleString(locale) : '—';
            const displayAddress = item.rawAddress || t(item.role === 'finder' ? 'activity.address_fallback_finder' : 'activity.address_fallback_driver');
            return (
              <div key={item.id} className="bg-[var(--color-card)] border border-[var(--color-border)] backdrop-blur-md rounded-2xl p-3.5 flex items-center gap-3.5">
                <div className={`p-2 rounded-xl shrink-0 ${item.role === 'finder' ? 'bg-yellow-400/15 text-[var(--color-warning)]' : 'bg-green-500/10 text-[var(--color-success)]'}`}>
                  {item.role === 'finder' ? <Handshake size={18} /> : <ParkingSquare size={18} />}
                </div>
                <div className="flex-1 min-w-0">
                  <h2 data-activity-address className="font-semibold text-sm text-[var(--color-text)] truncate">{displayAddress}</h2>
                  <p className="text-[10px] text-[var(--color-text-secondary)] flex items-center gap-1.5 mt-0.5">
                    <Clock size={11} className="shrink-0" />
                    <span>{displayDate}</span>
                    <span className="mx-0.5">·</span>
                    <span>{item.role === 'finder' ? t('activity.you_pinged') : t('activity.you_parked')}</span>
                  </p>
                </div>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-lg border shrink-0 ${STATUS_STYLES[item.status] || STATUS_STYLES.completed}`}>
                  {t(item.statusLabelKey)}
                </span>
              </div>
            );
          })}

          {hasMore && (
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              aria-busy={loadingMore}
              className="w-full py-2.5 rounded-xl text-xs font-semibold bg-white/5 border border-[var(--color-border)] hover:bg-white/10 transition-all text-[var(--color-text-secondary)] flex items-center justify-center gap-1.5"
            >
              {loadingMore ? (
                <InlineLoader size={16} label={t('common.loading')} className="text-[var(--color-brand)]" />
              ) : (
                <>
                  <ChevronDown size={14} />
                  {t('activity.load_more')}
                </>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
