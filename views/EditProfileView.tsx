import React, { useState, useEffect, useRef } from 'react';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { db } from '../firebase';
import { ChevronLeft, ChevronRight, Check, X } from 'lucide-react';

import { moderateUsername, moderateDisplayName } from '../utils/moderation';
import { useFocusOnMount } from '../hooks/useFocusOnMount';
import { t, useLang } from '../i18n';
import { InlineLoader, LoadingScreen } from '../components/LoadingScreen';
import { useModalAccessibility } from '../hooks/useModalAccessibility';
import {
  isDirty,
  resolveGenderFromStored,
  buildPublicProfileUpdates,
  buildPrivateProfileUpdates,
  AGE_RANGES,
  AGE_PREFER_NOT,
  type EditProfileDraft,
} from '../utils/editProfileForm';

const USERNAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function validateUsername(val: string): string | null {
  if (val.length < 3) return t('edit_profile.username_min_length');
  if (val.length > 20) return t('edit_profile.username_max_length');
  if (!USERNAME_REGEX.test(val)) return t('edit_profile.username_invalid_chars');
  if (/__/.test(val)) return t('edit_profile.username_no_double_underscores');
  return moderateUsername(val);
}

// text-[16px], not text-sm: iOS Safari zooms the page when a focused input is
// under 16px, and never zooms back out.
const fieldClass = 'block w-full px-4 py-3.5 bg-transparent text-[var(--color-text)] outline-none text-[16px] placeholder:text-[var(--color-text-secondary)]';
const rowClass = 'bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl overflow-hidden';
const sectionLabel = 'text-xs font-bold text-[var(--color-text)] uppercase tracking-wider';
const microLabel = 'text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]';

