import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { resolveMessagesAndroidBack } from '../utils/androidBackNavigation';
import { AccessibleModal } from '../components/AccessibleModal';
import { Send, ChevronLeft, MoreVertical, Sparkles, ArrowLeft, MapPin, MessageSquare, CheckCheck } from 'lucide-react';
import { generateSmartReplies, createSmartReplyRequestKey } from '../services/geminiService';
import { collection, query, where, onSnapshot, addDoc, doc, setDoc, orderBy, serverTimestamp, getDoc, getDocs, limit, startAfter, updateDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { db } from '../firebase';
import { moderateMessage } from '../utils/moderation';
import { reportCriticalActionFailure } from '../utils/errorReporting';
import { chatShellCreatePayload, ensureChatShell } from '../utils/chatShell';
import { t, useLang } from '../i18n';
import { AppView } from '../types';
import { NavigationBar } from './street-parking/NavigationBar';
import { notifyChatRead } from './street-parking/useUnreadMessages';

export type MessagesAndroidBackHandle = {
  handleAndroidBack: () => void;
};

interface MessagesViewProps {
  user: any;
  activeChatContext: { userId: string; context: string } | null;
  onBack: () => void;
  setView?: (view: AppView) => void;
  unreadMessagesCount?: number;
  pendingUpdatesCount?: number;
  /** Optional ref so App can mirror visible Messages Back for Android system Back. */
  androidBackRef?: React.MutableRefObject<MessagesAndroidBackHandle | null>;
}

// Realtime window size for the newest messages in an open conversation —
// older history is loaded explicitly via loadOlderMessages(). Current
// production p90 is 7 messages/chat, so 30 comfortably covers virtually
// every conversation today while bounding initial read/render cost as
// conversations age. Not user-configurable.
const MESSAGE_PAGE_SIZE = 30;

// Prepending older history must not visually yank the viewport — restoring
// scrollTop to the same point in the (now taller) content preserves the
// reader's position. Exported as a pure function so the formula itself can
// be pinned directly without simulating a fake browser layout.
export function computeRestoredScrollTop(prevScrollTop: number, prevScrollHeight: number, newScrollHeight: number): number {
  return prevScrollTop + (newScrollHeight - prevScrollHeight);
}

// Calendar-day distance, rounded so a DST day (23h/25h) still counts as one.
function daysBetween(earlier: Date, later: Date): number {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(later) - start(earlier)) / 86_400_000);
}

