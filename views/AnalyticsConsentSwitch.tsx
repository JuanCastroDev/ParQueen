import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { BarChart3 } from 'lucide-react';
import { t, useLang } from '../i18n';
import { auth } from '../firebase';
import {
  getAnalyticsConsentDisplayState,
  subscribeAnalyticsConsent,
  wasAnalyticsConsentLastServerConfirmedOn,
} from '../utils/analyticsConsentSession';
import { requestAnalyticsConsentChange } from '../utils/analyticsConsentReconciliation';

interface Props {
  userId: string | null;
  rowClass: string;
}

type Saving = 'enabling' | 'disabling' | null;

export const AnalyticsConsentSwitch: React.FC<Props> = ({
  userId,
  rowClass,
}) => {
  useLang();

  const consentState = useSyncExternalStore(
    subscribeAnalyticsConsent,
    () => getAnalyticsConsentDisplayState(userId),
    () => 'unavailable' as const,
  );

  const [saving, setSaving] = useState<Saving>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const writeGeneration = useRef(0);

  useEffect(() => {
    writeGeneration.current += 1;
    setSaving(null);
    setSaveFailed(false);

    return () => {
      writeGeneration.current += 1;
    };
  }, [userId]);

  const checked = consentState === 'on';

  const canEdit =
    !!userId &&
    auth?.currentUser?.uid === userId &&
    consentState !== 'unavailable';

  const handleToggle = () => {
    // Never write a preference for a stale or different account.
    if (
      !userId ||
      auth?.currentUser?.uid !== userId ||
      consentState === 'unavailable' ||
      saving === 'disabling'
    ) {
      return;
    }

    // A second tap while enabling means CANCEL, not another opt-in.
    // A pending OFF marker means retry saving OFF.
    // The switch fails closed when Firestore goes cache-only. A recent
    // server-confirmed ON must still be explicitly revocable while offline,
    // even though it is displayed as OFF and no captures are permitted.
    const enable = !(
      checked ||
      consentState === 'pending_off' ||
      saving === 'enabling' ||
      (consentState === 'off' && wasAnalyticsConsentLastServerConfirmedOn(userId))
    );

    const generation = ++writeGeneration.current;

    setSaveFailed(false);
    setSaving(enable ? 'enabling' : 'disabling');

    void (async () => {
      try {
        await requestAnalyticsConsentChange(userId, enable);
      } catch {
        if (writeGeneration.current === generation) {
          setSaveFailed(true);
        }
      } finally {
        if (writeGeneration.current === generation) {
          setSaving(null);
        }
      }
    })();
  };

  const detailKey = saveFailed
    ? 'settings.analytics_save_error'
    : saving === 'disabling'
      ? 'settings.analytics_disabling'
      : saving === 'enabling'
        ? 'settings.analytics_enabling'
        : consentState === 'pending_off'
          ? 'settings.analytics_pending_off'
          : checked
            ? 'settings.analytics_on'
            : 'settings.analytics_off';

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-label={t('settings.analytics_title')}
        aria-checked={checked}
        disabled={!canEdit || saving === 'disabling'}
        onClick={handleToggle}
        className={`${rowClass} disabled:opacity-60`}
      >
        <span className="pq-row-icon" aria-hidden="true">
          <BarChart3 size={17} />
        </span>

        <span className="flex-1 min-w-0">
          <span className="block text-[15px] font-semibold text-[var(--color-text)] leading-snug">
            {t('settings.analytics_title')}
          </span>
          <span className="block mt-0.5 text-[12.5px] leading-snug text-[var(--color-text-secondary)]">
            {t(detailKey)}
          </span>
        </span>

        <span
          className={`pq-switch${checked ? ' pq-switch--on' : ''}`}
          aria-hidden="true"
        >
          <span className="pq-switch-thumb" />
        </span>
      </button>

      {saveFailed && (
        <p role="alert" className="pq-inline-note pq-inline-note--error px-4 py-2">
          {t('settings.analytics_save_error')}
        </p>
      )}
    </>
  );
};