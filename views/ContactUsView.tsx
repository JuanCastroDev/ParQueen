import React from 'react';
import { ChevronLeft, Mail, Globe } from 'lucide-react';
import { t, useLang } from '../i18n';

export const ContactUsView = ({ onBack }: { onBack: () => void }) => {
  useLang();

  return (
    <div className="min-h-full bg-[var(--color-bg)] text-[var(--color-text)] pt-4 pb-20 px-4 max-w-md mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <button onClick={onBack} aria-label={t('profile.back_aria')} className="w-10 h-10 rounded-full flex items-center justify-center bg-white/5 border border-[var(--color-border)] text-[var(--color-text)] hover:bg-white/10 transition-all shrink-0">
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <h1 className="text-xl font-bold text-[var(--color-text)] tracking-wide">{t('profile.contact_us')}</h1>
      </div>

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] backdrop-blur-md rounded-3xl p-6 shadow-xl text-[var(--color-text-secondary)] text-sm space-y-6">
        <p className="text-[var(--color-text-secondary)]">
          {t('contact.intro')}
        </p>
        
        <a
          href="mailto:hello@parqueen.app"
          aria-label={`${t('contact.email_us')}: hello@parqueen.app`}
          className="group flex w-full min-h-11 items-center gap-4 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-info)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-card)]"
        >
          <div className="bg-[#1e75ff]/10 p-3 rounded-2xl text-[var(--color-info)] shrink-0">
            <Mail size={22} aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs text-[var(--color-text-secondary)]">{t('contact.email_us')}</p>
            <p className="font-bold text-[var(--color-text)] group-hover:text-[var(--color-info)] transition-colors">hello@parqueen.app</p>
          </div>
        </a>

        <a
          href="https://parqueen.app/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${t('contact.website')}: parqueen.app`}
          className="group flex w-full min-h-11 items-center gap-4 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-info)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-card)]"
        >
          <div className="bg-[#1e75ff]/10 p-3 rounded-2xl text-[var(--color-info)] shrink-0">
            <Globe size={22} aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs text-[var(--color-text-secondary)]">{t('contact.website')}</p>
            <p className="font-bold text-[var(--color-text)] group-hover:text-[var(--color-info)] transition-colors">parqueen.app</p>
          </div>
        </a>
      </div>
    </div>
  );
};
