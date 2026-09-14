import React, { useState } from 'react';
import { ChevronLeft, MapPin, Navigation } from 'lucide-react';
import { t, useLang } from '../i18n';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { locationPermissionCTAKind, type LocationPermissionState, type LocationCallbacks } from '../utils/nearbyActivity';

interface LocationSettingsViewProps {
    user: any;
    onBack: () => void;
    permissionState: LocationPermissionState;
    callbacks: LocationCallbacks;
}

const Toggle = ({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) => (
    <button
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        role="switch"
        aria-label={label}
        aria-checked={checked}
        className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-40 ${checked ? 'bg-[var(--color-brand)]' : 'bg-[var(--color-border)]'}`}
    >
        <div className={`absolute top-0.5 left-[2px] w-5 h-5 rounded-full shadow transition-transform ${checked ? 'translate-x-5 bg-white' : 'bg-white dark:bg-gray-300'}`} />
    </button>
);

function permissionStatusLabel(state: LocationPermissionState): string {
    switch (state) {
        case 'granted': return t('settings.location_allowed');
        case 'not_determined': return t('settings.location_not_enabled');
        case 'denied_requestable': return t('settings.location_not_allowed');
        case 'permanently_blocked': return t('settings.location_blocked');
        case 'services_disabled': return t('settings.location_services_off');
    }
}

function permissionCTA(state: LocationPermissionState, callbacks: LocationCallbacks): { label: string; action: () => void } | null {
    switch (locationPermissionCTAKind(state, callbacks)) {
        case 'enable':
            return { label: t('settings.location_enable'), action: callbacks.requestLocationPermission };
        case 'openSettings':
            return { label: t('settings.location_open_settings'), action: callbacks.openAppSettings };
        case 'openLocationServices':
            return { label: t('settings.location_open_settings'), action: callbacks.openLocationServicesSettings };
        case 'recheck':
            return { label: t('settings.location_check_again'), action: callbacks.recheckPermission };
        case null:
            return null;
    }
}

export const LocationSettingsView: React.FC<LocationSettingsViewProps> = ({ user, onBack, permissionState, callbacks }) => {
    useLang();
    const [precise, setPrecise] = useState<boolean>(user?.sharePreciseLocation ?? true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const handlePrecise = async (v: boolean) => {
        setPrecise(v);
        if (!user?.id) return;
        setSaving(true);
        setError('');
        try {
            await updateDoc(doc(db, 'users', user.id, 'private', 'preferences'), { sharePreciseLocation: v });
        } catch {
            setPrecise(!v);
            setError(t('settings.pref_save_error'));
        } finally {
            setSaving(false);
        }
    };

    const cta = permissionCTA(permissionState, callbacks);
    const isGranted = permissionState === 'granted';

    return (
        <div className="min-h-full bg-[var(--color-bg)] text-[var(--color-text)] pt-4 pb-20 px-4">
            <div className="max-w-md mx-auto flex flex-col">

                {/* Header */}
                <div className="flex items-center justify-between mb-4">
                    <button onClick={onBack} aria-label={t('settings.location_settings_back_aria')} className="w-10 h-10 rounded-full flex items-center justify-center bg-white/5 border border-[var(--color-border)] text-[var(--color-text)] hover:bg-white/10 active:scale-95 transition-all shrink-0">
                        <ChevronLeft size={20} />
                    </button>
                    <h2 className="text-xl font-bold text-[var(--color-text)] tracking-wide">{t('settings.location_settings_title')}</h2>
                    <div className="w-10" />
                </div>

                <div className="space-y-3">

                    {/* Location Access */}
                    <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
                        <div className="px-4 pt-3.5 pb-2 border-b border-[var(--color-border)]">
                            <p className="text-xs font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">{t('settings.location_access_section')}</p>
                        </div>
                        <div className="p-4 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3.5 min-w-0">
                                <div className="bg-[#1e75ff]/10 p-2.5 rounded-xl text-[var(--color-info)] shrink-0"><MapPin size={18} /></div>
                                <div className="min-w-0">
                                    <h3 className="font-bold text-[var(--color-text)] text-sm">{t('settings.location')}</h3>
                                    <p className={`text-xs mt-0.5 ${isGranted ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'}`}>{permissionStatusLabel(permissionState)}</p>
                                </div>
                            </div>
                            {cta && (
                                <button onClick={cta.action} className="shrink-0 text-xs font-bold text-[var(--color-info)] hover:text-[#60caff] transition-colors active:scale-95">
                                    {cta.label}
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Detection Preference */}
                    <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
                        <div className="px-4 pt-3.5 pb-2 border-b border-[var(--color-border)]">
                            <p className="text-xs font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">{t('settings.location_preference_section')}</p>
                        </div>
                        <div className="p-4">
                            <div className="flex items-center justify-between gap-3 mb-3">
                                <div className="flex items-center gap-3.5 min-w-0">
                                    <div className="bg-[#1e75ff]/10 p-2.5 rounded-xl text-[var(--color-info)] shrink-0"><Navigation size={18} /></div>
                                    <h3 className="font-bold text-[var(--color-text)] text-sm">{t('settings.precise_location')}</h3>
                                </div>
                                <Toggle checked={precise} onChange={handlePrecise} disabled={saving} label={t('settings.precise_location')} />
                            </div>
                            <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">{t('settings.location_precise_description')}</p>
                        </div>
                    </div>

                    {error && <p className="text-[var(--color-danger)] text-xs px-1">{error}</p>}
                </div>
            </div>
        </div>
    );
};
