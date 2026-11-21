import React, { useState, useEffect, useCallback, type CSSProperties } from 'react';
import { Info, LocateFixed, Settings } from 'lucide-react';
import Logo from '../assets/Parqueen_Logo.png';
import { LocationNeighborhoodArt } from './location-prompt/LocationNeighborhoodArt';
import { PARQUEEN_MARK_PATH, PARQUEEN_MARK_TRANSFORM, PIN_PATH, PIN_VIEWBOX } from './street-parking/parqueenMark';
import './location-prompt/locationPrompt.css';
import { t, useLang } from '../i18n';
import { readPersistedAccess, reconcileLocationAccess } from '../utils/locationAccess';
import { checkLocationPermission, requestLocationPermission } from '../utils/geolocation';
import { resolveGeolocationPath } from '../utils/geolocationPlatform';

interface LocationPromptViewProps {
    onComplete: (access: 'granted' | 'declined' | 'denied') => void;
    /** Authenticated Android visual preview: never read or request OS permissions. */
    previewMode?: boolean;
}

/** Staggered entrance order for the panel's children (CSS reads --d; reduced motion ignores it). */
const rise = (d: number) => ({ '--d': d } as CSSProperties);

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
        <div className="pq-loc" data-testid="location-permission-screen">
            <div className="pq-loc-hero">
                <LocationNeighborhoodArt label={t('location_prompt.map_desc')} />

                <div className="pq-loc-brand" aria-hidden="true">
                    <img src={Logo} alt="" draggable={false} />
                    <span>ParQueen</span>
                </div>

                <div className="pq-loc-legend" aria-hidden="true">
                    <span className="pq-loc-legend-item">
                        <span className="pq-loc-legend-dot" />
                        {t('location_prompt.you_label')}
                    </span>
                    <span className="pq-loc-legend-rule" />
                    <span className="pq-loc-legend-item">
                        <svg className="pq-loc-legend-pin" viewBox={PIN_VIEWBOX} focusable="false">
                            <path d={PIN_PATH} fill="#1e75ff" />
                            <g transform={PARQUEEN_MARK_TRANSFORM}><path d={PARQUEEN_MARK_PATH} fill="#fff" fillRule="evenodd" /></g>
                        </svg>
                        {t('location_prompt.pings_label')}
                    </span>
                </div>
            </div>

            <section className="pq-loc-panel" aria-labelledby="pq-loc-heading">
                <p className="pq-loc-eyebrow pq-loc-rise" style={rise(0)}>
                    <LocateFixed aria-hidden="true" />
                    <span>{t('location_prompt.eyebrow')}</span>
                </p>
                <h1 id="pq-loc-heading" className="pq-loc-title pq-loc-rise" style={rise(1)}>
                    {t('location_prompt.headline')}{' '}
                    <span className="pq-loc-title-accent">{t('location_prompt.headline_accent')}</span>
                </h1>
                <p className="pq-loc-body pq-loc-rise" style={rise(2)}>{t('location_prompt.body')}</p>

                <div className="pq-loc-status" aria-live="polite">
                    {hint && (
                        <p className="pq-loc-hint">
                            <Info aria-hidden="true" />
                            <span>{hint === 'services_off' ? t('location_prompt.services_off') : t('location_prompt.try_again')}</span>
                        </p>
                    )}
                </div>

                <div className="pq-loc-actions pq-loc-rise" style={rise(3)}>
                    <button
                        type="button"
                        className="pq-loc-enable"
                        onClick={handleEnable}
                        disabled={requesting}
                        aria-busy={requesting}
                    >
                        <LocateFixed aria-hidden="true" />
                        <span>{requesting ? t('location_prompt.requesting') : t('location_prompt.enable')}</span>
                    </button>
                    <button
                        type="button"
                        className="pq-loc-skip"
                        onClick={handleSkip}
                        disabled={requesting}
                    >
                        {t('location_prompt.skip')}
                    </button>
                </div>

                <p className="pq-loc-reassurance pq-loc-rise" style={rise(4)}>
                    <Settings aria-hidden="true" />
                    <span>{t('location_prompt.reassurance')}</span>
                </p>
            </section>
        </div>
    );
};