export const EditProfileView = ({ onBack }: { onBack: () => void }) => {
  useLang();

  const [uid, setUid] = useState('');
  const [loading, setLoading] = useState(true);

  // Public profile
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [originalUsername, setOriginalUsername] = useState('');
  const [usernameEditOpen, setUsernameEditOpen] = useState(false);
  const [usernameAvailability, setUsernameAvailability] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'unchanged'>('idle');
  const [usernameError, setUsernameError] = useState('');

  // Parking background
  const [homeArea, setHomeArea] = useState('');
  const [driverType, setDriverType] = useState('');

  // Demographics
  const [ageRange, setAgeRange] = useState('');
  const [ageRangeTouched, setAgeRangeTouched] = useState(false);
  const [genderSelect, setGenderSelect] = useState('');
  const [genderCustom, setGenderCustom] = useState('');

  // Form state
  const [initial, setInitial] = useState<EditProfileDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  const discardDialogRef = useRef<HTMLDivElement>(null);
  useModalAccessibility({ isOpen: showDiscardModal, dialogRef: discardDialogRef, onEscape: () => setShowDiscardModal(false) });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useFocusOnMount(headingRef);

  useEffect(() => {
    const auth = getAuth();
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser) {
        setUid(fbUser.uid);
        try {
          const [snap, privateSnap] = await Promise.all([
            getDoc(doc(db, 'users', fbUser.uid)),
            getDoc(doc(db, 'users', fbUser.uid, 'private', 'profile')),
          ]);
          if (snap.exists()) {
            const d = snap.data();
            // pd = private doc; fall back to public doc fields for one-time migration of existing users
            const pd = privateSnap.exists() ? privateSnap.data() : {};
            const uname = d.username || '';
            const dname = d.fullName || '';
            const area = pd.homeArea ?? '';
            const dtype = pd.driverType ?? '';
            const ar = pd.ageRange ?? '';
            const { genderSelect: gs, genderCustom: gc } = resolveGenderFromStored(pd.gender);
            setUsername(uname);
            setOriginalUsername(uname);
            setDisplayName(dname);
            setHomeArea(area);
            setDriverType(dtype);
            setAgeRange(ar);
            setGenderSelect(gs);
            setGenderCustom(gc);
            setInitial({ displayName: dname, homeArea: area, driverType: dtype, ageRange: ar, genderSelect: gs, genderCustom: gc });
          }
        } catch (e) {
          console.warn('Failed to load profile', e);
        }
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!usernameEditOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setUsernameError('');
    const trimmed = username.trim();
    if (!trimmed) { setUsernameAvailability('idle'); return; }
    if (trimmed.toLowerCase() === originalUsername.toLowerCase()) { setUsernameAvailability('unchanged'); return; }
    const err = validateUsername(trimmed);
    if (err) { setUsernameAvailability('invalid'); setUsernameError(err); return; }
    setUsernameAvailability('checking');
    debounceRef.current = setTimeout(async () => {
      try {
        const snap = await getDoc(doc(db, 'usernames', trimmed.toLowerCase()));
        setUsernameAvailability(snap.exists() ? 'taken' : 'available');
      } catch { setUsernameAvailability('idle'); }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [username, originalUsername, usernameEditOpen]);

  const currentDraft: EditProfileDraft = { displayName, homeArea, driverType, ageRange, genderSelect, genderCustom };
  const formDirty = initial !== null && isDirty(initial, currentDraft);
  const usernameDirty = usernameEditOpen && username.trim().toLowerCase() !== originalUsername.toLowerCase();
  const dirty = formDirty || usernameDirty || ageRangeTouched;
  const canSave = !saving && dirty && (!usernameDirty || usernameAvailability === 'available');

  const handleBack = () => {
    if (dirty) { setShowDiscardModal(true); return; }
    onBack();
  };

  const handleSave = async () => {
    if (!uid || !canSave) return;
    const nameError = moderateDisplayName(displayName.trim());
    if (nameError) { setSaveError(nameError); return; }
    setSaving(true); setSaveError('');
    try {
      const functions = getFunctions(getApp(), 'us-central1');
      if (usernameDirty) {
        await httpsCallable(functions, 'claimUsername')({ username: username.trim() });
      }
      const pubUpdates = buildPublicProfileUpdates(currentDraft, initial);
      const privUpdates = buildPrivateProfileUpdates(currentDraft, initial, ageRangeTouched);
      // fullName is authoritative-server-owned — direct client writes to
      // users/{uid}.fullName are denied by firestore.rules.
      if (pubUpdates.fullName) {
        await httpsCallable(functions, 'updateDisplayName')({ fullName: pubUpdates.fullName });
      }
      if (Object.keys(privUpdates).length > 0) {
        await setDoc(doc(db, 'users', uid, 'private', 'profile'), privUpdates, { merge: true });
      }
      setSaveSuccess(true);
      setTimeout(() => onBack(), 1200);
    } catch (e: any) {
      setSaveError(e?.details || e?.message || t('edit_profile.save_failed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <LoadingScreen label={t('common.loading')} />;
  }

  if (!uid) {
    return (
      <div className="min-h-full bg-[var(--color-bg)] flex items-center justify-center p-8">
        <p className="text-[var(--color-text-secondary)] text-center">{t('edit_profile.not_logged_in')}</p>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-[var(--color-bg)] text-[var(--color-text)] pt-4 pb-24 px-4">
      <div className="max-w-md mx-auto flex flex-col gap-6">

        {/* Header */}
        <div className="flex items-center gap-4">
          <button
            onClick={handleBack}
            aria-label={t('edit_profile.back_aria')}
            className="w-10 h-10 rounded-full flex items-center justify-center bg-white/5 border border-[var(--color-border)] text-[var(--color-text)] hover:bg-white/10 transition-all shrink-0"
          >
            <ChevronLeft size={20} />
          </button>
          <h1 ref={headingRef} tabIndex={-1} className="text-xl font-bold tracking-wide focus:outline-none">
            {t('edit_profile.title')}
          </h1>
        </div>

        {/* PUBLIC PROFILE */}
        <div className={rowClass}>
          <div className="px-4 pt-3.5 pb-2 border-b border-[var(--color-border)]">
            <p className={sectionLabel}>{t('edit_profile.public_section')}</p>
          </div>

          {/* Display Name */}
          <div className="border-b border-[var(--color-border)]">
            <div className="px-4 pt-3 pb-1"><span className={microLabel}>{t('edit_profile.display_name_label')}</span></div>
            <input
              type="text"
              aria-label={t('edit_profile.display_name_label')}
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className={`${fieldClass} pb-3.5`}
              placeholder={t('edit_profile.display_name_placeholder')}
            />
          </div>

          {/* Username — collapsed nav row or expanded edit UI */}
          {!usernameEditOpen ? (
            <button
              className="w-full flex items-center justify-between px-4 py-4 text-left hover:bg-white/5 transition-all"
              onClick={() => setUsernameEditOpen(true)}
              aria-label={`${t('edit_profile.username_label')}: ${username}. ${t('edit_profile.username_edit')}`}
            >
              <div>
                <span className={microLabel}>{t('edit_profile.username_label')}</span>
                <p className="text-sm mt-0.5 text-[var(--color-text)]">{username || '—'}</p>
              </div>
              <span className="text-xs font-semibold text-[var(--color-accent)] flex items-center gap-1">
                {t('edit_profile.username_edit')} <ChevronRight size={14} />
              </span>
            </button>
          ) : (
            <div>
              <div className="px-4 pt-3 pb-1 flex items-center justify-between">
                <span className={microLabel}>{t('edit_profile.username_label')}</span>
                <button
                  className="text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
                  onClick={() => {
                    setUsernameEditOpen(false);
                    setUsername(originalUsername);
                    setUsernameAvailability('idle');
                    setUsernameError('');
                  }}
                >
                  {t('edit_profile.username_cancel')}
                </button>
              </div>
              <div className="relative">
                <input
                  type="text"
                  aria-label={t('edit_profile.username_label')}
                  value={username}
                  onChange={e => setUsername(e.target.value.replace(/\s/g, ''))}
                  maxLength={20}
                  autoFocus
                  className={`${fieldClass} pr-12 pb-3.5`}
                  placeholder={t('edit_profile.username_placeholder')}
                />
                <div className="absolute right-4 top-1/2 -translate-y-1/2">
                  {usernameAvailability === 'checking' && <InlineLoader size={16} className="text-[var(--color-text-secondary)]" />}
                  {usernameAvailability === 'available' && <Check size={16} className="text-[var(--color-success)]" />}
                  {(usernameAvailability === 'taken' || usernameAvailability === 'invalid') && <X size={16} className="text-[var(--color-danger)]" />}
                  {usernameAvailability === 'unchanged' && <Check size={16} className="text-[var(--color-text-secondary)]" />}
                </div>
              </div>
              {usernameAvailability === 'available' && <p className="text-[var(--color-success)] text-[10px] px-4 pb-2 font-semibold">{t('edit_profile.username_available')}</p>}
              {usernameAvailability === 'taken' && <p className="text-[var(--color-danger)] text-[10px] px-4 pb-2 font-semibold">{t('edit_profile.username_taken')}</p>}
              {usernameError && usernameAvailability === 'invalid' && <p className="text-[var(--color-danger)] text-[10px] px-4 pb-2">{usernameError}</p>}
            </div>
          )}
        </div>

        {/* PARKING BACKGROUND */}
        <div className={rowClass}>
          <div className="px-4 pt-3.5 pb-2 border-b border-[var(--color-border)]">
            <p className={sectionLabel}>{t('edit_profile.parking_section')}</p>
          </div>

          {/* Primary Parking Area */}
          <div className="border-b border-[var(--color-border)]">
            <div className="px-4 pt-3 pb-1">
              <span className={microLabel}>{t('edit_profile.parking_area_label')}</span>
              <span className="text-[10px] text-[var(--color-text-secondary)] ml-1.5">{t('edit_profile.optional')}</span>
            </div>
            <input
              type="text"
              aria-label={t('edit_profile.parking_area_label')}
              value={homeArea}
              onChange={e => setHomeArea(e.target.value)}
              className={`${fieldClass} pb-3.5`}
              placeholder={t('edit_profile.parking_area_placeholder')}
            />
          </div>

          {/* Parking Routine */}
          <div className="relative">
            <div className="px-4 pt-3 pb-1">
              <span className={microLabel}>{t('edit_profile.parking_routine_label')}</span>
              <span className="text-[10px] text-[var(--color-text-secondary)] ml-1.5">{t('edit_profile.optional')}</span>
            </div>
            <select
              aria-label={t('edit_profile.parking_routine_label')}
              value={driverType}
              onChange={e => setDriverType(e.target.value)}
              className={`${fieldClass} pb-3.5 pr-10 appearance-none cursor-pointer dark:[color-scheme:dark]`}
              style={{ backgroundColor: 'var(--color-card)' }}
            >
              <option value="">{t('edit_profile.parking_routine_placeholder')}</option>
              <option value="Daily commuter">{t('edit_profile.driver_type_commuter')}</option>
              <option value="Occasional driver">{t('edit_profile.driver_type_occasional')}</option>
              <option value="Rideshare / delivery">{t('edit_profile.driver_type_rideshare')}</option>
            </select>
            <ChevronRight size={16} className="absolute right-4 bottom-4 text-[var(--color-text-secondary)] pointer-events-none rotate-90" />
          </div>
        </div>

        {/* OPTIONAL DEMOGRAPHICS */}
        <div className={rowClass}>
          <div className="px-4 pt-3.5 pb-3 border-b border-[var(--color-border)]">
            <p className={sectionLabel}>{t('edit_profile.demographics_section')}</p>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-1 leading-relaxed">{t('edit_profile.demographics_privacy')}</p>
          </div>

          {/* Age Range */}
          <div className="relative border-b border-[var(--color-border)]">
            <div className="px-4 pt-3 pb-1">
              <span className={microLabel}>{t('edit_profile.age_range_label')}</span>
              <span className="text-[10px] text-[var(--color-text-secondary)] ml-1.5">{t('edit_profile.optional')}</span>
            </div>
            <select
              aria-label={t('edit_profile.age_range_label')}
              value={ageRange}
              onChange={e => { setAgeRange(e.target.value); setAgeRangeTouched(true); }}
              className={`${fieldClass} pb-3.5 pr-10 appearance-none cursor-pointer dark:[color-scheme:dark]`}
              style={{ backgroundColor: 'var(--color-card)' }}
            >
              <option value="">{t('edit_profile.age_range_placeholder')}</option>
              {AGE_RANGES.map(r => <option key={r} value={r}>{r}</option>)}
              <option value={AGE_PREFER_NOT}>{t('edit_profile.age_prefer_not')}</option>
            </select>
            <ChevronRight size={16} className="absolute right-4 bottom-4 text-[var(--color-text-secondary)] pointer-events-none rotate-90" />
          </div>

          {/* Gender + optional self-describe */}
          <div>
            <div className="relative">
              <div className="px-4 pt-3 pb-1">
                <span className={microLabel}>{t('edit_profile.gender_label')}</span>
                <span className="text-[10px] text-[var(--color-text-secondary)] ml-1.5">{t('edit_profile.optional')}</span>
              </div>
              <select
                aria-label={t('edit_profile.gender_label')}
                value={genderSelect}
                onChange={e => { setGenderSelect(e.target.value); if (e.target.value !== 'Self-describe') setGenderCustom(''); }}
                className={`${fieldClass} ${genderSelect === 'Self-describe' ? 'pb-2' : 'pb-3.5'} pr-10 appearance-none cursor-pointer dark:[color-scheme:dark]`}
                style={{ backgroundColor: 'var(--color-card)' }}
              >
                <option value="">{t('edit_profile.gender_placeholder')}</option>
                <option value="Male">{t('edit_profile.gender_male')}</option>
                <option value="Female">{t('edit_profile.gender_female')}</option>
                <option value="Non-binary">{t('edit_profile.gender_non_binary')}</option>
                <option value="Self-describe">{t('edit_profile.gender_self_describe')}</option>
                <option value="Prefer not to say">{t('edit_profile.gender_prefer_not')}</option>
              </select>
              <ChevronRight size={16} className="absolute right-4 bottom-4 text-[var(--color-text-secondary)] pointer-events-none rotate-90" />
            </div>
            {genderSelect === 'Self-describe' && (
              <input
                type="text"
                aria-label={t('edit_profile.gender_custom_aria')}
                value={genderCustom}
                onChange={e => setGenderCustom(e.target.value)}
                className={`${fieldClass} pb-3.5 border-t border-[var(--color-border)]`}
                placeholder={t('edit_profile.gender_custom_placeholder')}
                maxLength={60}
              />
            )}
          </div>
        </div>

        {/* Feedback */}
        {saveError && <p className="text-[var(--color-danger)] text-xs text-center">{saveError}</p>}
        {saveSuccess && <p className="text-[var(--color-success)] text-xs text-center font-semibold">{t('edit_profile.save_success')}</p>}

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={!canSave}
          aria-disabled={!canSave}
          className="w-full py-3.5 rounded-2xl text-sm font-bold transition-all disabled:opacity-40 active:scale-95"
          style={{
            background: canSave ? 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' : undefined,
            backgroundColor: canSave ? undefined : 'var(--color-brand)',
            color: '#fff',
            boxShadow: canSave ? '0 4px 20px rgba(30,117,255,0.35)' : 'none',
          }}
        >
          {saving ? t('edit_profile.saving') : saveSuccess ? t('edit_profile.save_success') : t('edit_profile.save')}
        </button>

      </div>

      {/* Discard confirmation */}
      {showDiscardModal && (
        <div
          data-modal-root=""
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm px-4 pb-8 sm:pb-0"
        >
          <div
            ref={discardDialogRef}
            className="w-full max-w-sm bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl p-6 flex flex-col gap-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="discard-title"
          >
            <h2 id="discard-title" className="text-base font-bold">{t('edit_profile.unsaved_title')}</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">{t('edit_profile.unsaved_body')}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDiscardModal(false)}
                className="flex-1 py-3 rounded-xl text-sm font-semibold bg-white/5 border border-[var(--color-border)] text-[var(--color-text)] hover:bg-white/10 transition-all"
              >
                {t('edit_profile.unsaved_keep')}
              </button>
              <button
                onClick={onBack}
                className="flex-1 py-3 rounded-xl text-sm font-semibold bg-red-500/20 border border-red-500/30 text-[var(--color-danger)] hover:bg-red-500/30 transition-all"
              >
                {t('edit_profile.unsaved_discard')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
