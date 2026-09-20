import React from 'react';
import { Search, Camera, MessageSquare, Bell } from 'lucide-react';
import { AppView } from '../../types';
import { t, useLang } from '../../i18n';

interface HeaderBarProps {
    user: any;
    setView: (view: AppView) => void;
    inputRef: React.RefObject<HTMLInputElement>;
    searchQuery: string;
    setSearchQuery: (q: string) => void;
    searchOpen: boolean;
    setSearchOpen: (open: boolean) => void;
    results: any[];
    setResults: (r: any[]) => void;
    loading: boolean;
    handleCancelSearch: () => void;
    unreadMessagesCount: number;
    pendingUpdatesCount: number;
    setPendingUpdatesCount: (n: number) => void;
    onSelectResult: (result: any) => void;
}

const UserAvatar = ({ user, onClick }: { user: any; onClick: () => void }) => {
    const initials = (user?.fullName || user?.username || 'PQ')
        .split(' ')
        .map((w: string) => w[0])
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase();

    return (
        <button
            onClick={onClick}
            className="w-8 h-8 rounded-full overflow-hidden shrink-0 flex items-center justify-center text-[13px] font-bold text-white"
            aria-label="Profile"
        >
            {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt="Profile" className="w-full h-full object-cover" />
            ) : (
                <div className="w-full h-full bg-gradient-to-tr from-blue-600 to-cyan-500 flex items-center justify-center">
                    {initials}
                </div>
            )}
        </button>
    );
};

export const HeaderBar: React.FC<HeaderBarProps> = ({
    user,
    setView,
    inputRef,
    searchQuery,
    setSearchQuery,
    searchOpen,
    setSearchOpen,
    results,
    setResults,
    loading,
    handleCancelSearch,
    unreadMessagesCount,
    pendingUpdatesCount,
    setPendingUpdatesCount,
    onSelectResult,
}) => {
    useLang();
    return (
        <header style={{ paddingTop: 'max(env(safe-area-inset-top), 16px)' }} className="map-mobile-header w-full flex flex-col gap-2.5 pointer-events-auto">
            <div className="map-header-search-row max-w-none md:max-w-[380px] mx-auto flex items-center gap-2.5">
                <div data-tour="search" className="map-search-shell relative flex-1 min-w-0 flex items-center transition-all duration-300">
                    <span data-tour="profile" className="hidden md:inline-flex shrink-0 ml-1">
                        <UserAvatar user={user} onClick={() => setView(AppView.PROFILE)} />
                    </span>

                    <div className="map-search-content flex-1 min-w-0 ml-2.5 mr-4 flex items-center gap-2">
                        <Search size={20} strokeWidth={2} className="map-search-icon" />
                        <input
                            ref={inputRef}
                            type="text"
                            aria-label={t('common.search_placeholder')}
                            aria-expanded={searchOpen && (loading || results.length > 0)}
                            aria-haspopup="listbox"
                            placeholder={t('common.search_placeholder')}
                            className="map-search-input bg-transparent border-none outline-none text-[16px] md:text-[14px] w-full font-medium"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onFocus={() => setSearchOpen(true)}
                            onKeyDown={(e) => { if (e.key === 'Escape') handleCancelSearch(); }}
                        />
                    </div>

                    {searchOpen && (loading || results.length > 0) && (
                        <div aria-live="polite" className="absolute left-0 right-0 mt-2 top-full z-[9999] bg-[var(--color-glass)] backdrop-blur-xl rounded-2xl max-h-60 overflow-y-auto border border-[var(--color-border)] shadow-2xl p-2">
                            {loading && <div className="px-4 py-3 text-[var(--color-text-secondary)] text-xs">{t('common.searching')}</div>}

                            {!loading && results.map((r: any) => (
                                <button
                                    key={r.id}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => onSelectResult(r)}
                                    className="w-full text-left px-3 py-2 hover:bg-white/5 rounded-xl transition-colors"
                                >
                                    <div className="text-[var(--color-text)] font-medium text-xs">{r.text}</div>
                                    <div className="text-[10px] text-[var(--color-text-secondary)]">{r.place_name}</div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                <button
                    data-tour="ai"
                    type="button"
                    aria-label="Scan street sign"
                    title="Scan"
                    onClick={() => setView(AppView.AI_ASSISTANT)}
                    className="map-ai-action flex items-center justify-center gap-1.5 rounded-full active:scale-95 transition-all shrink-0"
                >
                    <Camera size={16} strokeWidth={2.05} aria-hidden="true" />
                    <span className="map-ai-action-label">Scan</span>
                </button>

                <button
                    data-tour="messages"
                    type="button"
                    aria-label="Chat"
                    title="Chat"
                    onClick={() => setView(AppView.MESSAGES)}
                    className="hidden md:inline-flex p-1.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-overlay)] rounded-full transition-colors relative shrink-0"
                >
                    <div className="relative">
                        <MessageSquare size={17} />
                        {unreadMessagesCount > 0 && (
                            <span className="absolute -top-0.5 -right-0.5 bg-[var(--color-brand)] w-1.5 h-1.5 rounded-full animate-pulse motion-reduce:animate-none shadow-md" />
                        )}
                    </div>
                </button>

                <button
                    data-tour="bell"
                    type="button"
                    aria-label={t('common.nearby_activity')}
                    title={t('common.nearby_activity')}
                    onClick={() => {
                        localStorage.setItem('lastViewedNotifications', Date.now().toString());
                        localStorage.setItem('pendingUpdatesCount', '0');
                        setPendingUpdatesCount(0);
                        setView(AppView.NOTIFICATIONS);
                    }}
                    className="hidden md:inline-flex p-1.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-overlay)] rounded-full transition-colors relative shrink-0"
                >
                    <div className="relative">
                        <Bell size={17} />
                        {pendingUpdatesCount > 0 && (
                            <span className="absolute -top-0.5 -right-0.5 bg-[var(--color-brand)] w-1.5 h-1.5 rounded-full animate-pulse motion-reduce:animate-none shadow-md" />
                        )}
                    </div>
                </button>
            </div>

            {searchOpen && (
                <div className="w-full max-w-[380px] mx-auto flex justify-end px-3">
                    <button onClick={handleCancelSearch} className="text-[var(--color-info)] font-bold text-[10px] bg-white/5 border border-[var(--color-border)] rounded-full py-1 px-3 mt-1">
                        {t('common.cancel_search')}
                    </button>
                </div>
            )}
        </header>
    );
};
