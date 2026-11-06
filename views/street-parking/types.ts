import { AppView } from '../../types';

export interface MapItem {
    id: string;
    lat: number;
    lng: number;
    type: 'free' | 'paid' | 'public';
    status: 'available' | 'interested' | 'occupied';
    title: string;
    pricePerHour?: number;
    description?: string;
    reportedAt?: any;
    expiresAt?: any;
    finderId?: string;
    finderName?: string;
    finderTitle?: string | null;
    finderVehicleColor?: string | null;
    finderVehicleType?: string | null;
    finderVehicleBrand?: string | null;
    interestedUserId?: string | null;
    interestedUserName?: string | null;
    interestedUserVehicleColor?: string | null;
    interestedUserVehicleType?: string | null;
    interestedUserVehicleBrand?: string | null;
    interestedUserTitle?: string | null;
    etaMinutes?: number | null;
    interestExpiresAt?: any;
    address?: string;
    originSpotId?: string | null;
    geohash?: string;
    rawSpot?: any;
    holdRequestStatus?: string | null;
    holdRequestedBy?: string | null;
    holdTimerExpiresAt?: any;
    pingMode?: 'now' | 'later' | null;
    claimState?: 'committed' | 'heading' | 'arrived_pending_outcome' | null;
    arrivedAt?: any;
    claimStartedAt?: any;
    claimGenerationId?: string | null;
    ownerLeavingNow?: boolean | null;
    ownerLeavingNowAt?: any;
    claimReminderAt?: any;
    claimReminderSentAt?: any;
    claimAutoReleaseAt?: any;
    claimAutoReleasedAt?: any;
}

export interface MapViewProps {
    user: any;
    setView: (view: AppView) => void;
    onMessageUser: (userId: string, context: string, returnSpotId?: string) => void;
    pendingSpotId?: string | null;
    onPendingSpotConsumed?: () => void;
    onPendingSpotUnavailable?: () => void;
    pendingMyCarOpen?: boolean;
    onPendingMyCarConsumed?: () => void;
    allowLocationTracking: boolean;
    showPrimaryNavigation?: boolean;
    unreadMessagesCount?: number;
    onPendingUpdatesCountChange?: (count: number) => void;
    /**
     * Onboarding 2.0 intention, applied once when the map is ready (local navigation context only).
     * 'leave' opens the existing Ping composer (never publishes); 'explore' offers the optional tour; 'find' shows the map.
     */
    onboardingIntent?: 'find' | 'leave' | 'explore' | null;
    onOnboardingIntentHandled?: () => void;
    /** Onboarding 2.0: the first-run tour no longer starts by itself (Blueprint D12). */
    suppressAutoTour?: boolean;
}
