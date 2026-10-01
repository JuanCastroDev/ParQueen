import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, UserRound, UserRoundX } from 'lucide-react';
import { doc, getDoc } from 'firebase/firestore';
import { t, useLang } from '../i18n';
import { db } from '../firebase';
import { useFocusOnMount } from '../hooks/useFocusOnMount';
import { getInitials } from '../utils/profileAvatar';
import { unblockUser } from '../utils/unblockUser';

interface BlockedUsersViewProps {
    user: { id?: string; blockedUsers?: string[] } | null;
    onBack: () => void;
}

type Identity =
    | { status: 'loading' }
    | { status: 'ready'; username: string; avatarUrl: string | null }
    | { status: 'unavailable' };

const focusRing = 'focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none';

function displayName(identity: Identity | undefined): string {
    if (identity?.status === 'ready' && identity.username.trim()) return identity.username.trim();
    return t('blocked_users.fallback_name');
}

export const BlockedUsersView: React.FC<BlockedUsersViewProps> = ({ user, onBack }) => {
    useLang();
    const headingRef = useRef<HTMLHeadingElement>(null);
    useFocusOnMount(headingRef);
    const blocked = user?.blockedUsers ?? [];
    const [identities, setIdentities] = useState<Record<string, Identity>>({});
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [status, setStatus] = useState('');
    const pendingRef = useRef(new Set<string>());

    useEffect(() => {
        const uids = user?.blockedUsers ?? [];
        if (uids.length === 0) {
            setIdentities({});
            return;
        }
        let cancelled = false;
        setIdentities(prev => {
            const next: Record<string, Identity> = {};
            for (const uid of uids) next[uid] = prev[uid] ?? { status: 'loading' };
            return next;
        });
        Promise.all(uids.map(async uid => {
            try {
                const snap = await getDoc(doc(db, 'users', uid));
                if (!snap.exists()) return [uid, { status: 'unavailable' } as const] as const;
                const data = snap.data();
                const username = typeof data.username === 'string' ? data.username : '';
                const avatarUrl = typeof data.avatarUrl === 'string' && data.avatarUrl ? data.avatarUrl : null;
                if (!username.trim()) return [uid, { status: 'unavailable' } as const] as const;
                return [uid, { status: 'ready', username: username.trim(), avatarUrl } as const] as const;
            } catch {
                return [uid, { status: 'unavailable' } as const] as const;
            }
        })).then(entries => {
            if (cancelled) return;
            setIdentities(prev => {
                const next = { ...prev };
                for (const [uid, identity] of entries) next[uid] = identity;
                return next;
            });
        });
        return () => { cancelled = true; };
    }, [JSON.stringify(user?.blockedUsers)]);

    const handleUnblock = async (blockedUid: string) => {
        if (!user?.id || pendingRef.current.has(blockedUid)) return;
        pendingRef.current.add(blockedUid);
        setPending(new Set(pendingRef.current));
        setErrors(prev => ({ ...prev, [blockedUid]: '' }));
        setStatus('');
        try {
            await unblockUser(db, user.id, blockedUid);
            setStatus(t('blocked_users.success'));
        } catch {
            setErrors(prev => ({ ...prev, [blockedUid]: t('blocked_users.error') }));
        } finally {
            pendingRef.current.delete(blockedUid);
            setPending(new Set(pendingRef.current));
        }
    };

    return (
        <div className="pq-settings mobile-safe-top md:pt-4 min-h-full bg-[var(--color-bg)] text-[var(--color-text)] px-4 pb-12">
            <div className="max-w-md mx-auto flex flex-col">
                <header className="relative flex items-center justify-center h-11">
                    <button
                        type="button"
                        onClick={onBack}
                        aria-label={t('blocked_users.back_aria')}
                        className={`pq-icon-btn absolute left-0 top-0 bg-[var(--color-overlay)] border border-[var(--color-border)] ${focusRing}`}
                    >
                        <ChevronLeft size={20} aria-hidden="true" />
                    </button>
                    <h1 ref={headingRef} tabIndex={-1} className="text-[17px] font-extrabold tracking-tight focus:outline-none">
                        {t('blocked_users.title')}
                    </h1>
                </header>

                <p className="mt-6 text-[13.5px] leading-relaxed text-[var(--color-text-secondary)]">
                    {t('blocked_users.intro')}
                </p>

                <p role="status" className="sr-only">{status}</p>
                {status && (
                    <p className="pq-inline-note mt-4" aria-hidden="true">{status}</p>
                )}

                {blocked.length === 0 ? (
                    <div className="pq-group mt-4 px-4 py-8 text-center">
                        <UserRoundX size={22} className="mx-auto text-[var(--color-text-secondary)]" aria-hidden="true" />
                        <p className="mt-3 text-[15px] font-semibold">{t('blocked_users.empty_title')}</p>
                        <p className="mt-1 text-[13px] text-[var(--color-text-secondary)]">{t('blocked_users.empty_body')}</p>
                    </div>
                ) : (
                    <ul className="pq-group mt-4">
                        {blocked.map(uid => {
                            const identity = identities[uid];
                            const name = displayName(identity);
                            const busy = pending.has(uid);
                            const initials = identity?.status === 'ready' ? getInitials(identity.username) : null;
                            const avatarUrl = identity?.status === 'ready' ? identity.avatarUrl : null;
                            return (
                                <li key={uid} className="pq-settings-row flex items-center gap-3.5 px-4 py-3">
                                    <span className="pq-row-icon overflow-hidden" aria-hidden="true">
                                        {avatarUrl ? (
                                            <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
                                        ) : initials ? (
                                            <span className="text-[12px] font-bold">{initials}</span>
                                        ) : (
                                            <UserRound size={17} />
                                        )}
                                    </span>
                                    <span className="flex-1 min-w-0">
                                        <span className="block truncate text-[15px] font-semibold">{name}</span>
                                        {errors[uid] && (
                                            <span role="alert" className="block mt-0.5 text-[12.5px] text-[var(--color-danger)]">{errors[uid]}</span>
                                        )}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => { void handleUnblock(uid); }}
                                        disabled={busy}
                                        aria-busy={busy || undefined}
                                        aria-label={t('blocked_users.unblock_aria', { name })}
                                        className={`min-h-[44px] shrink-0 px-3 rounded-xl text-[13px] font-bold pq-accent-text disabled:opacity-40 ${focusRing}`}
                                    >
                                        {busy ? t('blocked_users.unblocking') : t('blocked_users.unblock')}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
};
