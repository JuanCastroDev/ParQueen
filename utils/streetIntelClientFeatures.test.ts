import { describe, expect, it } from 'vitest';
import { streetIntelClientFeaturesEnabled } from './streetIntelClientFeatures';

describe('street intelligence client feature gate', () => {
  it('stays off unless the explicit approved flag is on', () => {
    expect(streetIntelClientFeaturesEnabled({})).toBe(false);
    expect(streetIntelClientFeaturesEnabled({ VITE_PARQUEEN_STREET_INTEL_CLIENT_FEATURES: '' })).toBe(false);
    expect(streetIntelClientFeaturesEnabled({ VITE_PARQUEEN_STREET_INTEL_CLIENT_FEATURES: 'true' })).toBe(false);
    expect(streetIntelClientFeaturesEnabled({ VITE_PARQUEEN_STREET_INTEL_CLIENT_FEATURES: 'on' })).toBe(true);
  });
});
