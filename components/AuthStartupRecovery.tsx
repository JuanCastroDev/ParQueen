import React from 'react';
import { t, useLang } from '../i18n';

export const AuthStartupRecovery = ({ onRetry }: { onRetry: () => void }) => {
  useLang();
  return (
    <div
      className="h-full w-full flex flex-col items-center justify-center gap-4 px-8 bg-[var(--color-bg)] text-center"
      role="alert"
    >
      <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">
        {t('startup.auth_timeout_title')}
      </h1>
      <p className="text-[var(--color-text-secondary)]">
        {t('startup.auth_timeout_body')}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="px-6 py-2 bg-blue-500 text-white rounded-lg"
      >
        {t('startup.auth_timeout_retry')}
      </button>
    </div>
  );
};