// Inbox row stamp: a time today, "Yesterday", a weekday this week, else a date.
// A bare "07:58 PM" on a day-old thread read as today.
export function formatThreadTime(d: Date, now: Date, locale: string, yesterday: string): string {
  const days = daysBetween(d, now);
  if (days <= 0) return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return yesterday;
  if (days < 7) return d.toLocaleDateString(locale, { weekday: 'short' });
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function formatDayLabel(d: Date, now: Date, locale: string, today: string, yesterday: string): string {
  const days = daysBetween(d, now);
  if (days <= 0) return today;
  if (days === 1) return yesterday;
  if (days < 7) return d.toLocaleDateString(locale, { weekday: 'long' });
  return d.toLocaleDateString(locale, d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

// Consecutive messages from one side within a few minutes on the same day read
// as one burst: tighter spacing, one timestamp at the end of the burst.
const GROUP_GAP_MS = 5 * 60_000;
export function groupThread<T extends { isMe: boolean; timestamp: Date }>(msgs: T[]) {
  const joins = (a: T | undefined, b: T | undefined) => !!a && !!b && a.isMe === b.isMe
    && daysBetween(a.timestamp, b.timestamp) === 0
    && b.timestamp.getTime() - a.timestamp.getTime() <= GROUP_GAP_MS;
  return msgs.map((msg, i) => ({
    msg,
    newDay: i === 0 || daysBetween(msgs[i - 1].timestamp, msg.timestamp) !== 0,
    startsGroup: !joins(msgs[i - 1], msg),
    endsGroup: !joins(msg, msgs[i + 1]),
  }));
}

const avatarGradients = [
  'linear-gradient(135deg,#1e3a5f,#1e40af)',
  'linear-gradient(135deg,#1a2e1a,#14532d)',
  'linear-gradient(135deg,#2e1a2e,#581c87)',
  'linear-gradient(135deg,#3b2a1a,#92400e)',
];

const Avatar: React.FC<{ name: string; url?: string | null; size: number; radius: number }> = ({ name, url, size, radius }) => {
  const initial = name.charAt(0).toUpperCase();
  return (
    <span
      className="pq-avatar"
      style={{ width: size, height: size, borderRadius: radius, fontSize: size * 0.38, background: avatarGradients[initial.charCodeAt(0) % avatarGradients.length] }}
      aria-hidden="true"
    >
      {url ? <img src={url} alt="" className="w-full h-full object-cover" /> : initial}
    </span>
  );
};

export const MessagesView: React.FC<MessagesViewProps> = ({
  user, activeChatContext, onBack, setView, unreadMessagesCount = 0, pendingUpdatesCount = 0,
  androidBackRef,
}) => {
  const lang = useLang();
  const locale = lang === 'es' ? 'es-US' : 'en-US';
  const [conversations, setConversations] = useState<any[]>([]);
  // Never seed this from activeChatContext: a Ping-opened NEW chat has no
  // parent document yet, and the messages listener (effect 3) would attach
  // against a nonexistent chats/{chatId} and receive permission-denied.
  // initChat confirms/creates the shell first, then sets the id.
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  // Expose Android system-Back handling that mirrors the visible Back controls.
  useEffect(() => {
    if (!androidBackRef) return;
    androidBackRef.current = {
      handleAndroidBack: () => {
        const action = resolveMessagesAndroidBack({
          activeConversationId,
          openedFromPing: Boolean(activeChatContext),
        });
        if (action === 'closeThread') {
          setActiveConversationId(null);
          return;
        }
        onBack();
      },
    };
    return () => {
      androidBackRef.current = null;
    };
  }, [androidBackRef, activeConversationId, activeChatContext, onBack]);

  const [messages, setMessages] = useState<any[]>([]);
  const [inputText, setInputText] = useState('');
  const [moderationError, setModerationError] = useState('');
  const [sending, setSending] = useState(false);
  const [smartReplies, setSmartReplies] = useState<string[]>([]);
  // False until the open conversation's first messages snapshot lands, so an
  // empty thread is never shown as "no messages" while it is still loading.
  const [messagesReady, setMessagesReady] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastSmartReplyKey = useRef<string | null>(null);

  // ── Bounded message history pagination ──────────────────────────────
  // retainedMessagesRef accumulates every message this session has loaded
  // for the active conversation (live + explicitly paginated) — it is the
  // source of truth for what's displayed (`messages`, derived below) and
  // is NEVER pruned by a live-query 'removed' event. liveWindowIdsRef only
  // tracks which IDs currently sit inside the realtime newest-window query,
  // purely to interpret 'removed' vs 'added'/'modified' — a message leaving
  // the live window (pushed out by a newer one) and a message being
  // deleted server-side (mid deleteChat) produce the identical event, and
  // the only safe way to tell them apart is to wait for the
  // conversations-list listener to report the whole chat gone.
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const retainedMessagesRef = useRef<Map<string, any>>(new Map());
  const liveWindowIdsRef = useRef<Set<string>>(new Set());
  const oldestLoadedCursorRef = useRef<any>(null);
  const conversationGenerationRef = useRef(0);
  const isLoadingOlderRef = useRef(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const pendingScrollRestoreRef = useRef<{ prevScrollTop: number; prevScrollHeight: number } | null>(null);
  const suppressAutoScrollRef = useRef(false);
  const prevConversationIdsRef = useRef<Set<string>>(new Set());

  const toMessage = (docSnap: any) => {
    const data = docSnap.data();
    return {
      id: docSnap.id,
      senderId: data.senderId,
      text: data.text || '',
      timestamp: data.timestamp?.toDate() || new Date(),
      isMe: data.senderId === user?.id,
    };
  };
  const sortedRetainedMessages = () =>
    Array.from(retainedMessagesRef.current.values()).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const [userProfilesCache, setUserProfilesCache] = useState<Record<string, { name: string; avatarUrl: string | null }>>({});
  // Mirrors userProfilesCache so the hydration effect below always checks
  // the freshest cache membership rather than a closure captured at the
  // point this effect last re-ran (deps are [conversations, db], not
  // userProfilesCache).
  const userProfilesCacheRef = useRef(userProfilesCache);
  useEffect(() => { userProfilesCacheRef.current = userProfilesCache; }, [userProfilesCache]);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingChat, setDeletingChat] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const reportCancelRef = useRef<HTMLButtonElement>(null);

  const lastThreadMetaRef = useRef<{ otherUserId: string; relatedSpotTitle: string } | null>(null);
  const composerFocusedRef = useRef(false);

  const activeConversation = conversations.find(c => c.id === activeConversationId);
  if (activeConversation) {
    lastThreadMetaRef.current = {
      otherUserId: activeConversation.otherUser.id,
      relatedSpotTitle: activeConversation.relatedSpotTitle || '',
    };
  }
  if (!activeConversationId) {
    lastThreadMetaRef.current = null;
  }

  // Header meta must not depend on the chats snapshot being present this
  // render. After Ping init, activeConversationId is set before the list
  // listener has the new shell; gating the thread on `activeConversation`
  // would unmount the inbox and remount the composer, which dismisses the
  // Android keyboard. Keep the thread mounted for the whole id lifetime.
  const threadOtherUserId = activeConversation?.otherUser?.id
    || lastThreadMetaRef.current?.otherUserId
    || (activeConversationId ? activeChatContext?.userId : undefined)
    || '';
  const threadSpotTitle = activeConversation?.relatedSpotTitle
    || lastThreadMetaRef.current?.relatedSpotTitle
    || (activeConversationId ? (activeChatContext?.context || '') : '')
    || '';

  // Server-mediated deletion (see functions/index.js deleteChat) — the
  // client no longer enumerates or batch-deletes messages itself, so
  // deletion cost/client work no longer grows with conversation length.
  const doDeleteChat = async () => {
    if (!activeConversationId || deletingChat) return;
    setDeletingChat(true);
    try {
      const functions = getFunctions(getApp(), 'us-central1');
      await httpsCallable(functions, 'deleteChat')({ chatId: activeConversationId });
      setActiveConversationId(null);
    } catch (e) {
      console.error("Error deleting chat:", e);
      // Single generic path for every failure here (no business-rule branching
      // to exclude) — client-side reporting is the only signal for failures
      // that never reach the callable at all (network/App Check).
      reportCriticalActionFailure('chat_delete', e);
      showToast(t('messages.toast_delete_failed'), true);
    } finally {
      setDeletingChat(false);
      setShowDeleteConfirm(false);
    }
  };

  const [showReportModal, setShowReportModal] = useState(false);
  const [actionToast, setActionToast] = useState('');
  // Failures and confirmations share one slot; the tone keeps a failure from
  // reading as a success.
  const [toastIsError, setToastIsError] = useState(false);

  const showToast = (msg: string, isError = false) => { setActionToast(msg); setToastIsError(isError); setTimeout(() => setActionToast(''), 3000); };

  // Report reasons: value written to Firestore (English stays), label is translated display
  const reportReasons = [
    { value: 'Harassment or abuse', label: t('messages.report_harassment') },
    { value: 'Inappropriate messages', label: t('messages.report_inappropriate') },
    { value: 'Spam', label: t('messages.report_spam') },
    { value: 'Scam or fraud', label: t('messages.report_scam') },
    { value: 'Other', label: t('messages.report_other') },
  ];

  const closeDeleteConfirm = () => {
    if (deletingChat) return;
    setShowDeleteConfirm(false);
  };

  const handleBlockUser = async () => {
    if (!activeConversation) return;
    const otherUserId = activeConversation.otherUser.id;
    try {
      const currentBlocked = user.blockedUsers || [];
      if (!currentBlocked.includes(otherUserId)) {
        await updateDoc(doc(db, "users", user.id, "private", "social"), {
          blockedUsers: [...currentBlocked, otherUserId]
        });
      }
      showToast(t('messages.toast_blocked'));
      setActiveConversationId(null);
    } catch (e) {
      console.error("Error blocking user:", e);
      showToast(t('messages.toast_block_failed'), true);
    }
  };

  const handleReportUser = async (reason: string) => {
    if (!activeConversation || !reason.trim()) return;
    const otherUserId = activeConversation.otherUser.id;
    try {
      await addDoc(collection(db, "reports"), {
        reporterId: user.id,
        reportedUserId: otherUserId,
        type: 'behavior',
        reason: reason.trim(),
        status: 'pending',
        conversationId: activeConversationId,
        createdAt: serverTimestamp()
      });
      showToast(t('messages.toast_reported'));
      setShowReportModal(false);
    } catch (e) {
      console.error("Error reporting user:", e);
      showToast(t('messages.toast_report_failed'), true);
    }
  };

  // Dynamic User Profile Resolver & Cache to fix 'User' / 'Anonymous' fallback issues.
  // Missing partner profiles are fetched concurrently (Promise.all) instead
  // of one getDoc per uid awaited in series — same bounded set of reads,
  // shorter critical path (max of the individual round-trips instead of
  // their sum).
  useEffect(() => {
    if (conversations.length === 0 || !db) return;

    const missingUserIds = Array.from(new Set(
      conversations
        .map(c => c.otherUser.id)
        .filter(id => id && !userProfilesCacheRef.current[id])
    ));

    if (missingUserIds.length === 0) return;

    let cancelled = false;

    Promise.all(missingUserIds.map(async uid => {
      try {
        const userDocSnap = await getDoc(doc(db, "users", uid));
        if (userDocSnap.exists()) {
          const data = userDocSnap.data();
          return [uid, { name: data.fullName || '', avatarUrl: data.avatarUrl || null }] as const;
        }
      } catch (e) {
        console.warn("Failed to fetch user profile for cache:", uid, e);
      }
      return null;
    })).then(results => {
      if (cancelled) return;
      const entries = results.filter((r): r is readonly [string, { name: string; avatarUrl: string | null }] => r !== null);
      if (entries.length === 0) return;
      // Functional update — merges against whatever userProfilesCache is at
      // apply-time, so a slower, earlier-started hydration resolving after a
      // faster, later one cannot clobber entries the later one already added.
      setUserProfilesCache(prev => {
        const next = { ...prev };
        entries.forEach(([uid, val]) => { next[uid] = val; });
        return next;
      });
    });

    return () => { cancelled = true; };
  }, [conversations, db]);

  // 1. Fetch conversations list for user
  useEffect(() => {
    if (!user || !db) return;
    const q = query(
      collection(db, "chats"),
      where("participants", "array-contains", user.id)
    );
    const unsubscribe = onSnapshot(q, (snap) => {
      const list = snap.docs.map(docSnap => {
        const data = docSnap.data();
        const otherUserId = data.participants.find((p: string) => p !== user.id) || '';
        // Display name always comes from the live users/{uid}.fullName
        // lookup (userProfilesCache, populated by the effect below) —
        // participantNames no longer exists in the schema.

        let timestampDate = new Date();
        if (data.lastMessageTimestamp) {
          if (typeof data.lastMessageTimestamp.toDate === 'function') {
            timestampDate = data.lastMessageTimestamp.toDate();
          } else {
            timestampDate = new Date(data.lastMessageTimestamp);
          }
        }

        return {
          ...data,
          id: docSnap.id,
          otherUser: { id: otherUserId },
          lastMessage: data.lastMessage || '',
          lastMessageTimestamp: timestampDate,
          unreadCount: 0,
          relatedSpotTitle: data.relatedSpotTitle || ''
        };
      });
      // Sort desc by last message timestamp
      list.sort((a, b) => b.lastMessageTimestamp.getTime() - a.lastMessageTimestamp.getTime());

      const blockedList = user?.blockedUsers || [];
      const filteredList = list.filter(conv => !blockedList.includes(conv.otherUser.id));
      setConversations(filteredList);
    });
    return () => unsubscribe();
  }, [user?.id, JSON.stringify(user?.blockedUsers)]);

  // 2. Handle activeChatContext passed from a Ping "Message" tap.
  // Do not getDoc the chat first: a brand-new deterministic chat has no
  // document, and `allow read: if chatParticipant(resource.data)` denies
  // that existence probe. Create-only setDoc is allowed; if the shell
  // already exists, update is denied and ensureChatShell treats that as
  // already-exists. The messages listener (effect 3) must not attach until
  // this completes — activeConversationId stays null until then.
  useEffect(() => {
    if (!user || !activeChatContext || !db) return;

    let cancelled = false;
    const payload = chatShellCreatePayload(
      user.id,
      activeChatContext.userId,
      activeChatContext.context || 'Street Spot',
    );
    const chatId = payload.id;

    const initChat = async () => {
      const alreadyListed = conversationsRef.current.some(c => c.id === chatId);
      if (!alreadyListed) {
        try {
          await ensureChatShell(
            (shell) => setDoc(doc(db, 'chats', shell.id), shell),
            payload,
          );
        } catch (e: any) {
          if (cancelled) return;
          const code: string = e?.code ?? '';
          console.error('Error initializing chat:', e);
          reportCriticalActionFailure('chat_init', e, code ? { errorCode: code } : undefined);
          showToast(t('messages.toast_open_failed'), true);
          return;
        }
      }
      if (!cancelled) setActiveConversationId(chatId);
    };

    initChat();
    return () => { cancelled = true; };
  }, [user?.id, activeChatContext]);

  // 3. Listen to the newest MESSAGE_PAGE_SIZE messages for the active
  // conversation in realtime; older history is loaded explicitly via
  // loadOlderMessages(). See the state block above for the
  // retainedMessagesRef/liveWindowIdsRef contract.
  // Invariant: activeConversationId is only set for an existing parent
  // (inbox click) or after initChat confirms/creates the shell. Do not
  // attach this listener to a chat id that has not been confirmed.
  useEffect(() => {
    retainedMessagesRef.current = new Map();
    liveWindowIdsRef.current = new Set();
    oldestLoadedCursorRef.current = null;
    conversationGenerationRef.current++;
    const myGeneration = conversationGenerationRef.current;
    isLoadingOlderRef.current = false;
    setMessages([]);
    setMessagesReady(false);
    setHasMoreOlder(false);
    setIsLoadingOlder(false);

    if (!activeConversationId || !user || !db) {
      return;
    }

    const q = query(
      collection(db, "chats", activeConversationId, "messages"),
      orderBy("timestamp", "desc"),
      limit(MESSAGE_PAGE_SIZE)
    );

    let isFirstSnapshot = true;

    const unsubscribe = onSnapshot(q, (snap) => {
      // Defensive guard: real Firestore never invokes a callback after
      // unsubscribe(), but this protects against that assumption anyway —
      // a callback whose generation has since moved on (conversation
      // switched, or the effect re-ran) must never mutate the current
      // conversation's state.
      if (conversationGenerationRef.current !== myGeneration) return;

      const retained = retainedMessagesRef.current;
      const liveIds = liveWindowIdsRef.current;

      snap.docChanges().forEach((change: any) => {
        if (change.type === 'removed') {
          // Window eviction OR server-mediated whole-chat deletion in
          // progress — never inferred from this event alone. Only stop
          // tracking membership in the live window; retained history stays
          // until the conversations-list listener says the whole chat is
          // gone (see the effect below).
          liveIds.delete(change.doc.id);
          return;
        }
        const msg = toMessage(change.doc);
        retained.set(msg.id, msg);
        liveIds.add(msg.id);
      });

      if (isFirstSnapshot) {
        isFirstSnapshot = false;
        // The historical pagination boundary — oldest document actually
        // returned by THIS initial page. Never moved forward by later
        // window eviction; only ever advanced by a successful
        // loadOlderMessages() page.
        if (snap.docs.length > 0) {
          oldestLoadedCursorRef.current = snap.docs[snap.docs.length - 1];
        }
        setHasMoreOlder(snap.docs.length === MESSAGE_PAGE_SIZE);
        setMessagesReady(true);
      }

      setMessages(sortedRetainedMessages());
    });

    return () => {
      unsubscribe();
      // Invalidates any in-flight loadOlderMessages() request captured
      // against this generation, whether due to a conversation switch or a
      // full component unmount.
      conversationGenerationRef.current++;
    };
  }, [activeConversationId, user?.id]);

  // If the active conversation disappears from the participant's own chats
  // list (deleted by either participant via deleteChat), exit the detail
  // view — the effect above then tears down the message listener and
  // resets pagination state as part of its own activeConversationId
  // change. Guarded against "not yet arrived" (a brand-new conversation)
  // by only clearing when the id was PREVIOUSLY present and is now gone —
  // never inferred from a message-level 'removed' event.
  useEffect(() => {
    const currentIds = new Set(conversations.map(c => c.id));
    if (
      activeConversationId &&
      prevConversationIdsRef.current.has(activeConversationId) &&
      !currentIds.has(activeConversationId)
    ) {
      setActiveConversationId(null);
    }
    prevConversationIdsRef.current = currentIds;
  }, [conversations, activeConversationId]);

  const loadOlderMessages = async () => {
    if (!activeConversationId || !hasMoreOlder || isLoadingOlderRef.current || !oldestLoadedCursorRef.current) return;
    const myGeneration = conversationGenerationRef.current;
    const cursor = oldestLoadedCursorRef.current;
    isLoadingOlderRef.current = true;
    setIsLoadingOlder(true);
    try {
      const q = query(
        collection(db, "chats", activeConversationId, "messages"),
        orderBy("timestamp", "desc"),
        startAfter(cursor),
        limit(MESSAGE_PAGE_SIZE)
      );
      const snap = await getDocs(q);
      if (conversationGenerationRef.current !== myGeneration) return; // stale — conversation switched or unmounted

      snap.docs.forEach((docSnap: any) => {
        const msg = toMessage(docSnap);
        retainedMessagesRef.current.set(msg.id, msg);
      });
      if (snap.docs.length > 0) {
        oldestLoadedCursorRef.current = snap.docs[snap.docs.length - 1];
      }
      setHasMoreOlder(snap.docs.length === MESSAGE_PAGE_SIZE);

      const container = messagesContainerRef.current;
      if (container) {
        pendingScrollRestoreRef.current = { prevScrollTop: container.scrollTop, prevScrollHeight: container.scrollHeight };
      }
      suppressAutoScrollRef.current = true;
      setMessages(sortedRetainedMessages());
    } catch (e) {
      console.error("Error loading earlier messages:", e);
      showToast(t('messages.toast_load_earlier_failed'), true);
      // Already-loaded history, cursor, and hasMoreOlder are left exactly
      // as they were — retry remains possible via the still-visible control.
    } finally {
      if (conversationGenerationRef.current === myGeneration) {
        isLoadingOlderRef.current = false;
        setIsLoadingOlder(false);
      }
    }
  };

  // Restores the reader's visual position after prepending older history —
  // runs before paint, so no scroll jump is visible.
  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    if (pending && messagesContainerRef.current) {
      const container = messagesContainerRef.current;
      container.scrollTop = computeRestoredScrollTop(pending.prevScrollTop, pending.prevScrollHeight, container.scrollHeight);
      pendingScrollRestoreRef.current = null;
    }
  }, [messages]);

  // Update last read timestamp in localStorage when active chat receives messages
  useEffect(() => {
    if (activeConversationId) {
      localStorage.setItem(`lastReadChat_${activeConversationId}`, Date.now().toString());
      notifyChatRead();
    }
    setIsMenuOpen(false);
  }, [activeConversationId, messages.length]);

  // 4. Auto-scroll to bottom on initial open / a new live message — NOT on
  // a loadOlderMessages() prepend (suppressed above via suppressAutoScrollRef).
  useEffect(() => {
    if (suppressAutoScrollRef.current) {
      suppressAutoScrollRef.current = false;
      return;
    }
    // Smooth scrollIntoView while an input is focused dismisses the Android
    // WebView keyboard (adjustResize + overflow scroll). Skip while typing.
    if (composerFocusedRef.current) return;
    if (activeConversationId && messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [messages, activeConversationId]);

  // Trigger Smart Replies
  useEffect(() => {
    if (activeConversationId && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && !lastMsg.isMe) {
        const key = createSmartReplyRequestKey(activeConversationId, lastMsg.id);
        if (key !== lastSmartReplyKey.current) {
          lastSmartReplyKey.current = key;
          let active = true;
          generateSmartReplies(lastMsg.text, activeConversation?.relatedSpotTitle || threadSpotTitle || "Parking Spot")
            .then(replies => { if (active) setSmartReplies(replies); })
            .catch(err => {
              console.warn("Gemini smart replies failed", err);
              if (active) setSmartReplies([]);
              // Clear key on failure so the next render can retry
              if (lastSmartReplyKey.current === key) lastSmartReplyKey.current = null;
            });
          return () => { active = false; };
        }
      } else {
        setSmartReplies([]);
      }
    }
  }, [messages, activeConversationId]);

  // 5. Send message
  const handleSend = async (text: string) => {
    if (!text.trim() || !activeConversationId || !user || !db || sending) return;
    setModerationError('');

    // UX-only pre-check for instant feedback — NOT a security boundary.
    // sendMessage independently re-runs the authoritative check server-side;
    // a client that skipped this call entirely would gain no bypass.
    const blocked = moderateMessage(text.trim());
    if (blocked) {
        setModerationError(blocked);
        setTimeout(() => setModerationError(''), 4000);
        return;
    }

    const trimmed = text.trim();
    setSending(true);
    try {
        const functions = getFunctions(getApp(), 'us-central1');
        const clientRequestId =
            typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await httpsCallable(functions, 'sendMessage')({
            chatId: activeConversationId,
            clientRequestId,
            text: trimmed,
        });
        localStorage.setItem(`lastReadChat_${activeConversationId}`, Date.now().toString());
        setInputText('');
        setSmartReplies([]);
    } catch (e: any) {
        const code: string = e?.code ?? '';
        if (code === 'functions/invalid-argument') {
            // Server-side moderation rejection — same banner UX as the
            // client-side pre-check above, same non-localized copy for parity.
            setModerationError(e?.message || "This message couldn't be sent. Please revise and try again.");
            setTimeout(() => setModerationError(''), 4000);
        } else if (code === 'functions/resource-exhausted') {
            setModerationError(t('messages.rate_limited'));
            setTimeout(() => setModerationError(''), 4000);
        } else {
            // Genuinely unexpected — the moderation/rate-limit branches above are
            // expected, well-understood outcomes with their own server-side
            // trail; this catch-all is the only class of failure (network,
            // App Check, internal) with no guaranteed diagnostic trail.
            console.error("Error sending message", e);
            reportCriticalActionFailure('message_send', e, code ? { errorCode: code } : undefined);
            showToast(t('messages.toast_send_failed'), true);
        }
    } finally {
        setSending(false);
    }
  };

  if (activeConversationId) {
    const displayName = userProfilesCache[threadOtherUserId]?.name
      || t('messages.anonymous');

    const otherProfile = userProfilesCache[threadOtherUserId];
    const now = new Date();

    return (
      <div className="h-full flex flex-col bg-[var(--color-bg)]">
        {/* Thread header. Carries the safe-area inset itself (mobile-safe-top)
            so its surface runs up under the status bar. One back control;
            the bottom nav is hidden inside a conversation. */}
        <header className="pq-chat-header mobile-safe-top md:pt-3 pb-2.5 px-2 shrink-0 relative z-10">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => activeChatContext ? onBack() : setActiveConversationId(null)}
              aria-label={t('messages.back_chat_aria')}
              className="pq-icon-btn focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
            >
              <ChevronLeft size={24} aria-hidden="true" />
            </button>
            <Avatar name={displayName} url={otherProfile?.avatarUrl} size={40} radius={14} />
            <div className="flex-1 min-w-0 pl-1.5">
              <h1 className="text-[16px] font-extrabold text-[var(--color-text)] leading-tight tracking-tight truncate">{displayName}</h1>
              {threadSpotTitle && (
                <p className="pq-accent-text flex items-center gap-1 text-[12px] font-semibold mt-0.5 min-w-0">
                  <MapPin size={11} aria-hidden="true" className="shrink-0" />
                  <span className="truncate">{threadSpotTitle}</span>
                </p>
              )}
            </div>
            <div className="relative">
              <button
                ref={menuTriggerRef}
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                aria-label={t('messages.menu_aria')}
                aria-haspopup="true"
                aria-expanded={isMenuOpen}
                className="pq-icon-btn text-[var(--color-text-secondary)] focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
              >
                <MoreVertical size={20} aria-hidden="true" />
              </button>
              {isMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setIsMenuOpen(false)} />
                  <div className="pq-menu absolute right-1 mt-1 w-52 rounded-2xl z-50 overflow-hidden">
                    <button onClick={() => { setIsMenuOpen(false); setShowReportModal(true); }} className="pq-menu-item">
                      {t('messages.report_user')}
                    </button>
                    <button onClick={() => { setIsMenuOpen(false); handleBlockUser(); }} className="pq-menu-item">
                      {t('messages.block_user')}
                    </button>
                    <button onClick={() => { setIsMenuOpen(false); setShowDeleteConfirm(true); }} className="pq-menu-item pq-menu-item--danger">
                      {t('messages.delete_chat')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Messages Area */}
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto no-scrollbar px-4 pt-3 pb-4 flex flex-col">
          {hasMoreOlder && (
            <button
              onClick={loadOlderMessages}
              disabled={isLoadingOlder}
              aria-label={t('messages.load_earlier')}
              className="self-center pq-day-sep h-9 px-4 mb-2 disabled:opacity-50"
            >
              {isLoadingOlder ? t('messages.loading_earlier') : t('messages.load_earlier')}
            </button>
          )}

          {!messagesReady && (
            <div role="status" aria-live="polite" className="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--color-text-secondary)]">
              <span className="w-6 h-6 rounded-full border-2 border-[#38bdf8] border-t-transparent animate-spin" aria-hidden="true" />
              <p className="text-[13px] font-semibold">{t('messages.loading')}</p>
            </div>
          )}

          {messagesReady && messages.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-8 pb-10">
              <Avatar name={displayName} url={otherProfile?.avatarUrl} size={64} radius={22} />
              <p className="text-[17px] font-extrabold text-[var(--color-text)] mt-4">{t('messages.thread_empty_title')}</p>
              <p className="text-[13px] text-[var(--color-text-secondary)] mt-1.5 max-w-[28ch] leading-relaxed">{t('messages.thread_empty_body')}</p>
            </div>
          )}

          {/* Short threads sit just above the composer, where the eye is.
              An auto margin collapses to nothing once the thread overflows. */}
          {messages.length > 0 && <div className="mt-auto" aria-hidden="true" />}
          {groupThread(messages).map(({ msg, newDay, startsGroup, endsGroup }) => (
            <React.Fragment key={msg.id}>
              {newDay && (
                <div className="flex justify-center my-3">
                  <span className="pq-day-sep">{formatDayLabel(msg.timestamp, now, locale, t('messages.today'), t('messages.yesterday'))}</span>
                </div>
              )}
              <div className={`flex flex-col ${msg.isMe ? 'items-end' : 'items-start'} ${startsGroup ? 'mt-3' : 'mt-1'}`}>
                <div className={`pq-bubble ${msg.isMe ? 'pq-bubble--me' : 'pq-bubble--them'}${startsGroup ? '' : ' pq-bubble--joined'}`}>
                  <p className="pq-bubble-text">{msg.text}</p>
                </div>
                {endsGroup && (
                  <time className="pq-msg-time mt-1 px-1" dateTime={msg.timestamp.toISOString()}>
                    {msg.timestamp.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}
                  </time>
                )}
              </div>
            </React.Fragment>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Smart Replies */}
        {smartReplies.length > 0 && (
          <div role="group" aria-label={t('messages.smart_replies_aria')} className="shrink-0 px-4 pt-1 pb-2.5 flex items-center gap-2 overflow-x-auto no-scrollbar">
            <Sparkles size={15} aria-hidden="true" className="pq-accent-text shrink-0" />
            {smartReplies.map((reply, idx) => (
              <button key={idx} onClick={() => handleSend(reply)} className="pq-smart-chip shrink-0">
                {reply}
              </button>
            ))}
          </div>
        )}

        {actionToast && (
          <div role={toastIsError ? 'alert' : 'status'} className="shrink-0 px-4 pb-2">
            <p className={`pq-inline-note${toastIsError ? ' pq-inline-note--error' : ''}`}>{actionToast}</p>
          </div>
        )}

        {showDeleteConfirm && (
          <AccessibleModal
            ariaLabel={t('messages.delete_confirm_title')}
            initialFocusRef={deleteCancelRef}
            returnFocusRef={menuTriggerRef}
            onDismiss={deletingChat ? undefined : closeDeleteConfirm}
            overlayClassName="absolute inset-0 z-50 bg-black/50 flex items-end justify-center pb-10"
            panelClassName="bg-[var(--color-surface)] rounded-3xl p-6 mx-4 w-full max-w-sm border border-[var(--color-border)] shadow-2xl"
          >
              <p className="text-base font-bold text-[var(--color-text)] text-center mb-1">{t('messages.delete_confirm_title')}</p>
              <p className="text-sm text-[var(--color-text-secondary)] text-center mb-6">{t('messages.delete_confirm_body')}</p>
              <div className="flex gap-3">
                <button ref={deleteCancelRef} onClick={closeDeleteConfirm} className="flex-1 py-3 rounded-2xl border border-[var(--color-border)] text-[var(--color-text)] font-semibold text-sm">
                  {t('messages.cancel')}
                </button>
                <button onClick={doDeleteChat} disabled={deletingChat} className="flex-1 py-3 rounded-2xl bg-red-500/20 border border-red-500/40 text-[var(--color-danger)] font-bold text-sm disabled:opacity-50">
                  {t('messages.delete')}
                </button>
              </div>
          </AccessibleModal>
        )}

        {showReportModal && (
          <AccessibleModal
            ariaLabel={t('messages.report_title')}
            initialFocusRef={reportCancelRef}
            returnFocusRef={menuTriggerRef}
            onDismiss={() => setShowReportModal(false)}
            overlayClassName="absolute inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
            panelClassName="bg-[var(--color-surface)] rounded-3xl p-5 w-full max-w-sm border border-[var(--color-border)] shadow-2xl"
          >
              <h3 className="font-bold text-[var(--color-text)] mb-3">{t('messages.report_title')}</h3>
              <p className="text-xs text-[var(--color-text-secondary)] mb-4">{t('messages.report_subtitle')}</p>
              <div className="space-y-2">
                {reportReasons.map(({ value, label }) => (
                  <button key={value} onClick={() => handleReportUser(value)}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold bg-white/5 border border-[var(--color-border)] hover:bg-white/10 transition-all text-[var(--color-text)] text-left px-4">
                    {label}
                  </button>
                ))}
              </div>
              <button ref={reportCancelRef} onClick={() => setShowReportModal(false)}
                className="w-full mt-3 text-[var(--color-text-secondary)] text-sm text-center py-2">
                {t('messages.cancel')}
              </button>
          </AccessibleModal>
        )}

        {moderationError && (
          <div role="alert" className="shrink-0 px-4 pb-2">
            <p className="pq-inline-note pq-inline-note--error">{moderationError}</p>
          </div>
        )}

        {/* Composer. Bottom padding follows the home-indicator inset; there is
            no bottom nav inside a conversation to clear. */}
        <div className="pq-composer shrink-0 px-3 pt-2.5" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)' }}>
          <div className="pq-composer-field flex items-center gap-2 pl-4 pr-1">
            <input
              type="text"
              key={activeConversationId}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onFocus={() => { composerFocusedRef.current = true; }}
              onBlur={() => { composerFocusedRef.current = false; }}
              placeholder={t('messages.type_placeholder')}
              aria-label={t('messages.type_placeholder')}
              enterKeyHint="send"
              // 16px: anything smaller makes iOS Safari zoom the page on focus.
              className="pq-composer-input flex-1 min-w-0 h-11 bg-transparent border-none outline-none text-[var(--color-text)] text-[16px]"
              // Enter while an IME is composing confirms the candidate, not a send.
              onKeyDown={(e) => e.key === 'Enter' && !(e.nativeEvent as KeyboardEvent)?.isComposing && handleSend(inputText)}
            />
            <button
              onClick={() => handleSend(inputText)}
              disabled={!inputText.trim() || sending}
              aria-label={t('messages.send_aria')}
              className="pq-send focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
            >
              {sending
                ? <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
                : <Send size={18} aria-hidden="true" className="-ml-0.5" />}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const unreadThreads = conversations.filter(conv => {
    const lastRead = parseInt(localStorage.getItem(`lastReadChat_${conv.id}`) || '0', 10);
    return conv.lastMessageTimestamp.getTime() > lastRead && conv.lastSenderId !== user.id;
  });
  const now = new Date();

  return (
    <div className="mobile-primary-screen mobile-safe-top md:pt-4 md:pb-6 h-full flex flex-col bg-[var(--color-bg)] max-w-md mx-auto w-full">
      {/* Header — centred like Nearby Activity. No Back control on phones:
          Messages is a bottom-nav destination. The nav is md:hidden, so on
          wider screens Back is the only way out of this full-screen overlay
          and stays. */}
      <header className="relative px-5 pt-1.5 pb-3 shrink-0 text-center">
        <button
          onClick={onBack}
          aria-label={t('messages.back_aria')}
          className="pq-icon-btn hidden md:flex absolute left-3 top-0 bg-[var(--color-overlay)] border border-[var(--color-border)]"
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <h1 className="text-[22px] font-extrabold text-[var(--color-text)] leading-tight tracking-tight">{t('messages.title')}</h1>
        <p className="text-[13px] text-[var(--color-text-secondary)] mt-1">{t('messages.subtitle')}</p>
        {conversations.length > 0 && (
          <div className="flex items-center justify-center gap-2 mt-3.5">
            {unreadThreads.length > 0 && (
              <span className="pq-status-chip pq-status-chip--new">
                <span className="pq-live-dot" aria-hidden="true" />
                {t('messages.unread_count', { count: String(unreadThreads.length) })}
              </span>
            )}
            <span className="pq-status-chip">
              <MessageSquare size={12} aria-hidden="true" />
              {conversations.length === 1
                ? t('messages.count_one')
                : t('messages.count_many', { count: String(conversations.length) })}
            </span>
          </div>
        )}
      </header>

      {/* Conversation List */}
      <div className="flex-1 overflow-y-auto no-scrollbar px-4 pt-2 flex flex-col">
        {conversations.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center px-8 pb-14 text-center">
            <span className="pq-tool-icon" aria-hidden="true" style={{ width: 60, height: 60, borderRadius: 20 }}>
              <MessageSquare size={26} />
            </span>
            <h2 className="text-[19px] font-extrabold text-[var(--color-text)] tracking-tight mt-6">{t('messages.empty')}</h2>
            <p className="text-[14px] text-[var(--color-text-secondary)] mt-2 max-w-[30ch] leading-relaxed">{t('messages.empty_hint')}</p>
          </div>
        ) : (
          <>
            <ul className="space-y-2.5" role="list">
              {conversations.map(conv => {
                const hasUnread = unreadThreads.includes(conv);
                const convDisplayName = userProfilesCache[conv.otherUser.id]?.name || t('messages.anonymous');
                const fromMe = conv.lastSenderId === user.id;

                return (
                  <li key={conv.id}>
                    <button
                      data-thread=""
                      onClick={() => setActiveConversationId(conv.id)}
                      className={`pq-thread${hasUnread ? ' pq-thread--unread' : ''} w-full text-left rounded-[22px] p-4 flex items-center gap-3.5 focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none`}
                    >
                      <span className="relative shrink-0">
                        <Avatar name={convDisplayName} url={userProfilesCache[conv.otherUser.id]?.avatarUrl} size={48} radius={16} />
                        {hasUnread && <span className="pq-unread-dot" aria-hidden="true" />}
                      </span>

                      <span className="block flex-1 min-w-0">
                        <span className="flex items-baseline gap-2">
                          <span className={`pq-thread-name flex-1 truncate text-[15px] text-[var(--color-text)] ${hasUnread ? 'font-extrabold' : 'font-bold'}`}>
                            {convDisplayName}
                          </span>
                          <span className={`shrink-0 text-[11.5px] tabular-nums ${hasUnread ? 'pq-accent-text font-bold' : 'text-[var(--color-text-secondary)]'}`}>
                            {formatThreadTime(conv.lastMessageTimestamp, now, locale, t('messages.yesterday'))}
                          </span>
                        </span>
                        {hasUnread && <span className="sr-only">{t('messages.unread_sr')}</span>}
                        <span className={`block truncate text-[13px] mt-0.5 ${hasUnread ? 'text-[var(--color-text)] font-semibold' : 'text-[var(--color-text-secondary)]'}`}>
                          {fromMe && conv.lastMessage && <span className="text-[var(--color-text-secondary)] font-medium">{t('messages.you_prefix')}</span>}
                          {conv.lastMessage}
                        </span>
                        {conv.relatedSpotTitle && (
                          <span className="pq-spot-chip mt-2">
                            <MapPin size={10} aria-hidden="true" className="shrink-0" />
                            <span className="truncate">{conv.relatedSpotTitle}</span>
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Fills the space under a short list with a calm end-of-list
                marker instead of a stray caption. "Caught up" is only claimed
                when nothing is unread. */}
            {unreadThreads.length === 0 && (
              <div className="flex-1 min-h-[160px] flex flex-col items-center justify-center text-center pt-6 pb-10">
                <span className="pq-caught-up-icon mb-3" aria-hidden="true">
                  <CheckCheck size={20} />
                </span>
                <p className="text-[14px] font-bold text-[var(--color-text)]">{t('messages.all_caught_up')}</p>
                <p className="text-[12.5px] text-[var(--color-text-secondary)] mt-1">{t('messages.all_caught_up_hint')}</p>
              </div>
            )}
          </>
        )}
      </div>
      {actionToast && (
        <div role={toastIsError ? 'alert' : 'status'} className="shrink-0 px-4 pb-2">
          <p className={`pq-inline-note${toastIsError ? ' pq-inline-note--error' : ''}`}>{actionToast}</p>
        </div>
      )}
      {setView && (
        <NavigationBar
          currentView={AppView.MESSAGES}
          setView={setView}
          unreadMessagesCount={unreadMessagesCount}
          pendingUpdatesCount={pendingUpdatesCount}
        />
      )}
    </div>
  );
};
