import type { SignAnalysisResult } from '../services/geminiService';

/**
 * Recent sign scans, stored locally on the device only.
 *
 * Deliberately minimal. We keep a short human-readable title, the verdict and a
 * timestamp — enough to show "what did I scan earlier". We do NOT keep the
 * photo, any location, or the model prompt/response in full: a parking sign
 * photo plus a time is effectively a location trail, and none of that is needed
 * to render the list. Nothing here leaves the device.
 */
export interface RecentScan {
  id: string;
  status: SignAnalysisResult['status'];
  title: string;
  ts: number;
}

const KEY = 'parqueen_recent_scans';
const MAX = 5;
const MAX_TITLE = 90;

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Private mode / blocked storage.
    return null;
  }
}

/** First line of the explanation, trimmed to something a list row can show. */
export function titleFromResult(result: SignAnalysisResult): string {
  const raw = (result.explanation || '').split('\n')[0].trim();
  if (!raw) return '';
  return raw.length > MAX_TITLE ? `${raw.slice(0, MAX_TITLE - 1).trimEnd()}…` : raw;
}

export function loadRecentScans(): RecentScan[] {
  const store = safeStorage();
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(s => s && typeof s.title === 'string' && typeof s.ts === 'number')
      .slice(0, MAX);
  } catch {
    return [];
  }
}

/**
 * Prepends a scan and returns the new list. Errors are never recorded — a
 * failed read is not a scan the user made, and showing it would be noise.
 */
export function recordScan(result: SignAnalysisResult): RecentScan[] {
  const store = safeStorage();
  const title = titleFromResult(result);
  const existing = loadRecentScans();
  if (!store || result.status === 'ERROR' || !title) return existing;

  const entry: RecentScan = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: result.status,
    title,
    ts: Date.now(),
  };
  const next = [entry, ...existing].slice(0, MAX);
  try {
    store.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota or blocked storage: keep the in-memory list, drop persistence.
  }
  return next;
}

/**
 * Puts back a list the user just cleared (the scanner's Undo). Only entries that pass the same
 * shape check as loadRecentScans are written, so this can never widen what is stored.
 */
export function restoreRecentScans(scans: RecentScan[]): RecentScan[] {
  const store = safeStorage();
  const valid = scans
    .filter(s => s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.ts === 'number'
      && (s.status === 'YES' || s.status === 'NO' || s.status === 'CONDITIONAL'))
    .map(s => ({ id: s.id, status: s.status, title: s.title.slice(0, MAX_TITLE), ts: s.ts }))
    .slice(0, MAX);
  if (!store) return valid;
  try {
    store.setItem(KEY, JSON.stringify(valid));
  } catch {
    // Quota or blocked storage: keep the in-memory list.
  }
  return valid;
}

export function clearRecentScans(): void {
  const store = safeStorage();
  try { store?.removeItem(KEY); } catch { /* ignore */ }
}
