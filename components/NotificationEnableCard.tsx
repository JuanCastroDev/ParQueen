import React from 'react';
import { Bell, CheckCircle2, Smartphone } from 'lucide-react';
import { t, useLang } from '../i18n';
import type { NotificationRuntimeState } from '../utils/notificationRegistration';
import { deriveNotificationPresentation } from '../utils/notificationPresentation';

interface NotificationEnableCardProps {
  runtime: NotificationRuntimeState | null;
  productPreferenceEnabled: boolean;
  busy?: boolean;
  onEnable: () => void;
  onRecheck: () => void;
}

export const NotificationEnableCard: React.FC<NotificationEnableCardProps> = ({
  runtime,
  productPreferenceEnabled,
  busy = false,
  onEnable,
  onRecheck,
}) => {
  useLang();
  const presentation = deriveNotificationPresentation(productPreferenceEnabled, runtime);

  const copy = (() => {
    switch (presentation.kind) {
      case 'checking':
        return { title: t('notifications.setup_checking'), body: t('notifications.setup_checking_body') };
      case 'enabled':
        return { title: t('notifications.setup_enabled'), body: t('notifications.setup_enabled_body') };
      case 'ios_install_required':
        return { title: t('notifications.setup_ios_title'), body: t('notifications.setup_ios_body') };
      case 'ios_native_unavailable':
        return { title: t('notifications.setup_ios_native_title'), body: t('notifications.setup_ios_native_body') };
      case 'unsupported':
        return { title: t('notifications.setup_unsupported'), body: t('notifications.setup_unsupported_body') };
      case 'denied':
        return { title: t('notifications.setup_denied'), body: t('notifications.setup_denied_body') };
      case 'registration_failed':
        return { title: t('notifications.setup_failed'), body: t('notifications.setup_failed_body') };
      case 'off':
        return { title: t('notifications.setup_off'), body: t('notifications.setup_enable_body') };
      case 'enable':
        return { title: t('notifications.setup_enable'), body: t('notifications.setup_enable_body') };
    }
  })();

  const action = (() => {
    switch (presentation.action) {
      case 'enable': return { label: t('notifications.setup_enable_action'), handler: onEnable };
      case 'retry': return { label: t('notifications.setup_retry'), handler: onEnable };
      case 'recheck': return { label: t('notifications.setup_recheck'), handler: onRecheck };
      case 'none': return null;
    }
  })();

  const Icon = presentation.kind === 'ios_install_required'
    ? Smartphone
    : presentation.kind === 'enabled'
      ? CheckCircle2
      : Bell;

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-4" aria-live="polite">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-[#1e75ff]/10 p-2.5 text-[var(--color-info)] shrink-0">
          <Icon size={18} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-[var(--color-text)]">{copy.title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">{copy.body}</p>
          {presentation.kind === 'ios_install_required' && (
            <p className="mt-2 text-xs font-semibold text-[var(--color-text)]">
              {t('notifications.setup_ios_steps')}
            </p>
          )}
          {action && (
            <button
              type="button"
              data-notification-action={presentation.action}
              onClick={action.handler}
              disabled={busy}
              className="mt-3 rounded-xl bg-[var(--color-brand)] px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
            >
              {busy ? t('notifications.setup_working') : action.label}
            </button>
          )}
        </div>
      </div>
    </section>
  );
};
