import React, { useRef, useState } from 'react';
import type { CanonicalCurbResponse } from '../../utils/canonicalCurbClient';
import {
  cancelQaCurbFieldTest,
  runQaCurbFieldAttempt,
  type QaFieldReport,
} from '../../utils/qaCurbFieldTest';
import { CurbSideCrossSection } from './CurbSideCrossSection';
import { VisualCurbSelector } from './VisualCurbSelector';

type Props = Readonly<{
  enabled: boolean;
  onResolve: (
    candidateToken?: string,
    onStage?: (stage: 'location' | 'curb' | 'rules') => void,
  ) => Promise<CanonicalCurbResponse>;
  readGps: () => unknown;
}>;

function gpsLine(report: QaFieldReport): string {
  if (!report.gps) return 'GPS quality unavailable';
  const { sampleCount, accuracyMeters, consistencyMeters, durationMs } = report.gps;
  return `${sampleCount} samples · ${Math.round(accuracyMeters)} m accuracy · ${consistencyMeters.toFixed(1)} m consistency · ${Math.round(durationMs / 100) / 10} s`;
}

function rulesLine(report: QaFieldReport): string {
  if (report.rules === 'confirmed') return 'Confirmed rule information available';
  if (report.rules === 'unavailable') return 'Parking information unavailable';
  return 'Rules not evaluated';
}

export const QaCurbFieldTest: React.FC<Props> = ({ enabled, onResolve, readGps }) => {
  const [report, setReport] = useState<QaFieldReport | null>(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<'location' | 'curb' | 'rules' | null>(null);
  const firstStatusRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  if (!enabled) return null;

  const run = (candidateToken?: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRunning(true);
    const firstAttemptStatus = candidateToken ? firstStatusRef.current ?? undefined : undefined;
    void runQaCurbFieldAttempt({
      resolve: () => onResolve(candidateToken, setStage),
      readGps,
      firstAttemptStatus,
    }).then(next => {
      if (!candidateToken) firstStatusRef.current = next.firstAttemptStatus;
      setReport(next);
    }).finally(() => {
      inFlightRef.current = false;
      setRunning(false);
      setStage(null);
    });
  };

  return (
    <section className="pointer-events-auto mb-2 w-full max-w-sm self-end rounded-2xl bg-[var(--color-card)] px-3 py-2 text-left text-[12px] text-[var(--color-text)] shadow-lg" aria-label="QA curb field test">
      <button
        type="button"
        className="pq-mycar-intel-retry"
        disabled={running}
        onClick={() => run()}
      >
        {running
          ? (stage === 'rules'
            ? 'Checking parking regulations'
            : stage === 'curb'
              ? 'Identifying your curb'
              : 'Getting your location')
          : 'Test curb here'}
      </button>
      {report && (
        <div className="mt-2 space-y-1">
          <p>{gpsLine(report)}</p>
          <p>First attempt: {report.firstAttemptStatus}</p>
          <p>Elapsed: {Math.round(report.elapsedMs / 100) / 10} s</p>
          <p>{report.verifiedSide ? `Verified side: ${report.verifiedSide}` : 'Verified side: none'}</p>
          <p>{rulesLine(report)}</p>
          {report.failClosedReason && <p>Fail-closed: {report.failClosedReason}</p>}
        </div>
      )}
      {report?.confirmation && (
        <CurbSideCrossSection
          confirmation={report.confirmation}
          loading={running}
          onSelect={run}
          onCancel={() => setReport(cancelQaCurbFieldTest(report))}
          allowDiagonalCurbDrawing
        />
      )}
      {report?.selector && (
        <VisualCurbSelector
          selector={report.selector}
          loading={running}
          onSelect={run}
        />
      )}
    </section>
  );
};
