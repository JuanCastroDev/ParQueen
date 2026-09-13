import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { LoadingScreen } from './components/LoadingScreen';
import { OnboardingView } from './views/OnboardingView';
const LocationPromptView = lazy(() => import('./views/LocationPromptView').then(m => ({ default: m.LocationPromptView })));

// All other views are lazy-loaded so the initial bundle only contains what's
// needed for the login screen. Each view is brought in on demand the first
// time its AppView is rendered, which keeps heavy dependencies (mapbox-gl,
// leaflet, recharts, the Gemini-backed assistant, the admin dashboard, etc.)
// out of the critical path for users who never visit those screens.
const MapView = lazy(() => import('./views/StreetParkingView').then(m => ({ default: m.MapView })));
const AssistantView = lazy(() => import('./views/AssistantView').then(m => ({ default: m.AssistantView })));
const MessagesView = lazy(() => import('./views/MessagesView').then(m => ({ default: m.MessagesView })));
const ProfileView = lazy(() => import('./views/ProfileView').then(m => ({ default: m.ProfileView })));
const NotificationsView = lazy(() => import('./views/NotificationsView').then(m => ({ default: m.NotificationsView })));
const NotificationsSettingsView = lazy(() => import('./views/NotificationsSettingsView').then(m => ({ default: m.NotificationsSettingsView })));
const LocationSettingsView = lazy(() => import('./views/LocationSettingsView').then(m => ({ default: m.LocationSettingsView })));
const LanguageSettingsView = lazy(() => import('./views/LanguageSettingsView').then(m => ({ default: m.LanguageSettingsView })));
const CreateAccountView = lazy(() => import('./views/CreateAccountView').then(m => ({ default: m.CreateAccountView })));
const SetupProfileView = lazy(() => import('./views/SetupProfileView').then(m => ({ default: m.SetupProfileView })));
const VerifyPhoneView = lazy(() => import('./views/VerifyPhoneView').then(m => ({ default: m.VerifyPhoneView })));
const NameEntryView = lazy(() => import('./views/NameEntryView').then(m => ({ default: m.NameEntryView })));
const EditProfileView = lazy(() => import('./views/EditProfileView').then(m => ({ default: m.EditProfileView })));
const SettingsView = lazy(() => import('./views/SettingsView').then(m => ({ default: m.SettingsView })));
const AdminDashboardView = lazy(() => import('./views/AdminDashboardView').then(m => ({ default: m.AdminDashboardView })));
const AdminLoginView = lazy(() => import('./views/AdminLoginView').then(m => ({ default: m.AdminLoginView })));

// Admin portal lives at admin.parqueen.app. On localhost, add ?admin to test it.
const isAdminDomain = window.location.hostname === 'admin.parqueen.app'
  || (window.location.hostname === 'localhost' && new URLSearchParams(window.location.search).has('admin'));

const ActivitiesView = lazy(() => import('./views/ActivitiesView').then(m => ({ default: m.ActivitiesView })));
const EditVehicleView = lazy(() => import('./views/EditVehicleView').then(m => ({ default: m.EditVehicleView })));
const PrivacyPolicyView = lazy(() => import('./views/PrivacyPolicyView').then(m => ({ default: m.PrivacyPolicyView })));
const TermsOfUseView = lazy(() => import('./views/TermsOfUseView').then(m => ({ default: m.TermsOfUseView })));
const ContactUsView = lazy(() => import('./views/ContactUsView').then(m => ({ default: m.ContactUsView })));
import { AppView } from './types';
import { readPersistedAccess, persistAccessChoice, shouldShowPrimer, resolveFromPermissionSnapshot, type LocationAccess } from './utils/locationAccess';
import { nearbyPermissionState, type LocationCallbacks } from './utils/nearbyActivity';
import { checkLocationPermission, requestLocationPermission } from './utils/geolocation';
import { getLang, setLang, t } from './i18n';
import { getLanguageHydrationAction } from './utils/languageHydration';
import { ChevronLeft } from 'lucide-react';
import ErrorBoundary from './ErrorBoundary';
import { logoutUser, deleteUser, unlinkFcmTokenBeforeDeletion } from './database';
import { ConfirmationResult, RecaptchaVerifier, reauthenticateWithPhoneNumber, signOut } from 'firebase/auth';
import { useInAppLegalNavigation } from './hooks/useInAppLegalNavigation';
import { legalViewFor } from './utils/inAppLegalNavigation';
import type { PhoneVerificationSession } from './utils/phoneAuth';
import { maskPhoneNumber, verifyUidUnchanged } from './utils/reauthBeforeDelete';
import { auth, db } from './firebaseConfig';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, onSnapshot, getDoc } from "firebase/firestore";
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { clearRecaptchaVerifier, replaceRecaptchaVerifier } from './utils/recaptchaLifecycle';
import { notificationRegistration, type NotificationRuntimeState } from './utils/notificationRegistration';
import { createNotificationLifecycle } from './utils/notificationLifecycle';
import {
  consumeNotificationIntentFragment,
  normalizeNotificationIntent,
  readNotificationIntentFromPayload,
  type NotificationIntent,
} from './utils/notificationIntent';
import { createNotificationIntentQueue, executeNotificationIntent } from './utils/notificationNavigation';
import { ForegroundNotificationToast } from './components/ForegroundNotificationToast';
import { AccessibleModal } from './components/AccessibleModal';
import { useUnreadMessages } from './views/street-parking/useUnreadMessages';
import { parsePersistedCount } from './utils/persistedCount';

