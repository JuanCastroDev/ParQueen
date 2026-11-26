/**
 * DEV-ONLY preview entry. Mounts the real SignScannerView the way App.tsx does for
 * AppView.AI_ASSISTANT, with the real index.css. Query params:
 *   theme=light            light theme (app default is dark)
 *   lang=es                Spanish
 *   history=1              seed three recent scans
 *   result=…, delay=…      mock analyzeSign response (see mockGeminiService.ts)
 *   phase=preview|result   auto-load the sample photo (and read it) for screenshots
 * window.__scanSample() drops the sample sign into the camera input, as if a photo was taken.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../../index.css';
import { setLang } from '../../../i18n';
import { recordScan } from '../../../utils/recentScans';
import { SignScannerView } from '../../../views/sign-scanner/SignScannerView';
import sampleSignUrl from './sample-sign.svg?url';

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light');
setLang(params.get('lang') === 'es' ? 'es' : 'en');

// still=1: jump every animation to its end state (stable screenshots in a background tab).
if (params.get('still') === '1') {
  const style = document.createElement('style');
  style.textContent = '.pq-scan *, .pq-scan *::before, .pq-scan *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }';
  document.head.appendChild(style);
}

localStorage.removeItem('parqueen_recent_scans');
if (params.get('history') === '1') {
  const es = params.get('lang') === 'es';
  const now = Date.now();
  const seed = [
    { status: 'YES' as const, explanation: es ? 'Parqueo medido de una hora, de 9 AM a 7 PM excepto domingo.' : 'One-hour metered parking, 9 AM to 7 PM except Sunday.' },
    { status: 'NO' as const, explanation: es ? 'No se permite detenerse en ningún momento en este lado de la cuadra.' : 'No standing at any time on this side of the block.' },
    { status: 'CONDITIONAL' as const, explanation: es ? 'Puedes parquear ahora, pero la limpieza de calles empieza mañana a las 11:30 AM.' : 'You can park now, but street cleaning starts tomorrow at 11:30 AM.' },
  ];
  seed.forEach((s, i) => {
    const realNow = Date.now;
    Date.now = () => now - (seed.length - i) * 7 * 3600_000;
    recordScan(s);
    Date.now = realNow;
  });
}

const onBack = () => {
  const note = document.getElementById('preview-note');
  if (note) { note.textContent = 'Back → the app would return to the map here.'; note.hidden = false; setTimeout(() => { note.hidden = true; }, 2200); }
};

async function scanSample() {
  const blob = await (await fetch(sampleSignUrl)).blob();
  const file = new File([blob], 'sign.svg', { type: 'image/svg+xml' });
  const input = document.querySelector<HTMLInputElement>('.pq-scan input[type=file]');
  if (!input) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
(window as unknown as { __scanSample: () => Promise<void> }).__scanSample = scanSample;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="h-full flex flex-col bg-[var(--color-bg)]">
      <SignScannerView onBack={onBack} />
    </div>
  </React.StrictMode>,
);

const waitFor = async <T,>(get: () => T | null, tries = 60): Promise<T | null> => {
  for (let i = 0; i < tries; i++) {
    const v = get();
    if (v) return v;
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
};

const phase = params.get('phase');
if (phase === 'preview' || phase === 'result') {
  void (async () => {
    await waitFor(() => document.querySelector('.pq-scan input[type=file]'));
    await scanSample();
    if (phase !== 'result') return;
    const read = await waitFor(() => document.querySelector<HTMLButtonElement>('.pq-scan-foot .pq-scan-cta'));
    read?.click();
  })();
}
