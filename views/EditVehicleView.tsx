import React, { useState, useRef, useMemo, useEffect } from 'react';
import { useFocusOnMount } from '../hooks/useFocusOnMount';
import { SignupProgress } from '../components/SignupProgress';
import { ChevronLeft, ChevronRight, Search, X, Trash2, Check, Loader2 } from 'lucide-react';
import { VehicleIcon } from '../utils/vehicleIcon';
import { doc, updateDoc, deleteField } from 'firebase/firestore';
import { db } from '../firebase';
import { t, useLang } from '../i18n';
import { TYPES } from '../utils/vehicleTypes';
export type { VehicleType } from '../utils/vehicleTypes';

// Evaluated once at module load — same pattern as NameEntryView / LocationPromptView
const prefersReduced =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─── Brand Data ──────────────────────────────────────────────────────────────

const ALL_BRANDS = [
  'Acura','Alfa Romeo','Aston Martin','Audi','Bentley','BMW','Bugatti','Buick',
  'Cadillac','Chevrolet','Chrysler','Citroën','Dodge','Ferrari','Fiat','Ford',
  'Genesis','GMC','Honda','Hyundai','Infiniti','Jaguar','Jeep','Kia',
  'Koenigsegg','Lamborghini','Land Rover','Lexus','Lincoln','Lotus','Lucid',
  'Maserati','Mazda','McLaren','Mercedes-Benz','Mini','Mitsubishi','Nissan',
  'Peugeot','Polestar','Porsche','Ram','Renault','Rivian','Rolls-Royce',
  'Subaru','Suzuki','Tesla','Toyota','Volkswagen','Volvo',
];

// Sentinel stored only in component state — never written to Firestore.
// When selected, the trimmed customBrandText value is saved instead.
const CUSTOM_BRAND_KEY = '__custom__';

// Case/whitespace-fold for duplicate detection — never used for storage.
const normalizeForMatch = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// ─── Color Data ───────────────────────────────────────────────────────────────

const COLORS: { name: string; hex: string }[] = [
  { name: 'Black',  hex: '#1C1C1E' },
  { name: 'White',  hex: '#F2F2F7' },
  { name: 'Silver', hex: '#AEAEB2' },
  { name: 'Gray',   hex: '#636366' },
  { name: 'Blue',   hex: '#2563EB' },
  { name: 'Red',    hex: '#DC2626' },
  { name: 'Green',  hex: '#16A34A' },
  { name: 'Brown',  hex: '#7C3A1E' },
  { name: 'Beige',  hex: '#D4B896' },
  { name: 'Gold',   hex: '#D4AF37' },
  { name: 'Yellow', hex: '#EAB308' },
  { name: 'Orange', hex: '#EA580C' },
  { name: 'Purple', hex: '#7C3AED' },
  { name: 'Other',  hex: 'other'   }, // sentinel — rendered with conic-gradient
];

// Sentinel stored only in component state — never written to Firestore.
const CUSTOM_COLOR_KEY = '__custom__';

// Legacy Firestore values → nearest visible palette entry.
const LEGACY_COLOR_MAP: Record<string, string> = { 'Yellow Cab': 'Yellow', 'Uber Black': 'Black' };

const VISIBLE_COLOR_NAMES = new Set(COLORS.filter(c => c.name !== 'Other').map(c => c.name));

// Diacritic-insensitive fold for color matching only (marrón → marron, never used for storage).
const foldForColorMatch = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');