// Clears all account-scoped browser state after account deletion.
// Preserves device-scoped preferences (theme, language) so they survive account transitions.
// Clearing FCM ownership markers ensures legacyInstall detection on the next sign-in,
// which calls deleteToken before associating a new registration with the new account.
const clearLocalAccountState = () => {
  const theme = localStorage.getItem('theme');
  const lang  = localStorage.getItem('parqueen_lang');
  localStorage.clear();
  if (theme !== null) localStorage.setItem('theme', theme);
  if (lang  !== null) localStorage.setItem('parqueen_lang', lang);
};

export default function App() {
  const [currentView, setCurrentView] = useState(AppView.CREATE_ACCOUNT);
  const [vehicleOnboarding, setVehicleOnboarding] = useState(false);
  const [locationAccess, setLocationAccess] = useState<LocationAccess>(() => readPersistedAccess());
  const [locationServicesEnabled, setLocationServicesEnabled] = useState<boolean | null>(null);
  const [pendingSpotId, setPendingSpotId] = useState<string | null>(null);
  const [pendingMyCarOpen, setPendingMyCarOpen] = useState(false);
  const [user, setUser] = useState(null);
  const unreadMessagesCount = useUnreadMessages(user?.id);
  const [pendingUpdatesCount, setPendingUpdatesCount] = useState(() => {
    return parsePersistedCount(localStorage.getItem('pendingUpdatesCount'));
  });
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('theme') || 'dark';
  });
  const [activeChatContext, setActiveChatContext] = useState<{ userId: string; context: string } | null>(null);
  const [chatReturnSpotId, setChatReturnSpotId] = useState<string | null>(null);
  const [pushToast, setPushToast] = useState<{ title: string; body: string; intent: NotificationIntent } | null>(null);

  const navigatePrimary = (view: AppView) => {
    if (view === AppView.NOTIFICATIONS) setPendingUpdatesCount(0);
    setCurrentView(view);
  };
  const { setViewWithLegalReturn, closeLegal } = useInAppLegalNavigation(currentView, setCurrentView);
  const pushToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notificationRuntime, setNotificationRuntime] = useState<NotificationRuntimeState | null>(null);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const notificationIntentQueueRef = useRef<ReturnType<typeof createNotificationIntentQueue> | null>(null);
  const [titleUnlock, setTitleUnlock] = useState<string | null>(null);
  const prevTitleRef = useRef<string | null>(null);
  const privateEmailRef = useRef<string | undefined>(undefined);
  const [deletePhase, setDeletePhase] = useState<'idle' | 'confirming' | 'deleting' | 'failed' | 'reauth_entering_phone' | 'reauth_verifying_otp'>('idle');
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  // phone stores canonical E.164 (e.g. "+15555551234", "+51987654321")
  const [phone, setPhone] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<PhoneVerificationSession | ConfirmationResult | null>(null);
  const [reauthOtp, setReauthOtp] = useState('');
  const [reauthResendCooldown, setReauthResendCooldown] = useState(0);
  const [reauthError, setReauthError] = useState('');
  const reauthRecaptchaRef = useRef<RecaptchaVerifier | null>(null);
  const reauthCooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const originalUidRef = useRef<string | null>(null);
  const reauthSendingRef = useRef(false);
  const reauthVerifyingRef = useRef(false);

  const clearReauthState = () => {
    if (reauthCooldownRef.current) { clearInterval(reauthCooldownRef.current); reauthCooldownRef.current = null; }
    clearRecaptchaVerifier(reauthRecaptchaRef);
    reauthSendingRef.current = false;
    reauthVerifyingRef.current = false;
    setConfirmationResult(null);
    setReauthOtp('');
    setReauthResendCooldown(0);
    setReauthError('');
  };

  const handleDeleteModalDismiss = () => {
    clearReauthState();
    setDeletePhase('idle');
  };

  useEffect(() => {
    let userProfileUnsubscribe = () => {};
    let privateAccountUnsubscribe = () => {};
    let privatePreferencesUnsubscribe = () => {};
    let privateSocialUnsubscribe = () => {};

    const authStateUnsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      userProfileUnsubscribe();
      privateAccountUnsubscribe();
      privatePreferencesUnsubscribe();
      privateSocialUnsubscribe();
      privateEmailRef.current = undefined;
      setLoading(true);

      if (firebaseUser) {
        const userDocRef = doc(db, 'users', firebaseUser.uid);

        // Admin domain: skip FCM and profile listener — just check the claim
        if (isAdminDomain) {
          const token = await firebaseUser.getIdTokenResult();
          if (token.claims.role === 'admin') {
            setCurrentView(AppView.ADMIN_DASHBOARD);
          } else {
            setCurrentView(AppView.ADMIN_LOGIN);
          }
          setLoading(false);
          return;
        }

        // Listen for profile data changes
        userProfileUnsubscribe = onSnapshot(userDocRef, (userDoc) => {
          if (userDoc.exists()) {
            const userData = userDoc.data();
            // Prefer email from private subcollection; fall back to public doc for pre-migration accounts
            const emailOverride = privateEmailRef.current !== undefined
              ? { email: privateEmailRef.current }
              : {};
            setUser({ id: userDoc.id, ...userData, ...emailOverride });
            const newTitle = userData.title || 'Newcomer';
            if (prevTitleRef.current && prevTitleRef.current !== newTitle && newTitle !== 'Newcomer') {
              setTitleUnlock(newTitle);
              setTimeout(() => setTitleUnlock(null), 5000);
            }
            prevTitleRef.current = newTitle;
          } else {
            setUser({ id: firebaseUser.uid });
          }
        });

        // Listen for private account data (email) — owner-only subcollection
        const privateAccountRef = doc(db, 'users', firebaseUser.uid, 'private', 'account');
        privateAccountUnsubscribe = onSnapshot(privateAccountRef, (snap) => {
          const email = snap.exists() ? snap.data().email : undefined;
          privateEmailRef.current = email;
          setUser(prev => prev ? { ...prev, email } : prev);
        });

        // Listen for private preferences (notif settings, location pref) — owner-only
        const privatePrefsRef = doc(db, 'users', firebaseUser.uid, 'private', 'preferences');
        privatePreferencesUnsubscribe = onSnapshot(privatePrefsRef, (snap) => {
          if (!snap.exists()) return;
          const prefs = snap.data();
          setUser(prev => prev ? {
            ...prev,
            notificationsEnabled: prefs.notificationsEnabled,
            notificationRadius: prefs.notificationRadius,
            sharePreciseLocation: prefs.sharePreciseLocation,
          } : prev);
        });

        // Listen for private social (blockedUsers) — owner-only
        const privateSocialRef = doc(db, 'users', firebaseUser.uid, 'private', 'social');
        privateSocialUnsubscribe = onSnapshot(privateSocialRef, (snap) => {
          if (!snap.exists()) return;
          setUser(prev => prev ? { ...prev, blockedUsers: snap.data().blockedUsers || [] } : prev);
        });

        // Check for admin claims and route accordingly
        const token = await firebaseUser.getIdTokenResult();
        const isAdmin = token.claims.role === 'admin';

        if (isAdmin) {
          setCurrentView(AppView.ADMIN_DASHBOARD);
        } else {
          // For non-admins, check if their profile is set up
          const userDoc = await getDoc(userDocRef);
          if (userDoc.exists()) {
            // Read stored access, then reconcile against actual browser permission.
            // This corrects stale 'declined' state (Not now recovery, legacy users) and
            // catches browser permission revocations before the map mounts.
            let access = readPersistedAccess();
            try {
              const snap = await checkLocationPermission();
              if (snap.locationServicesEnabled === false) setLocationServicesEnabled(false);
              else if (snap.locationServicesEnabled === true) setLocationServicesEnabled(true);
              const reconciled = resolveFromPermissionSnapshot(snap.status, access);
              if ((reconciled === 'granted' || reconciled === 'denied') && reconciled !== access) {
                persistAccessChoice(reconciled);
                access = reconciled;
              }
            } catch {}
            // Sync React state — ensures allowLocationTracking is correct when MapView mounts
            setLocationAccess(access);
            setCurrentView(shouldShowPrimer(access) ? AppView.LOCATION_PROMPT : AppView.MAP);
          } else {
            setCurrentView(AppView.SETUP_PROFILE);
          }
        }
      } else {
        // No user is logged in — clear any pending deletion modal before rerouting.
        // Successful deletion triggers this branch via signOut(); without this reset
        // deletePhase stays 'deleting' and the modal survives the Auth transition.
        clearReauthState();
        setDeletePhase('idle');
        setUser(null);
        if (isAdminDomain) {
          setCurrentView(AppView.ADMIN_LOGIN);
        } else {
          const hasSeen = !!localStorage.getItem('hasSeenOnboarding');
          setCurrentView(hasSeen ? AppView.CREATE_ACCOUNT : AppView.ONBOARDING);
        }
      }
      setLoading(false);
    });

    return () => {
      if (reauthCooldownRef.current) clearInterval(reauthCooldownRef.current);
      clearRecaptchaVerifier(reauthRecaptchaRef);
      authStateUnsubscribe();
      userProfileUnsubscribe();
      privateAccountUnsubscribe();
      privatePreferencesUnsubscribe();
      privateSocialUnsubscribe();
    };
  }, []);

  // One lifecycle owns silent granted-token refresh and the foreground FCM
  // listener. Authentication never requests notification permission.
  useEffect(() => {
    const lifecycle = createNotificationLifecycle(notificationRegistration, {
      onState: setNotificationRuntime,
      onPayload: payload => {
        const message = payload as {
          notification?: { title?: string; body?: string };
          data?: { title?: string; body?: string };
        };
        setPushToast({
          title: message.notification?.title ?? message.data?.title ?? '',
          body: message.notification?.body ?? message.data?.body ?? '',
          intent: readNotificationIntentFromPayload(payload),
        });
        if (pushToastTimerRef.current) clearTimeout(pushToastTimerRef.current);
        pushToastTimerRef.current = setTimeout(() => {
          setPushToast(null);
          pushToastTimerRef.current = null;
        }, 5000);
      },
    });
    void lifecycle.setUser(user?.id ? {
      uid: user.id,
      productPreferenceEnabled: user.notificationsEnabled !== false,
    } : null);
    return () => {
      lifecycle.dispose();
      if (pushToastTimerRef.current) clearTimeout(pushToastTimerRef.current);
      pushToastTimerRef.current = null;
    };
  }, [user?.id, user?.notificationsEnabled]);

  useEffect(() => {
    const queue = createNotificationIntentQueue(intent => {
      executeNotificationIntent(intent, {
        openPing: spotId => {
          setPendingMyCarOpen(false);
          setPendingSpotId(spotId);
          setCurrentView(AppView.MAP);
        },
        openMyCar: () => {
          setPendingSpotId(null);
          setPendingMyCarOpen(true);
          setCurrentView(AppView.MAP);
        },
        openNotifications: () => {
          setPendingSpotId(null);
          setPendingMyCarOpen(false);
          setCurrentView(AppView.NOTIFICATIONS);
        },
      });
    });
    notificationIntentQueueRef.current = queue;

    const startupIntent = consumeNotificationIntentFragment(window.location, window.history);
    if (startupIntent) queue.accept(startupIntent);

    const onWorkerMessage = (event: MessageEvent) => {
      const message = event.data as { kind?: unknown; version?: unknown; intent?: unknown } | null;
      if (message?.kind !== 'PARQUEEN_NOTIFICATION_OPEN' || message.version !== 1) return;
      queue.accept(normalizeNotificationIntent(message.intent) ?? { version: 1, type: 'notifications' });
    };
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage);
      queue.dispose();
      if (notificationIntentQueueRef.current === queue) notificationIntentQueueRef.current = null;
    };
  }, []);

  useEffect(() => {
    notificationIntentQueueRef.current?.setReady(!loading && !!user?.id);
  }, [loading, user?.id]);


  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Web lifecycle: recheck permission when returning to foreground on the Notifications screen.
  // Native adapters use AppState.addEventListener('change', ...) instead.
  useEffect(() => {
    if (currentView !== AppView.NOTIFICATIONS) return;
    const pState = nearbyPermissionState(locationAccess, { locationServicesEnabled });
    if (pState !== 'permanently_blocked' && pState !== 'services_disabled') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') locationCallbacks.recheckPermission();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [currentView, locationAccess]); // eslint-disable-line react-hooks/exhaustive-deps

  // Language hydration: when a signed-in user's Firestore profile has a valid
  // lang value that differs from the active locale, adopt it as the account
  // source of truth. Only fires when user.lang actually changes.
  useEffect(() => {
    if (!user) return;
    const action = getLanguageHydrationAction(user.lang, getLang());
    if (action.shouldUpdate) setLang(action.language);
  }, [user?.lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const handleEnableNotifications = async () => {
    if (!user?.id || notificationBusy) return;
    setNotificationBusy(true);
    try {
      setNotificationRuntime(await notificationRegistration.enable(user.id));
    } finally {
      setNotificationBusy(false);
    }
  };

  const handleRecheckNotifications = async () => {
    if (!user?.id || notificationBusy) return;
    setNotificationBusy(true);
    try {
      const inspected = await notificationRegistration.inspect();
      setNotificationRuntime(
        inspected.capability === 'supported' && inspected.permission === 'granted'
          ? await notificationRegistration.refreshGranted(user.id, user.notificationsEnabled !== false)
          : inspected,
      );
    } finally {
      setNotificationBusy(false);
    }
  };

  const handleMessageUser = (userId: string, context: string, returnSpotId?: string) => {
    console.log(`Starting chat with ${userId} about ${context}`);
    setActiveChatContext({ userId, context });
    setChatReturnSpotId(returnSpotId ?? null);
    setCurrentView(AppView.MESSAGES);
  };

  const handleCreateAccount = (phone: string, result: PhoneVerificationSession) => {
    setPhone(phone);
    setConfirmationResult(result);
    setCurrentView(AppView.VERIFY_PHONE);
  };

  const handleNameComplete = async (username: string) => {
    // claimUsername (server) is now the sole authoritative writer of both
    // the username reservation and the initial users/{uid} account doc
    // (including its private/social and private/preferences siblings) for
    // a brand-new account — no separate client-side profile-creation step
    // is needed; fullName is collected later via updateDisplayName.
    try {
      const functions = getFunctions(getApp(), 'us-central1');
      await httpsCallable(functions, 'claimUsername')({ username });
      setVehicleOnboarding(true);
      setCurrentView(AppView.EDIT_VEHICLE);
    } catch (error: any) {
      console.error("Failed to save profile: ", error);
      alert(error.message || "Failed to save profile.");
    }
  };

  const handleSaveProfile = async (profileData) => {
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) throw new Error("Not authenticated");
      // fullName is authoritative-server-owned — direct client writes to
      // users/{uid}.fullName are denied by firestore.rules.
      const functions = getFunctions(getApp(), 'us-central1');
      await httpsCallable(functions, 'updateDisplayName')({ fullName: profileData.fullName });
      // dob and gender are private — write to owner-only subcollection
      const { doc: fsDoc, setDoc } = await import("firebase/firestore");
      const privateUpdates: Record<string, string> = {};
      if (profileData.dob)    privateUpdates.dob    = profileData.dob;
      if (profileData.gender) privateUpdates.gender = profileData.gender;
      if (Object.keys(privateUpdates).length > 0) {
        await setDoc(fsDoc(db, 'users', uid, 'private', 'profile'), privateUpdates, { merge: true });
      }
      setCurrentView(AppView.MAP);
    } catch (error: any) {
      console.error("Failed to save profile: ", error);
      alert(error.message || "Failed to save profile.");
    }
  };


  // Product permission callbacks. OS vs browser details live in utils/geolocation.
  const locationCallbacks: LocationCallbacks = {
    requestLocationPermission: async () => {
      try {
        const snap = await requestLocationPermission();
        if (snap.locationServicesEnabled === false) {
          setLocationServicesEnabled(false);
          return;
        }
        if (snap.locationServicesEnabled === true) setLocationServicesEnabled(true);
        const next = resolveFromPermissionSnapshot(snap.status, locationAccess);
        if ((next === 'granted' || next === 'denied') && next !== locationAccess) {
          persistAccessChoice(next);
          setLocationAccess(next);
        }
      } catch {}
    },
    openAppSettings: () => {
      locationCallbacks.recheckPermission();
    },
    openLocationServicesSettings: () => {
      // No settings deep-link in this phase; recheck covers returning from OS Settings.
    },
    canOpenAppSettings: false,
    canOpenLocationServicesSettings: false,
    recheckPermission: async () => {
      try {
        const snap = await checkLocationPermission();
        if (snap.locationServicesEnabled === false) {
          setLocationServicesEnabled(false);
          return;
        }
        if (snap.locationServicesEnabled === true) setLocationServicesEnabled(true);
        const reconciled = resolveFromPermissionSnapshot(snap.status, locationAccess);
        if ((reconciled === 'granted' || reconciled === 'denied') && reconciled !== locationAccess) {
          persistAccessChoice(reconciled);
          setLocationAccess(reconciled);
        }
      } catch {}
    },
  };

  const handleLogout = async () => {
    try {
      await logoutUser();
    } catch (error) {
      console.error("Failed to logout: ", error);
      alert("Failed to logout.");
    }
  };

  const handleDeleteAccount = () => {
    setDeletePhase('confirming');
  };

  const startResendCooldown = () => {
    if (reauthCooldownRef.current) clearInterval(reauthCooldownRef.current);
    setReauthResendCooldown(30);
    reauthCooldownRef.current = setInterval(() => {
      setReauthResendCooldown(prev => {
        if (prev <= 1) { clearInterval(reauthCooldownRef.current!); reauthCooldownRef.current = null; return 0; }
        return prev - 1;
      });
    }, 1000);
  };

  const handleReauthSendOtp = async () => {
    if (reauthSendingRef.current) return;
    const currentUser = auth.currentUser;
    if (!currentUser?.phoneNumber) { setDeletePhase('failed'); return; }
    reauthSendingRef.current = true;
    setReauthError('');
    try {
      const verifier = replaceRecaptchaVerifier(reauthRecaptchaRef, auth, 'reauth-recaptcha-anchor');
      const result = await reauthenticateWithPhoneNumber(currentUser, currentUser.phoneNumber, verifier);
      setConfirmationResult(result);
      clearRecaptchaVerifier(reauthRecaptchaRef);
      setDeletePhase('reauth_verifying_otp');
      startResendCooldown();
    } catch (error: any) {
      clearReauthState();
      if (['auth/invalid-app-credential', 'auth/missing-app-credential', 'auth/captcha-check-failed'].includes(error?.code)) {
        setReauthError(t('phone_auth.error_expired'));
        setDeletePhase('reauth_entering_phone');
      } else {
        setDeletePhase('failed');
      }
    } finally {
      reauthSendingRef.current = false;
    }
  };

  const handleReauthVerifyOtp = async () => {
    if (!confirmationResult || reauthOtp.length < 6) return;
    if (deletePhase === 'deleting') return;
    if (reauthVerifyingRef.current) return;
    const originalUid = originalUidRef.current;
    if (!originalUid) { setDeletePhase('failed'); return; }
    reauthVerifyingRef.current = true;
    setDeletePhase('deleting');
    try {
      await confirmationResult.confirm(reauthOtp);
      // UID preservation check — abort if a different account was signed in during OTP
      verifyUidUnchanged(auth.currentUser?.uid, originalUid);
      clearReauthState();
      await unlinkFcmTokenBeforeDeletion();
      await deleteUser();
      clearLocalAccountState();
      setDeletePhase('idle');
    } catch (e: any) {
      if (e?.code === 'auth/account-switched') { try { await signOut(auth); } catch {} }
      clearReauthState();
      setDeletePhase('failed');
    }
  };

  const handleReauthResend = async () => {
    if (reauthResendCooldown > 0 || reauthSendingRef.current) return;
    const currentUser = auth.currentUser;
    if (!currentUser?.phoneNumber) { setDeletePhase('failed'); return; }
    reauthSendingRef.current = true;
    setReauthError('');
    try {
      const verifier = replaceRecaptchaVerifier(reauthRecaptchaRef, auth, 'reauth-recaptcha-anchor');
      const result = await reauthenticateWithPhoneNumber(currentUser, currentUser.phoneNumber, verifier);
      setConfirmationResult(result);
      clearRecaptchaVerifier(reauthRecaptchaRef);
      startResendCooldown();
    } catch (error: any) {
      clearReauthState();
      if (['auth/invalid-app-credential', 'auth/missing-app-credential', 'auth/captcha-check-failed'].includes(error?.code)) {
        setReauthError(t('phone_auth.error_expired'));
        setDeletePhase('reauth_entering_phone');
      } else {
        setDeletePhase('failed');
      }
    } finally {
      reauthSendingRef.current = false;
    }
  };

  const handleDeleteConfirm = async () => {
    if (deletePhase === 'deleting') return;
    setDeletePhase('deleting');
    try {
      await unlinkFcmTokenBeforeDeletion();
      await deleteUser();
      clearLocalAccountState();
      setDeletePhase('idle');
    } catch (error: any) {
      console.error("Failed to delete account:", error);
      if (error?.code === 'functions/failed-precondition') {
        originalUidRef.current = auth.currentUser?.uid ?? null;
        setDeletePhase('reauth_entering_phone');
      } else {
        setDeletePhase('failed');
      }
    }
  };

  const renderView = () => {
    if (loading) {
      return <LoadingScreen />;
    }


    // MAP and MESSAGES share the same MapView instance so selectedItem survives the transition
    if (currentView === AppView.MAP || currentView === AppView.MESSAGES) {
      return (
        <>
          <MapView
            user={user}
            onMessageUser={handleMessageUser}
            setView={navigatePrimary}
            pendingSpotId={pendingSpotId}
            onPendingSpotConsumed={() => setPendingSpotId(null)}
            onPendingSpotUnavailable={() => {
              setCurrentView(AppView.NOTIFICATIONS);
              setPushToast({
                title: t('notifications.ping_unavailable'),
                body: '',
                intent: { version: 1, type: 'notifications' },
              });
            }}
            pendingMyCarOpen={pendingMyCarOpen}
            onPendingMyCarConsumed={() => setPendingMyCarOpen(false)}
            allowLocationTracking={locationAccess === 'granted'}
            showPrimaryNavigation={currentView === AppView.MAP}
            unreadMessagesCount={unreadMessagesCount}
            onPendingUpdatesCountChange={setPendingUpdatesCount}
          />
          {currentView === AppView.MESSAGES && (
            <div className="fixed inset-0 z-50 bg-[var(--color-bg)]">
              <MessagesView
                user={user}
                activeChatContext={activeChatContext}
                onBack={() => {
                  setActiveChatContext(null);
                  setChatReturnSpotId(null);
                  setCurrentView(AppView.MAP);
                }}
                setView={navigatePrimary}
                unreadMessagesCount={unreadMessagesCount}
                pendingUpdatesCount={pendingUpdatesCount}
              />
            </div>
          )}
        </>
      );
    }

    switch (currentView) {
      case AppView.ONBOARDING:
        return <OnboardingView
          onComplete={() => { localStorage.setItem('hasSeenOnboarding', '1'); setCurrentView(AppView.CREATE_ACCOUNT); }}
        />;
      case AppView.CREATE_ACCOUNT:
        return <CreateAccountView
          onContinue={handleCreateAccount}
          onOpenLegal={document => setViewWithLegalReturn(legalViewFor(document))}
        />;
      case AppView.VERIFY_PHONE:
        return <VerifyPhoneView
          phone={phone}
          confirmationResult={confirmationResult!}
          onVerify={async () => {
            // Primary: look up by UID — all user docs use firebaseUser.uid as doc ID.
            const uid = auth.currentUser?.uid;
            if (!uid) { setCurrentView(AppView.SETUP_PROFILE); return; }
            const userDoc = await getDoc(doc(db, 'users', uid));
            if (userDoc.exists()) {
              setUser({ id: uid, ...userDoc.data() });
              setCurrentView(locationAccess === 'unknown' ? AppView.LOCATION_PROMPT : AppView.MAP);
            } else {
              setCurrentView(AppView.SETUP_PROFILE);
            }
          }}
          onEditNumber={() => setCurrentView(AppView.CREATE_ACCOUNT)}
        />;
      case AppView.SETUP_PROFILE:
        return <NameEntryView onComplete={handleNameComplete} />;
      case AppView.COMPLETE_PROFILE:
        return <SetupProfileView phone={phone} onSave={handleSaveProfile} onSkip={() => setCurrentView(AppView.PROFILE)} />;
      case AppView.EDIT_PROFILE:
        return <EditProfileView onBack={() => setCurrentView(AppView.SETTINGS)} />;
      case AppView.AI_ASSISTANT:
        // AssistantView owns its own header. The app-level bar used to render a
        // second title, subtitle and back button directly above the view's own,
        // which is what made the screen read as stacked and crowded.
        return (
          <div className="h-full flex flex-col bg-[var(--color-bg)]">
            <AssistantView
              onBack={() => setCurrentView(AppView.MAP)}
              onOpenMyCar={() => { setPendingMyCarOpen(true); setCurrentView(AppView.MAP); }}
            />
          </div>
        );

      case AppView.PROFILE:
        return <ProfileView user={user} setView={navigatePrimary} onBack={() => setCurrentView(AppView.MAP)} unreadMessagesCount={unreadMessagesCount} pendingUpdatesCount={pendingUpdatesCount} />;
      case AppView.SETTINGS:
        return <SettingsView user={user} setView={setViewWithLegalReturn} onBack={() => setCurrentView(AppView.PROFILE)} onLogout={handleLogout} onDeleteAccount={handleDeleteAccount} theme={theme} toggleTheme={toggleTheme} permissionState={nearbyPermissionState(locationAccess, { locationServicesEnabled })} notificationRuntime={notificationRuntime} />;
      case AppView.NOTIFICATIONS_SETTINGS:
        return <NotificationsSettingsView user={user} onBack={() => setCurrentView(AppView.SETTINGS)} notificationRuntime={notificationRuntime} notificationBusy={notificationBusy} onEnableNotifications={handleEnableNotifications} onRecheckNotifications={handleRecheckNotifications} />;
      case AppView.LOCATION_SETTINGS:
        return <LocationSettingsView user={user} onBack={() => setCurrentView(AppView.SETTINGS)} permissionState={nearbyPermissionState(locationAccess, { locationServicesEnabled })} callbacks={locationCallbacks} />;
      case AppView.LANGUAGE_SETTINGS:
        return <LanguageSettingsView user={user} onBack={() => setCurrentView(AppView.SETTINGS)} />;
      case AppView.NOTIFICATIONS:
        return <NotificationsView user={user} onBack={() => setCurrentView(AppView.MAP)} onSelectSpot={(id) => { setPendingSpotId(id); setCurrentView(AppView.MAP); }} permissionState={nearbyPermissionState(locationAccess, { locationServicesEnabled })} callbacks={locationCallbacks} notificationRuntime={notificationRuntime} notificationBusy={notificationBusy} onEnableNotifications={handleEnableNotifications} onRecheckNotifications={handleRecheckNotifications} setView={navigatePrimary} unreadMessagesCount={unreadMessagesCount} pendingUpdatesCount={pendingUpdatesCount} />;
      case AppView.ADMIN_LOGIN:
        return <AdminLoginView onVerified={() => setCurrentView(AppView.ADMIN_DASHBOARD)} />;
      case AppView.ADMIN_DASHBOARD:
        return <AdminDashboardView onLogout={handleLogout} />;
      case AppView.PARKING_SPACE:
        return <ActivitiesView user={user} onBack={() => setCurrentView(AppView.PROFILE)} />;
      case AppView.PRIVACY_POLICY:
        return <PrivacyPolicyView onBack={closeLegal} />;
      case AppView.TERMS_OF_USE:
        return <TermsOfUseView onBack={closeLegal} />;
      case AppView.CONTACT_US:
        return <ContactUsView onBack={() => setCurrentView(AppView.PROFILE)} />;
      case AppView.EDIT_VEHICLE: {
        const afterVehicle = locationAccess === 'unknown' ? AppView.LOCATION_PROMPT : AppView.MAP;
        return <EditVehicleView
          user={user}
          onBack={() => { setVehicleOnboarding(false); setCurrentView(vehicleOnboarding ? afterVehicle : AppView.PROFILE); }}
          isOnboarding={vehicleOnboarding}
          onSkip={() => { setVehicleOnboarding(false); setCurrentView(afterVehicle); }}
        />;
      }
      case AppView.LOCATION_PROMPT:
        return <LocationPromptView
          onComplete={(access) => {
            persistAccessChoice(access);
            setLocationAccess(access);
            setCurrentView(AppView.MAP);
          }}
        />;
      default:
        return <CreateAccountView
          onContinue={handleCreateAccount}
          onOpenLegal={document => setViewWithLegalReturn(legalViewFor(document))}
        />;
    }
  };

  const isMapView = currentView === AppView.MAP || currentView === AppView.MESSAGES;

  return (
    <div className="h-full w-full flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] font-sans selection:bg-queen-500 selection:text-white transition-colors duration-300">
      <main className={`flex-1 min-h-0 relative ${isMapView ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        <ErrorBoundary>
          <Suspense fallback={<LoadingScreen />}>
            {renderView()}
          </Suspense>
        </ErrorBoundary>
      </main>

      {pushToast && (
        <ForegroundNotificationToast
          title={pushToast.title}
          body={pushToast.body}
          openLabel={t('notifications.open_action')}
          dismissLabel={t('notifications.dismiss_action')}
          onOpen={() => {
            notificationIntentQueueRef.current?.accept(pushToast.intent);
            setPushToast(null);
          }}
          onDismiss={() => setPushToast(null)}
        />
      )}

      {titleUnlock && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-[var(--color-glass)] backdrop-blur-xl border border-yellow-500/30 rounded-2xl px-6 py-4 shadow-2xl text-center pointer-events-none">
          <div className="text-3xl mb-1">👑</div>
          <p className="text-sm font-bold text-[var(--color-text)]">New Title Unlocked!</p>
          <p className="text-base font-extrabold text-[var(--color-warning)] mt-0.5">{titleUnlock}</p>
        </div>
      )}

      {deletePhase !== 'idle' && (
        <AccessibleModal
          ariaLabel={t('settings.delete_confirm_title')}
          initialFocusRef={deleteCancelRef}
          onDismiss={deletePhase === 'deleting' ? undefined : handleDeleteModalDismiss}
          overlayClassName="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-4"
          panelClassName="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-2xl p-6 max-w-sm w-full"
        >
            {deletePhase === 'confirming' && (
              <>
                <h2 className="text-xl font-bold text-red-500 mb-2">{t('settings.delete_confirm_title')}</h2>
                <p className="text-sm text-[var(--color-text-secondary)] mb-6">{t('settings.delete_confirm_body')}</p>
                <div className="flex gap-3">
                  <button
                    ref={deleteCancelRef}
                    onClick={() => setDeletePhase('idle')}
                    className="flex-1 py-3 rounded-xl border border-[var(--color-border)] text-[var(--color-text)] font-medium"
                  >
                    {t('settings.delete_cancel')}
                  </button>
                  <button
                    onClick={handleDeleteConfirm}
                    className="flex-1 py-3 rounded-xl bg-red-600 text-white font-semibold"
                  >
                    {t('settings.delete_account')}
                  </button>
                </div>
              </>
            )}
            {deletePhase === 'deleting' && (
              <p className="text-center text-[var(--color-text)] py-4">{t('settings.delete_deleting')}</p>
            )}
            {deletePhase === 'failed' && (
              <>
                <p className="text-center text-red-500 mb-4">{t('settings.delete_failed')}</p>
                <div className="flex gap-3">
                  <button
                    ref={deleteCancelRef}
                    onClick={() => setDeletePhase('idle')}
                    className="flex-1 py-3 rounded-xl border border-[var(--color-border)] text-[var(--color-text)]"
                  >
                    {t('settings.delete_cancel')}
                  </button>
                  <button
                    onClick={handleDeleteConfirm}
                    className="flex-1 py-3 rounded-xl bg-red-600 text-white font-semibold"
                  >
                    {t('settings.delete_retry')}
                  </button>
                </div>
              </>
            )}
            {deletePhase === 'reauth_entering_phone' && (
              <>
                <h2 className="text-lg font-bold text-[var(--color-text)] mb-1">{t('settings.delete_reauth_title')}</h2>
                <p className="text-sm text-[var(--color-text-secondary)] mb-4">{t('settings.delete_reauth_phone_hint')}</p>
                {reauthError && <p role="alert" className="text-sm text-[var(--color-danger)] mb-4">{reauthError}</p>}
                <p
                  aria-live="assertive"
                  className="w-full mb-4 px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] text-center tracking-widest select-none"
                >
                  {maskPhoneNumber(auth.currentUser?.phoneNumber ?? '')}
                </p>
                <div className="flex gap-3">
                  <button
                    ref={deleteCancelRef}
                    onClick={() => { clearReauthState(); setDeletePhase('idle'); }}
                    className="flex-1 py-3 rounded-xl border border-[var(--color-border)] text-[var(--color-text)] font-medium"
                  >{t('settings.delete_cancel')}</button>
                  <button
                    onClick={handleReauthSendOtp}
                    className="flex-1 py-3 rounded-xl bg-red-600 text-white font-semibold"
                  >{t('settings.delete_reauth_send_code')}</button>
                </div>
              </>
            )}
            {deletePhase === 'reauth_verifying_otp' && (
              <>
                <h2 className="text-lg font-bold text-[var(--color-text)] mb-1">{t('settings.delete_reauth_title')}</h2>
                <p className="text-sm text-[var(--color-text-secondary)] mb-4">{t('settings.delete_reauth_otp_hint')}</p>
                {reauthError && <p role="alert" className="text-sm text-[var(--color-danger)] mb-4">{reauthError}</p>}
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={reauthOtp}
                  onChange={e => setReauthOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  className="w-full mb-3 px-4 py-3 rounded-xl border border-[var(--color-border)] bg-transparent text-[var(--color-text)] text-center tracking-widest text-xl placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:border-red-500"
                />
                <div className="flex gap-3 mb-3">
                  <button
                    ref={deleteCancelRef}
                    onClick={() => { clearReauthState(); setDeletePhase('idle'); }}
                    className="flex-1 py-3 rounded-xl border border-[var(--color-border)] text-[var(--color-text)] font-medium"
                  >{t('settings.delete_cancel')}</button>
                  <button
                    onClick={handleReauthVerifyOtp}
                    disabled={reauthOtp.length < 6}
                    className="flex-1 py-3 rounded-xl bg-red-600 disabled:opacity-50 text-white font-semibold"
                  >{t('settings.delete_reauth_verify')}</button>
                </div>
                <button
                  onClick={handleReauthResend}
                  disabled={reauthResendCooldown > 0}
                  className="w-full text-sm text-[var(--color-text-secondary)] disabled:opacity-40"
                >
                  {reauthResendCooldown > 0
                    ? `${t('settings.delete_reauth_resend')} (${reauthResendCooldown}s)`
                    : t('settings.delete_reauth_resend')}
                </button>
              </>
            )}
            {/* Invisible reCAPTCHA anchor — must remain in DOM whenever the modal is open */}
            <div id="reauth-recaptcha-anchor" />
        </AccessibleModal>
      )}
    </div>
  );
}
