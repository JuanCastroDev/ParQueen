import React, { useState, useEffect, useCallback } from 'react';
import { Navigation, Info } from 'lucide-react';
import { LocationPromptArtwork } from './LocationPromptArtwork';
import './locationPrompt.css';
import { t, useLang } from '../i18n';
import { readPersistedAccess, reconcileLocationAccess } from '../utils/locationAccess';
import { checkLocationPermission, requestLocationPermission } from '../utils/geolocation';
import { resolveGeolocationPath } from '../utils/geolocationPlatform';

interface LocationPromptViewProps {
    onComplete: (access: 'granted' | 'declined' | 'denied') => void;
    /** Authenticated Android visual preview: never read or request OS permissions. */
    previewMode?: boolean;
}

export const LocationPromptView: React.FC<LocationPromptViewProps> = ({ onComplete, previewMode = false }) => {
    useLang();
    const [requesting, setRequesting] = useState(false);
    const [hint, setHint] = useState<'services_off' | 'try_again' | null>(null);

    // Skip the primer when OS / browser permission is already resolved.
    useEffect(() => {
        if (previewMode) return;
        let cancelled = false;
        checkLocationPermission()
            .then((snap) => {
                if (cancelled) return;
                const resolved = reconcileLocationAccess(snap.status, readPersistedAccess(), resolveGeolocationPath());
                if (resolved === 'granted') onComplete('granted');
                else if (resolved === 'denied') onComplete('denied');
            })
            .catch(() => {
                // Unavailable — show the primer normally
            });
        return () => { cancelled = true; };
    }, [onComplete, previewMode]);

    const handleEnable = useCallback(async () => {
        if (previewMode) { onComplete('declined'); return; }
        if (requesting) return;
        setRequesting(true);
        setHint(null);
        try {
            const snap = await requestLocationPermission();
            if (snap.locationServicesEnabled === false) {
                setHint('services_off');
                return;
            }
            if (snap.status === 'granted') {
                onComplete('granted');
                return;
            }
            if (snap.status === 'denied') {
                onComplete('denied');
                return;
            }
            setHint('try_again');
        } catch {
            setHint('try_again');
        } finally {
            setRequesting(false);
        }
    }, [requesting, onComplete, previewMode]);

    const handleSkip = useCallback(() => {
        onComplete('declined');
    }, [onComplete]);

    return (
        <div className="pq-location-screen" data-testid="location-permission-screen">
            <div className="pq-location-hero">
                <LocationPromptArtwork description={t('location_prompt.map_desc')} />
                <div className="pq-location-hero-legend" aria-hidden="true">
                    <span className="pq-location-legend-dot" />
                    <span>{t('location_prompt.you_label')}</span>
                    <span className="pq-location-legend-separator" />
                    <span className="pq-location-legend-ping" />
                    <span>{t('location_prompt.pings_label')}</span>
                </div>
            </div>

            <section className="pq-location-content" aria-labelledby="pq-location-heading">
                <p className="pq-location-eyebrow">{t('location_prompt.eyebrow')}</p>
                <h1 id="pq-location-heading" className="pq-location-heading">
                    {t('location_prompt.headline')} <span>{t('location_prompt.headline_accent')}</span>
                </h1>
                <p className="pq-location-description">{t('location_prompt.body')}</p>

                {hint && (
                    <p role="status" aria-live="polite" className="pq-location-hint">
                        <Info size={17} aria-hidden="true" />
                        <span>{hint === 'services_off' ? t('location_prompt.services_off') : t('location_prompt.try_again')}</span>
                    </p>
                )}

                <div className="pq-location-actions">
                    <button
                        type="button"
                        className="pq-location-enable"
                        onClick={handleEnable}
                        disabled={requesting}
                        aria-busy={requesting}
                    >
                        <Navigation size={20} aria-hidden="true" />
                        {requesting ? t('location_prompt.requesting') : t('location_prompt.enable')}
                    </button>
                    <button
                        type="button"
                        className="pq-location-skip"
                        onClick={handleSkip}
                        disabled={requesting}
                    >
                        {t('location_prompt.skip')}
                    </button>
                </div>
                <p className="pq-location-reassurance">
                    <Info size={15} aria-hidden="true" />
                    <span>{t('location_prompt.reassurance')}</span>
                </p>
            </section>
        </div>
    );
};