// Returns canonical palette name when custom text folds to any standard color.
// Matches against both English canonical names and the current locale's color labels,
// so Spanish "azul" → "Blue", accented "marrón" → "Brown", etc.
const findCanonicalColorMatch = (text: string): string | undefined => {
  const norm = foldForColorMatch(text);
  if (!norm) return undefined;
  const clabels = colorLabels();
  for (const name of VISIBLE_COLOR_NAMES) {
    if (foldForColorMatch(name) === norm) return name;
    const label = clabels[name];
    if (label && foldForColorMatch(label) === norm) return name;
  }
  return undefined;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const colorLabels = () => ({
  Black:  t('vehicle.color_black'),  White:  t('vehicle.color_white'),
  Silver: t('vehicle.color_silver'), Gray:   t('vehicle.color_gray'),
  Blue:   t('vehicle.color_blue'),   Red:    t('vehicle.color_red'),
  Green:  t('vehicle.color_green'),  Brown:  t('vehicle.color_brown'),
  Beige:  t('vehicle.color_beige'),  Gold:   t('vehicle.color_gold'),
  Yellow: t('vehicle.color_yellow'), Orange: t('vehicle.color_orange'),
  Purple: t('vehicle.color_purple'), Other:  t('vehicle.color_other'),
} as Record<string, string>);

const typeLabels = () => ({
  Sedan:        t('vehicle.type_sedan'),
  Compact:      t('vehicle.type_compact'),
  SUV:          t('vehicle.type_suv'),
  Hatchback:    t('vehicle.type_hatchback'),
  Coupe:        t('vehicle.type_coupe'),
  'Pickup Truck': t('vehicle.type_pickup_truck'),
  Van:          t('vehicle.type_van'),
  Minivan:      t('vehicle.type_minivan'),
  Wagon:        t('vehicle.type_wagon'),
  Convertible:  t('vehicle.type_convertible'),
} as Record<string, string>);

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  user: any;
  onBack: () => void;
  isOnboarding?: boolean;
  onSkip?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const EditVehicleView = ({ user, onBack, isOnboarding, onSkip }: Props) => {
  useLang();

  // If the stored brand isn't in the listed set it was previously custom-entered.
  const isInitCustom = !!user?.vehicleBrand && !ALL_BRANDS.includes(user.vehicleBrand);

  const [vehicleType,     setVehicleType]     = useState<string>(user?.vehicleType  || '');
  const [vehicleBrand,    setVehicleBrand]    = useState<string>(
    isInitCustom ? CUSTOM_BRAND_KEY : (user?.vehicleBrand || '')
  );
  // Text entered when "Brand not listed" is selected; persists if user navigates back
  const [customBrandText, setCustomBrandText] = useState<string>(
    isInitCustom ? (user?.vehicleBrand || '') : ''
  );
  // Map legacy Firestore values to visible palette; detect custom text.
  const _rawColor = user?.vehicleColor || '';
  const _mappedColor = LEGACY_COLOR_MAP[_rawColor] ?? _rawColor;
  const isInitCustomColor = !!_mappedColor && !VISIBLE_COLOR_NAMES.has(_mappedColor);
  const [vehicleColor,    setVehicleColor]    = useState<string>(isInitCustomColor ? CUSTOM_COLOR_KEY : _mappedColor);
  const [customColorText, setCustomColorText] = useState<string>(isInitCustomColor ? _mappedColor : '');
  // colorTouched: user interacted with the color section (needed to distinguish "no change" from "cleared")
  // colorCleared: user explicitly pressed "Remove color"
  const [colorTouched,    setColorTouched]    = useState(false);
  const [colorCleared,    setColorCleared]    = useState(false);
  const [brandSearch,  setBrandSearch]  = useState('');
  const [saving,       setSaving]       = useState(false);
  const [showSkip,     setShowSkip]     = useState(false);
  const [done,         setDone]         = useState(false);
  const [savedPartial, setSavedPartial] = useState(false);

  const headingRef     = useRef<HTMLHeadingElement>(null);
  const customBrandRef = useRef<HTMLInputElement>(null);
  const customColorRef = useRef<HTMLInputElement>(null);
  useFocusOnMount(headingRef);

  // Focus the custom-brand input when "Brand not listed" is newly selected
  useEffect(() => {
    if (vehicleBrand === CUSTOM_BRAND_KEY) {
      const id = setTimeout(() => customBrandRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [vehicleBrand]);

  // Focus the custom-color input when "Other" is newly selected
  useEffect(() => {
    if (vehicleColor === CUSTOM_COLOR_KEY) {
      const id = setTimeout(() => customColorRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [vehicleColor]);

  // Resume at first missing step (onboarding only); editing always starts at 0
  const startStep = isOnboarding
    ? (!user?.vehicleType ? 0 : !user?.vehicleBrand ? 1 : !user?.vehicleColor ? 2 : 0)
    : 0;
  const [step, setStep] = useState(startStep);

  const clabels = colorLabels();
  const tlabels = typeLabels();

  // Filtered brand list — never mutates ALL_BRANDS
  const filteredBrands = useMemo(() => {
    const q = brandSearch.trim().toLowerCase();
    return q ? ALL_BRANDS.filter(b => b.toLowerCase().includes(q)) : ALL_BRANDS;
  }, [brandSearch]);

  // ── Save helpers ──

  const saveField = async (fields: Record<string, string>) => {
    if (!user?.id) return;
    await updateDoc(doc(db, 'users', user.id), fields);
  };

  const handleNextFromType = async () => {
    if (!vehicleType || saving) return;
    setSaving(true);
    await saveField({ vehicleType });
    setSaving(false);
    setStep(1);
  };

  const handleNextFromBrand = async () => {
    if (saving) return;
    let brandToSave: string;
    if (vehicleBrand === CUSTOM_BRAND_KEY) {
      const trimmed = customBrandText.trim();
      // Auto-promote to canonical if the text matches a listed brand
      const canonical = ALL_BRANDS.find(b => normalizeForMatch(b) === normalizeForMatch(trimmed));
      brandToSave = canonical ?? trimmed;
    } else {
      brandToSave = vehicleBrand;
    }
    if (!brandToSave) return;
    setSaving(true);
    await saveField({ vehicleBrand: brandToSave });
    setSaving(false);
    setStep(2);
  };

  const handleSaveWithColor = async () => {
    if (!user?.id) return;
    setSaving(true);

    // Build update payload. Four cases:
    // A. No prior color and user didn't touch color → omit field entirely
    // B. Prior color unchanged (non-legacy) → omit field (Firestore preserves it)
    // C. User intentionally removed color → deleteField()
    // D. User selected a color → write canonical or custom text

    const payload: Record<string, unknown> = {};

    if (!colorTouched) {
      // Case A / B: user didn't interact with the color section
      const raw = user?.vehicleColor || '';
      const legacyNorm = LEGACY_COLOR_MAP[raw];
      if (legacyNorm) {
        // Legacy value: normalize on save (Yellow Cab → Yellow, Uber Black → Black)
        payload.vehicleColor = legacyNorm;
      }
      // else: non-legacy unchanged — omit (no write)
    } else if (colorCleared || (!vehicleColor && vehicleColor !== CUSTOM_COLOR_KEY)) {
      // Case C: intentional removal or deselect of previously existing color
      if (user?.vehicleColor) payload.vehicleColor = deleteField();
      // if no prior color, nothing to delete — omit
    } else if (vehicleColor === CUSTOM_COLOR_KEY) {
      // Case D (custom): auto-promote to canonical if text matches a palette name
      const trimmed = customColorText.trim();
      const canonical = findCanonicalColorMatch(trimmed);
      payload.vehicleColor = canonical ?? trimmed;
    } else {
      // Case D (standard): write the selected palette name
      payload.vehicleColor = vehicleColor;
    }

    if (Object.keys(payload).length > 0) {
      await updateDoc(doc(db, 'users', user.id), payload);
    }

    setSaving(false);
    setDone(true);
    setSavedPartial(false);
  };

  const handleClearVehicle = async () => {
    if (!user?.id) return;
    await updateDoc(doc(db, 'users', user.id), {
      vehicleType: '', vehicleBrand: '', vehicleColor: '',
    });
    setVehicleType(''); setVehicleBrand(''); setVehicleColor('');
    setStep(0);
  };

  // ── Skip interstitial ──

  if (showSkip) {
    return (
      <div className="min-h-full bg-[var(--color-bg)] text-[var(--color-text)] flex flex-col items-center justify-center px-6 py-12 gap-6 text-center">
        <div className="text-5xl">🚗</div>
        <div>
          <h2 className="text-xl font-bold mb-2">{t('vehicle.skip_title')}</h2>
          <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed max-w-xs">
            {t('vehicle.skip_body')}
          </p>
        </div>
        <button
          onClick={() => { onSkip?.(); }}
          className="w-full max-w-xs py-3.5 rounded-xl bg-white/8 border border-[var(--color-border)] text-[var(--color-text)] font-semibold text-sm active:scale-[0.98] transition-all"
        >
          {t('vehicle.skip_confirm')}
        </button>
        <button
          onClick={() => setShowSkip(false)}
          className="text-sm font-semibold text-[var(--color-info)] active:opacity-70 transition-opacity"
        >
          {t('vehicle.skip_back')}
        </button>
      </div>
    );
  }

  // ── Done screen ──

  if (done) {
    return (
      <div className="min-h-full bg-[var(--color-bg)] text-[var(--color-text)] flex flex-col items-center justify-center px-6 py-12 gap-6 text-center">
        <div className="w-20 h-20 rounded-[22px] flex items-center justify-center shrink-0"
          style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-2))' }}>
          <VehicleIcon type={vehicleType} color={vehicleColor} size={36} />
        </div>
        <div>
          <h2 className="text-xl font-bold mb-2">
            {savedPartial ? t('vehicle.done_partial_title') : t('vehicle.done_title')}
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed max-w-xs">
            {savedPartial ? t('vehicle.done_partial_body') : t('vehicle.done_body')}
          </p>
        </div>
        <button
          onClick={onBack}
          className="w-full max-w-xs py-3.5 rounded-xl bg-[var(--color-brand)] text-white font-bold text-sm active:scale-[0.98] transition-all"
        >
          {t('vehicle.continue')}
        </button>
      </div>
    );
  }

  // ── Skip handler ──

  const handleSkip = () => {
    if (onSkip) setShowSkip(true);
    else onBack();
  };

  // ── Vehicle substep indicator ──

  const SubstepIndicator = () => {
    const counts = [
      t('vehicle.substep_count_type'),
      t('vehicle.substep_count_brand'),
      t('vehicle.substep_count_color'),
    ];
    const stages = [
      t('vehicle.stage_type'),
      t('vehicle.brand_label'),
      t('vehicle.color_label'),
    ];
    return (
      <div className="flex flex-col items-center gap-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-bold tracking-[0.1em] uppercase text-[var(--color-text-secondary)] whitespace-nowrap">
            {t('vehicle.eyebrow')}
          </span>
          <span className="text-[9px] text-[var(--color-text-secondary)] mx-0.5" aria-hidden="true">·</span>
          <span className="text-[9px] font-semibold text-[var(--color-text-secondary)] whitespace-nowrap">
            {counts[step]}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {stages.map((stage, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="text-[8px] text-[var(--color-text-secondary)]" aria-hidden="true">·</span>}
              <span
                aria-current={i === step ? 'step' : undefined}
                className={`text-[10px] transition-colors duration-200 ${
                  i === step ? 'font-bold text-[var(--color-text)]' : 'font-semibold text-[var(--color-text-secondary)]'
                }`}
              >
                {stage}
              </span>
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  };

  // ── Shared header ──

  const Header = () => (
    <div>
      {isOnboarding && (
        <>
          <div className="flex items-center justify-between mb-3">
            <div className="w-11 h-11" aria-hidden="true" />
            <span className="text-[12px] font-semibold text-[var(--color-text-secondary)] tracking-wide">
              {t('vehicle.step')}
            </span>
          </div>
          <SignupProgress step={4} />
        </>
      )}
      <div className="flex items-center gap-2 mb-5">
        <button
          onClick={step === 0 ? onBack : () => setStep(s => s - 1)}
          aria-label={t('vehicle.back')}
          className="w-11 h-11 rounded-full flex items-center justify-center bg-white/5 border border-[var(--color-border)] text-[var(--color-text)] active:scale-95 transition-all shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <ChevronLeft size={20} />
        </button>
        <div className="flex-1 flex justify-center">
          <SubstepIndicator />
        </div>
        {step !== 2 ? (
          <button
            onClick={handleSkip}
            aria-label={t('vehicle.skip_for_now')}
            className="min-h-[44px] min-w-[44px] flex items-center justify-end px-1 text-[13px] font-semibold text-[var(--color-text-secondary)] active:opacity-60 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-lg"
          >
            {t('vehicle.skip_for_now')}
          </button>
        ) : (
          <div className="w-11 h-11" aria-hidden="true" />
        )}
      </div>
    </div>
  );

  // ═══════════════════════════════════════════
  // STEP 0 — Vehicle Type
  // ═══════════════════════════════════════════

  if (step === 0) {
    return (
      <div className="h-full bg-[var(--color-bg)] text-[var(--color-text)] flex flex-col px-4 pt-10">
        <div className="max-w-md mx-auto w-full flex-1 flex flex-col min-h-0">
          <Header />

          {/* Scrollable body — grid must not be obscured by the bottom button */}
          <div className="flex-1 overflow-y-auto min-h-0">

            {/* Text block */}
            <div className={prefersReduced ? '' : 'auth-fade-in'}>
              <p className="text-[11px] font-bold tracking-[0.13em] text-[var(--color-accent)] uppercase mb-3 mt-2">
                {t('vehicle.eyebrow')}
              </p>
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="text-[26px] font-bold text-[var(--color-text)] leading-tight mb-2 focus:outline-none"
              >
                {t('vehicle.headline_type')}
              </h2>
              <p className="text-[15px] text-[var(--color-text-secondary)] leading-relaxed mb-8">
                {t('vehicle.supporting_type')}
              </p>
            </div>

            {/* Vehicle type radio group */}
            <div
              role="radiogroup"
              aria-label={t('vehicle.headline_type')}
              className="grid grid-cols-3 gap-3 pb-6 [&>*:last-child]:col-start-2"
            >
              {TYPES.map((typeName, i) => {
                const active = vehicleType === typeName;
                return (
                  <button
                    key={typeName}
                    id={`vehicle-type-${typeName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                    role="radio"
                    aria-checked={active}
                    onClick={() => setVehicleType(typeName)}
                    className={`relative flex flex-col items-center gap-2 py-4 px-2 rounded-2xl border transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                      active
                        ? 'bg-[#0f2044] border-[#1e75ff] shadow-[0_0_0_1px_rgba(30,117,255,0.10)]'
                        : 'pq-choice-tile'
                    } ${prefersReduced ? '' : 'auth-fade-in'}`}
                    style={prefersReduced ? {} : { animationDelay: `${50 + i * 25}ms` }}
                  >
                    {/* Checkmark badge — top-right, not color-only selection indicator */}
                    {active && (
                      <div
                        className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[var(--color-brand)] flex items-center justify-center pointer-events-none"
                        aria-hidden="true"
                      >
                        <Check size={9} className="text-white" strokeWidth={3} />
                      </div>
                    )}
                    {/* Icon: colored blue when selected, neutral when not */}
                    <VehicleIcon type={typeName} color={active ? 'Blue' : undefined} size={32} />
                    <span className={`text-[11px] font-semibold text-center leading-tight ${
                      active ? 'text-white' : 'text-[var(--color-text-secondary)]'
                    }`}>
                      {tlabels[typeName] ?? typeName}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Bottom action area — anchored above safe area, never obscures grid */}
          <div
            className={`pt-3 pb-8 ${prefersReduced ? '' : 'auth-fade-in'}`}
            style={{
              borderTop: '1px solid rgba(255,255,255,0.06)',
              ...(prefersReduced ? {} : { animationDelay: '350ms' }),
            }}
          >
            <button
              onClick={handleNextFromType}
              disabled={!vehicleType || saving}
              aria-disabled={!vehicleType || saving}
              className={`w-full h-[58px] rounded-full font-semibold text-[16px] flex items-center justify-center gap-2 transition-all duration-200 ${
                vehicleType && !saving
                  ? 'text-white active:scale-[0.985]'
                  : 'bg-[#111827] text-white/30'
              }`}
              style={vehicleType && !saving
                ? { background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }
                : {}}
            >
              {saving
                ? <Loader2 size={18} className="animate-spin text-white/50" />
                : <>{t('vehicle.next')} <ChevronRight size={18} /></>
              }
            </button>

            {/* Remove vehicle option — editing from profile only */}
            {!isOnboarding && (user?.vehicleType || user?.vehicleBrand) && (
              <button
                onClick={handleClearVehicle}
                className="mt-3 w-full py-3 flex items-center justify-center gap-2 text-sm font-semibold text-[var(--color-danger)] active:opacity-70 transition-opacity"
              >
                <Trash2 size={14} /> {t('vehicle.remove')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // STEP 1 — Brand
  // ═══════════════════════════════════════════

  if (step === 1) {
    // Next is valid when a listed brand is chosen, or custom brand has non-empty text
    const brandValid = vehicleBrand !== '' &&
      (vehicleBrand !== CUSTOM_BRAND_KEY || customBrandText.trim().length > 0);

    // Whether the selected listed brand is hidden by the current search query
    const selectedFilteredOut =
      brandSearch.trim() !== '' &&
      vehicleBrand !== '' &&
      vehicleBrand !== CUSTOM_BRAND_KEY &&
      !filteredBrands.includes(vehicleBrand);

    // Canonical brand matching the custom text (case/whitespace-insensitive)
    const canonicalMatch =
      vehicleBrand === CUSTOM_BRAND_KEY && customBrandText.trim()
        ? ALL_BRANDS.find(b => normalizeForMatch(b) === normalizeForMatch(customBrandText))
        : undefined;

    return (
      <div className="h-full bg-[var(--color-bg)] text-[var(--color-text)] flex flex-col px-4 pt-10">
        <div className="max-w-md mx-auto w-full flex-1 flex flex-col min-h-0">
          <Header />

          {/* Text block */}
          <div className={`shrink-0 ${prefersReduced ? '' : 'auth-fade-in'}`}>
            <p className="text-[11px] font-bold tracking-[0.13em] text-[var(--color-accent)] uppercase mb-3 mt-2">
              {t('vehicle.eyebrow')}
            </p>
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="text-[26px] font-bold text-[var(--color-text)] leading-tight mb-2 focus:outline-none"
            >
              {t('vehicle.headline_brand')}
            </h2>
            <p className="text-[15px] text-[var(--color-text-secondary)] leading-relaxed mb-5">
              {t('vehicle.supporting_brand')}
            </p>
          </div>

          {/* Scrollable content — search + brand list card */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">

            {/* Search bar */}
            <div
              className={`relative mb-2.5 shrink-0 ${prefersReduced ? '' : 'auth-fade-in'}`}
              style={prefersReduced ? {} : { animationDelay: '80ms' }}
            >
              <label htmlFor="brand-search" className="sr-only">
                {t('vehicle.search_placeholder')}
              </label>
              <Search
                size={15}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="brand-search"
                type="search"
                value={brandSearch}
                onChange={e => setBrandSearch(e.target.value)}
                placeholder={t('vehicle.search_placeholder')}
                autoComplete="off"
                className="w-full pl-9 pr-10 py-3 rounded-xl bg-[var(--color-card)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder-[var(--color-text-secondary)] focus:outline-none focus:border-[#1e75ff]/50 transition-colors"
              />
              {brandSearch && (
                <button
                  onClick={() => setBrandSearch('')}
                  aria-label={t('vehicle.search_clear')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text)] active:opacity-60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Brand list card — semantic radio group */}
            <div
              role="radiogroup"
              aria-label={t('vehicle.headline_brand')}
              className={`flex-1 min-h-0 flex flex-col rounded-2xl overflow-hidden ${prefersReduced ? '' : 'auth-fade-in'}`}
              style={{
                background: 'var(--color-card)',
                border: '1px solid rgba(255,255,255,0.07)',
                ...(prefersReduced ? {} : { animationDelay: '130ms' }),
              }}
            >
              {/* Scrollable brand rows */}
              <div className="flex-1 overflow-y-auto divide-y divide-white/[0.05] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:bg-white/10">

                {/* Pinned selected brand — visible when search hides the selection */}
                {selectedFilteredOut && (
                  <>
                    <div className="px-4 pt-2 pb-1 text-[10px] font-bold tracking-[0.1em] uppercase text-[var(--color-text-secondary)]">
                      {t('vehicle.selected_brand_label')}
                    </div>
                    <button
                      role="radio"
                      aria-checked={true}
                      onClick={() => setVehicleBrand(vehicleBrand)}
                      className="w-full flex items-center gap-3 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 border-l-2 bg-[#0f2044] border-l-[#1e75ff] pl-[14px] pr-4"
                    >
                      <span className="text-[14px] font-semibold flex-1 min-w-0 text-white">
                        {vehicleBrand}
                      </span>
                      <Check size={14} className="text-[var(--color-accent)] shrink-0" aria-hidden="true" />
                    </button>
                    {filteredBrands.length > 0 && (
                      <div className="px-4 pt-2 pb-1 text-[10px] font-bold tracking-[0.1em] uppercase text-[var(--color-text-secondary)]">
                        {t('vehicle.search_results_label')}
                      </div>
                    )}
                  </>
                )}

                {filteredBrands.length > 0
                  ? filteredBrands.map(b => {
                      const active = vehicleBrand === b;
                      return (
                        <button
                          key={b}
                          id={`vehicle-brand-${b.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                          role="radio"
                          aria-checked={active}
                          onClick={() => setVehicleBrand(b)}
                          className={`w-full flex items-center gap-3 py-3 text-left transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 border-l-2 ${
                            active
                              ? 'bg-[#0f2044] border-l-[#1e75ff] pl-[14px] pr-4'
                              : 'hover:bg-white/[0.04] border-l-transparent px-4'
                          }`}
                        >
                          <span className={`text-[14px] font-semibold flex-1 min-w-0 ${
                            active ? 'text-white' : 'text-[var(--color-text-secondary)]'
                          }`}>
                            {b}
                          </span>
                          {active && (
                            <Check size={14} className="text-[var(--color-accent)] shrink-0" aria-hidden="true" />
                          )}
                        </button>
                      );
                    })
                  : (
                    /* No-results state — "Brand not listed" remains below */
                    <div className="px-5 py-6">
                      <p className="text-[14px] font-semibold text-[var(--color-text)] mb-1">
                        {t('vehicle.no_results_title')}
                      </p>
                      <p className="text-[13px] text-[var(--color-text-secondary)] leading-relaxed">
                        {t('vehicle.no_results_body')}
                      </p>
                    </div>
                  )
                }
                {/* Bottom breathing room */}
                <div className="h-2" aria-hidden="true" />
              </div>

              {/* Brand not listed — always visible, separated from scroll area */}
              <div className="shrink-0 border-t border-white/[0.07]">
                <button
                  role="radio"
                  aria-checked={vehicleBrand === CUSTOM_BRAND_KEY}
                  onClick={() => setVehicleBrand(CUSTOM_BRAND_KEY)}
                  className={`w-full flex items-center gap-3 py-3 text-left transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 border-l-2 ${
                    vehicleBrand === CUSTOM_BRAND_KEY
                      ? 'bg-[#0f2044] border-l-[#1e75ff] pl-[14px] pr-4'
                      : 'hover:bg-white/[0.04] border-l-transparent px-4'
                  }`}
                >
                  <span className={`text-[14px] font-semibold flex-1 ${
                    vehicleBrand === CUSTOM_BRAND_KEY
                      ? 'text-white'
                      : 'text-[var(--color-text-secondary)]'
                  }`}>
                    {t('vehicle.brand_not_listed')}
                  </span>
                  {vehicleBrand === CUSTOM_BRAND_KEY && (
                    <Check size={14} className="text-[var(--color-accent)] shrink-0" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            {/* Custom brand input — revealed when Brand not listed is selected */}
            {vehicleBrand === CUSTOM_BRAND_KEY && (
              <div className={`mt-2.5 shrink-0 ${prefersReduced ? '' : 'auth-fade-in'}`}>
                <label htmlFor="custom-brand" className="sr-only">
                  {t('vehicle.brand_not_listed')}
                </label>
                <input
                  id="custom-brand"
                  ref={customBrandRef}
                  type="text"
                  value={customBrandText}
                  onChange={e => setCustomBrandText(e.target.value)}
                  placeholder={t('vehicle.brand_custom_placeholder')}
                  maxLength={50}
                  autoComplete="off"
                  className="w-full px-4 py-3 rounded-xl bg-[var(--color-card)] border border-[#1e75ff]/40 text-sm text-[var(--color-text)] placeholder-[var(--color-text-secondary)] focus:outline-none focus:border-[#1e75ff]/70 transition-colors"
                />
                {/* Canonical match notice — prompt user to select the listed brand */}
                {canonicalMatch && (
                  <div className="mt-1.5 flex items-center gap-2 px-1">
                    <p className="text-[12px] text-[var(--color-text-secondary)] flex-1">
                      {t('vehicle.brand_already_listed')}{' '}
                      <span className="text-white font-semibold">{canonicalMatch}</span>
                    </p>
                    <button
                      onClick={() => { setVehicleBrand(canonicalMatch); setCustomBrandText(''); }}
                      className="text-[12px] text-[var(--color-accent)] font-semibold active:opacity-60 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1"
                    >
                      Select
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bottom action area — anchored above safe area */}
          <div
            className={`shrink-0 pt-3 pb-8 ${prefersReduced ? '' : 'auth-fade-in'}`}
            style={{
              borderTop: '1px solid rgba(255,255,255,0.06)',
              ...(prefersReduced ? {} : { animationDelay: '200ms' }),
            }}
          >
            <button
              onClick={handleNextFromBrand}
              disabled={!brandValid || saving}
              aria-disabled={!brandValid || saving}
              className={`w-full h-[58px] rounded-full font-semibold text-[16px] flex items-center justify-center gap-2 transition-all duration-200 ${
                brandValid && !saving
                  ? 'text-white active:scale-[0.985]'
                  : 'bg-[#111827] text-white/30'
              }`}
              style={brandValid && !saving
                ? { background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }
                : {}}
            >
              {saving
                ? <Loader2 size={18} className="animate-spin text-white/50" />
                : <>{t('vehicle.next')} <ChevronRight size={18} /></>
              }
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // STEP 2 — Color
  // ═══════════════════════════════════════════

  // Resolved brand for validation (mirrors handleNextFromBrand)
  const resolvedBrand = vehicleBrand === CUSTOM_BRAND_KEY ? customBrandText.trim() : vehicleBrand;

  // Canonical match: custom text folds to a standard palette name.
  // Computed before colorDisplayLabel so derived surfaces agree with what will be saved.
  const canonicalColorMatch =
    vehicleColor === CUSTOM_COLOR_KEY ? findCanonicalColorMatch(customColorText) : undefined;

  // All derived display surfaces use the canonical label when a match exists,
  // so preview and header agree with the value that will be persisted.
  const colorDisplayLabel =
    vehicleColor === CUSTOM_COLOR_KEY
      ? (canonicalColorMatch ? (clabels[canonicalColorMatch] ?? canonicalColorMatch) : (customColorText || null))
      : vehicleColor ? (clabels[vehicleColor] ?? vehicleColor)
      : null;

  // Save is valid when required fields exist AND color choice is complete
  const colorValid =
    vehicleType !== '' &&
    resolvedBrand !== '' &&
    (vehicleColor !== CUSTOM_COLOR_KEY || customColorText.trim() !== '');

  return (
    <div className="h-full bg-[var(--color-bg)] text-[var(--color-text)] flex flex-col px-4 pt-4">
      <div className="max-w-md mx-auto w-full flex-1 flex flex-col min-h-0">
        <Header />

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto min-h-0 pb-2">

          <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-bold mb-1 focus:outline-none">
            {t('vehicle.color_headline')}
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mb-5">
            {t('vehicle.color_supporting')}
          </p>

          {/* Live preview */}
          <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl px-4 py-4 flex items-center gap-3.5 mb-5">
            <VehicleIcon
              type={vehicleType}
              color={vehicleColor === CUSTOM_COLOR_KEY ? (canonicalColorMatch ?? customColorText) : vehicleColor}
              size={28}
            />
            <div>
              <p className="text-sm font-bold text-[var(--color-text)]">
                {[
                  colorDisplayLabel,
                  vehicleBrand === CUSTOM_BRAND_KEY ? customBrandText : vehicleBrand,
                ].filter(Boolean).join(' ')}
                {vehicleType ? <span className="text-[var(--color-text-secondary)] font-normal"> · {tlabels[vehicleType] ?? vehicleType}</span> : null}
              </p>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{t('vehicle.preview_label')}</p>
            </div>
          </div>

          {/* Color grid */}
          <div
            className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl overflow-hidden mb-4"
            role="radiogroup"
            aria-label={t('vehicle.color_label')}
          >
            <div className="px-4 pt-3.5 pb-2 border-b border-[var(--color-border)]">
              <p className="text-xs font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">
                {t('vehicle.color_label')}
                {colorDisplayLabel && (
                  <span className="ml-1.5 text-[var(--color-info)] normal-case font-semibold tracking-normal">
                    — {colorDisplayLabel}
                  </span>
                )}
              </p>
            </div>
            <div className="px-4 py-4 grid grid-cols-4 gap-3">
              {COLORS.map(c => {
                const isSelected = c.name === 'Other'
                  ? vehicleColor === CUSTOM_COLOR_KEY
                  : vehicleColor === c.name;
                return (
                  <button
                    key={c.name}
                    id={`vehicle-color-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                    role="radio"
                    aria-checked={isSelected}
                    aria-label={clabels[c.name] ?? c.name}
                    onClick={() => {
                      setColorTouched(true);
                      setColorCleared(false);
                      if (c.name === 'Other') {
                        setVehicleColor(vehicleColor === CUSTOM_COLOR_KEY ? '' : CUSTOM_COLOR_KEY);
                      } else {
                        setVehicleColor(vehicleColor === c.name ? '' : c.name);
                      }
                    }}
                    className="flex flex-col items-center gap-1.5 group"
                  >
                    <div
                      className="w-10 h-10 rounded-full transition-all duration-150 active:scale-90"
                      style={c.hex === 'other' ? {
                        background: 'conic-gradient(#DC2626, #EAB308, #16A34A, #2563EB, #7C3AED, #DC2626)',
                        boxShadow: isSelected
                          ? '0 0 0 2px var(--color-bg), 0 0 0 4px #1e75ff'
                          : '0 0 0 1px rgba(255,255,255,0.12)',
                      } : {
                        backgroundColor: c.hex,
                        boxShadow: isSelected
                          ? '0 0 0 2px var(--color-bg), 0 0 0 4px #1e75ff'
                          : '0 0 0 1px rgba(255,255,255,0.12)',
                      }}
                    />
                    <span className="text-[10px] text-[var(--color-text-secondary)] leading-none text-center">
                      {clabels[c.name] ?? c.name}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Custom color input — shown when Other is selected */}
            {vehicleColor === CUSTOM_COLOR_KEY && (
              <div className="px-4 pb-4 pt-3 border-t border-[var(--color-border)]">
                <label className="text-xs font-semibold text-[var(--color-text-secondary)] mb-1.5 block">
                  {t('vehicle.color_custom_label')}
                </label>
                <input
                  ref={customColorRef}
                  type="text"
                  value={customColorText}
                  onChange={e => setCustomColorText(e.target.value.slice(0, 30))}
                  placeholder={t('vehicle.color_custom_placeholder')}
                  maxLength={30}
                  className="w-full px-3 py-2.5 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] text-sm placeholder:text-[var(--color-text-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                />
                {/* Canonical match notice */}
                {canonicalColorMatch && (
                  <div className="mt-2 flex items-center gap-2">
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      {t('vehicle.color_already_listed')}
                    </p>
                    <button
                      type="button"
                      onClick={() => { setVehicleColor(canonicalColorMatch); setColorTouched(true); setColorCleared(false); }}
                      className="text-xs font-semibold text-[var(--color-info)] active:opacity-70 transition-opacity"
                    >
                      {clabels[canonicalColorMatch] ?? canonicalColorMatch}
                    </button>
                  </div>
                )}
                {/* Helper: incomplete Other choice */}
                {!canonicalColorMatch && !customColorText.trim() && (
                  <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
                    {t('vehicle.color_enter_or_remove')}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Remove color — only when a color is actively selected */}
          {vehicleColor && (
            <button
              onClick={() => {
                setVehicleColor('');
                setCustomColorText('');
                setColorTouched(true);
                setColorCleared(true);
              }}
              className="w-full py-3 text-sm font-semibold text-[var(--color-text-secondary)] active:opacity-60 transition-opacity"
            >
              {t('vehicle.color_remove')}
            </button>
          )}
        </div>

        {/* Anchored Save */}
        <div className="pt-3 pb-4">
          <button
            onClick={handleSaveWithColor}
            disabled={saving || !colorValid}
            className="w-full py-3.5 rounded-xl bg-[var(--color-brand)] text-white font-bold text-sm active:scale-[0.98] transition-all disabled:opacity-40"
          >
            {saving ? t('vehicle.saving') : t('vehicle.save_vehicle')}
          </button>
        </div>
      </div>
    </div>
  );
};
