import { Timestamp } from 'firebase/firestore';

/** Standard schema for all future adminAuditLog entries. */
export interface AuditLogEntry {
  id: string;
  action: string;
  targetType: 'user' | 'spot' | 'segment' | 'rule' | 'suspension' | 'report' | 'system';
  targetId: string;
  targetUserId?: string | null;
  adminId: string;
  adminEmail?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: Timestamp;
  // Legacy fields — present on older entries, kept for backward compat reads
  adminUid?: string;
  performedAt?: Timestamp;
  finderId?: string | null;
  spotId?: string | null;
  targetUid?: string | null;
}

export enum AppView {
  SPLASH = 'splash',
  CREATE_ACCOUNT = 'create-account',
  SETUP_PROFILE = 'setup-profile',
  EDIT_PROFILE = 'edit-profile',
  MAP = 'map',
  GARAGE_LIST = 'garage-list',
  HOST_DASHBOARD = 'host-dashboard',
  AI_ASSISTANT = 'ai-assistant',
  MESSAGES = 'messages',
  PROFILE = 'profile',
  NOTIFICATIONS = 'notifications',
  ADMIN_DASHBOARD = 'admin-dashboard',
  PARKING_SPACE = 'parking-space',
  PRIVACY_POLICY = 'privacy-policy',
  TERMS_OF_USE = 'terms-of-use',
  CONTACT_US = 'contact-us',
  ONBOARDING = 'onboarding',
  VERIFY_PHONE = 'verify-phone',
  COMPLETE_PROFILE = 'complete-profile',
  SETTINGS = 'settings',
  EDIT_VEHICLE = 'edit-vehicle',
  ADMIN_LOGIN = 'admin-login',
  LOCATION_PROMPT = 'location-prompt',
  NOTIFICATIONS_SETTINGS = 'notifications-settings',
  LOCATION_SETTINGS = 'location-settings',
  LANGUAGE_SETTINGS = 'language-settings',
  BLOCKED_USERS = 'blocked-users',
}

export interface StreetSpot {
  id: string;
  lat: number;
  lng: number;
  type: 'free' | 'paid';
  status: 'available' | 'interested' | 'occupied';
  finderId: string;
  finderName: string;
  reportedAt: any;
  expiresAt: any;
  interestedUserId?: string | null;
  interestedUserName?: string | null;
  etaMinutes?: number | null;
  interestExpiresAt?: any;
  originSpotId?: string | null;
}
