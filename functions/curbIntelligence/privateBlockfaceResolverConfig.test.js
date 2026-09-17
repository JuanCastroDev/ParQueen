'use strict';

const {
  curbResolverMode,
  curbResolverUrl,
  readPrivateResolverConfig,
} = require('./privateBlockfaceResolverConfig');

describe('private resolver backend configuration', () => {
  it('registers server-controlled Gen 2 parameters with resolver mode off by default', () => {
    expect(curbResolverMode.name).toBe('CURB_RESOLVER_MODE');
    expect(curbResolverMode.options.default).toBe('off');
    expect(curbResolverUrl.name).toBe('CURB_RESOLVER_URL');
    expect(curbResolverUrl.options.default).toBe('');
  });

  it.each([undefined, '', 'OFF', 'enabled', 'invalid'])('keeps unsupported mode %s disabled', mode => {
    const config = readPrivateResolverConfig({
      mode: { value: () => mode },
      url: { value: () => 'https://example.run.app' },
    });
    expect(config).toEqual({ mode: 'off', serviceUrl: '' });
  });

  it('exposes the URL only when shadow is explicitly selected', () => {
    const config = readPrivateResolverConfig({
      mode: { value: () => 'shadow' },
      url: { value: () => 'https://example.run.app' },
    });
    expect(config).toEqual({ mode: 'shadow', serviceUrl: 'https://example.run.app' });
  });
});
