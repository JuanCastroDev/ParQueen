import { useEffect, useState } from 'react';
import { getToken } from 'firebase/app-check';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { getParQueenAppCheck } from './appCheck';
import {
  classifyAppCheckToken,
  expectedProviderFor,
  failureCategory,
  type AppCheckQaBuildType,
  type AppCheckQaReport,
} from './appCheckQa';

const readBuildType = (): AppCheckQaBuildType => {
  if (Capacitor.getPlatform() === 'ios') return 'unspecified';
  if (import.meta.env.DEV) return 'debug';
  return 'release';
};

const readReport = async (): Promise<AppCheckQaReport> => {
  const platform = Capacitor.getPlatform();
  const buildType = platform === 'android' ? 'unspecified' : readBuildType();
  let buildIdentity = `web ${import.meta.env.MODE}`;
  if (Capacitor.isNativePlatform()) {
    try {
      const info = await App.getInfo();
      buildIdentity = `${info.id} ${info.version} (${info.build})`;
    } catch {
      buildIdentity = `${platform} version unavailable`;
    }
  }
  const siteKeyConfigured = typeof import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY === 'string'
    && import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY.length > 0;
  const base = {
    platform,
    buildIdentity,
    buildType,
    expectedProvider: platform === 'android'
      ? 'Debug provider on a debug APK; Play Integrity on a release APK'
      : expectedProviderFor(platform, buildType),
    debugOnly: platform === 'web' && import.meta.env.DEV,
  };
  const appCheck = getParQueenAppCheck();
  if (!appCheck) {
    return {
      ...base,
      initialized: 'FAIL',
      tokenRetrieval: 'FAIL',
      failureCategory: platform === 'web' && !siteKeyConfigured ? 'site-key-missing' : 'not-initialized',
    };
  }
  try {
    const result = await getToken(appCheck, false);
    const verdict = classifyAppCheckToken(result?.token);
    if (verdict !== 'pass') {
      return { ...base, initialized: 'YES', tokenRetrieval: 'FAIL', failureCategory: verdict === 'dummy' ? 'dummy-token' : 'empty-token' };
    }
    return { ...base, initialized: 'YES', tokenRetrieval: 'PASS', failureCategory: 'none' };
  } catch (error) {
    const category = failureCategory(error);
    return {
      ...base,
      initialized: 'YES',
      tokenRetrieval: 'FAIL',
      failureCategory: category,
    };
  }
};

export default function AppCheckQaPanel() {
  const [report, setReport] = useState<AppCheckQaReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    readReport().then((next) => {
      if (!cancelled) setReport(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = report ? [
    ['Platform', report.platform],
    ['Build identity', report.buildIdentity],
    ['Build type', report.platform === 'ios' ? 'unspecified until a physical TestFlight device' : report.debugOnly ? 'debug (DEBUG ONLY)' : report.buildType],
    ['Expected provider', report.expectedProvider],
    ['App Check initialized', report.initialized],
    ['Real token retrieval', report.tokenRetrieval],
    ['Failure category', report.failureCategory],
  ] : [['Status', 'Requesting token']];

  return (
    <aside
      style={{ position: 'fixed', left: 8, right: 8, bottom: 8, zIndex: 80, padding: 12, background: '#111', color: '#fff', font: '14px/1.4 sans-serif' }}
    >
      <strong>App Check QA</strong>
      {rows.map(([label, value]) => (
        <div key={label}>{label}: {value}</div>
      ))}
    </aside>
  );
}
