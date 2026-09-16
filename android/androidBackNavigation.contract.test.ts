import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Android Back predictive-back contract', () => {
  it('enables OnBackInvokedCallback on MainActivity', () => {
    const manifest = readFileSync(
      resolve(__dirname, 'app/src/main/AndroidManifest.xml'),
      'utf8',
    );
    expect(manifest).toMatch(/android:name="\.MainActivity"/);
    expect(manifest).toMatch(/android:enableOnBackInvokedCallback="true"/);
    expect(manifest).not.toMatch(/android:enableOnBackInvokedCallback="false"/);
  });
});
