import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('iOS export compliance', () => {
  it('declares ITSAppUsesNonExemptEncryption false in the packaged Info.plist source', () => {
    const plist = readFileSync(
      new URL('../ios/App/App/Info.plist', import.meta.url),
      'utf8',
    );
    expect(plist).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  });
});
