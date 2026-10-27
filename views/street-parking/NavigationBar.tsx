import React from 'react';
import { Bell, Map, MessageSquare, User } from 'lucide-react';
import { t, useLang } from '../../i18n';
import { AppView } from '../../types';
import parqueenMark from '../../assets/Parqueen_Pin.png';

interface NavigationBarProps {
    currentView: AppView;
    setView: (view: AppView) => void;
    unreadMessagesCount?: number;
    pendingUpdatesCount?: number;
    onPing?: () => void;
    pingDisabled?: boolean;
}

const badgeLabel = (count: number) => count > 99 ? '99+' : String(count);

export const NavigationBar: React.FC<NavigationBarProps> = ({
    currentView,
    setView,
    unreadMessagesCount = 0,
    pendingUpdatesCount = 0,
    onPing,
    pingDisabled = false,
}) => {
    useLang();

    const navigate = (view: AppView) => {
        if (view === AppView.NOTIFICATIONS) {
            localStorage.setItem('lastViewedNotifications', Date.now().toString());
            localStorage.setItem('pendingUpdatesCount', '0');
        }
        setView(view);
    };

    const items = [
        { view: AppView.MAP, label: t('nav.map'), visualLabel: t('nav.map'), Icon: Map, badge: 0, badgeId: undefined, tour: undefined },
        {
            view: AppView.NOTIFICATIONS,
            label: pendingUpdatesCount > 0
                ? t('nav.nearby_new', { count: badgeLabel(pendingUpdatesCount) })
                : t('common.nearby_activity'),
            visualLabel: t('nav.nearby'),
            Icon: Bell,
            badge: pendingUpdatesCount,
            badgeId: 'activity',
            tour: 'bell',
        },
        {
            view: AppView.MESSAGES,
            label: unreadMessagesCount > 0
                ? t('nav.messages_unread', { count: badgeLabel(unreadMessagesCount) })
                : t('nav.messages'),
            visualLabel: t('nav.messages'),
            Icon: MessageSquare,
            badge: unreadMessagesCount,
            badgeId: 'messages',
            tour: 'messages',
        },
        {
            view: AppView.PROFILE,
            label: t('nav.profile'),
            visualLabel: t('nav.profile'),
            Icon: User,
            badge: 0,
            badgeId: undefined,
            tour: 'profile',
        },
    ] as const;

    const renderItem = ({ view, label, visualLabel, Icon, badge, badgeId, tour }: (typeof items)[number]) => {
        const active = currentView === view;
        return (
            <button
                key={view}
                type="button"
                data-tour={tour}
                aria-label={label}
                aria-current={active ? 'page' : undefined}
                onClick={() => navigate(view)}
                className={`mobile-primary-nav-item${active ? ' is-active' : ''}`}
            >
                <span className="mobile-primary-nav-icon-wrap" aria-hidden="true">
                    <Icon size={20} strokeWidth={active ? 2.4 : 2} />
                    {!!badge && badge > 0 && badgeId && (
                        <span data-nav-badge={badgeId} className="mobile-primary-nav-badge">
                            {badgeLabel(badge)}
                        </span>
                    )}
                </span>
                <span className="mobile-primary-nav-label">{visualLabel}</span>
            </button>
        );
    };

    return (
        <nav className="mobile-primary-nav" aria-label={t('nav.primary')}>
            <div className="mobile-primary-nav-surface">
                {items.slice(0, 2).map(renderItem)}
                <button
                    type="button"
                    data-tour="share-spot"
                    aria-label={t('common.ping_your_spot')}
                    onClick={onPing ?? (() => navigate(AppView.MAP))}
                    disabled={pingDisabled}
                    className="mobile-primary-nav-ping"
                >
                    <span className="mobile-primary-nav-ping-orbit" aria-hidden="true">
                        {/* Spotlight anchor. The button box also covers the "Ping" label and
                            this stack is absolutely positioned above that box, so measuring the
                            button gives an oval sitting ~24px below the circle the user sees.
                            Anchored on the core (the blue disc), not the cradle halo around it,
                            so the ring stays clear of the neighbouring nav items. Decorative. */}
                        <span data-tour-spotlight="share-spot" className="mobile-primary-nav-ping-core">
                            <img
                                src={parqueenMark}
                                alt=""
                                aria-hidden="true"
                                draggable={false}
                                className="mobile-primary-nav-ping-mark"
                            />
                        </span>
                    </span>
                    <span className="mobile-primary-nav-ping-label">Ping</span>
                </button>
                {items.slice(2).map(renderItem)}
            </div>
        </nav>
    );
};
