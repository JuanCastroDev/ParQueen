'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const {
  curbResolverMode,
  curbResolverUrl,
  curbShadowSamplePermille,
  readPrivateResolverConfig,
} = require('./privateBlockfaceResolverConfig');

const PROJECT_DOTENV = join(__dirname, '..', '.env.parkqueen-46475363-ccf36');

describe('private resolver backend configuration', () => {
  it('registers server-controlled Gen 2 parameters with resolver mode off by default', () => {
    expect(curbResolverMode.name).toBe('CURB_RESOLVER_MODE');
    expect(curbResolverMode.options.default).toBe('off');
    expect(curbResolverUrl.name).toBe('CURB_RESOLVER_URL');
    expect(curbResolverUrl.options.default).toBe('');
    expect(curbShadowSamplePermille.name).toBe('CURB_SHADOW_SAMPLE_PERMILLE');
    expect(curbShadowSamplePermille.options.default).toBe('0');
  });

  it.each([undefined, '', 'OFF', 'enabled', 'invalid'])('keeps unsupported mode %s disabled', mode => {
    const config = readPrivateResolverConfig({
      mode: { value: () => mode },
      url: { value: () => 'https://example.run.app' },
    });
    expect(config).toEqual({ mode: 'off', serviceUrl: '', samplePermille: 0 });
  });

  it('exposes the URL only when shadow is explicitly selected', () => {
    const config = readPrivateResolverConfig({
      mode: { value: () => 'shadow' },
      url: { value: () => 'https://example.run.app' },
    });
    expect(config).toEqual({ mode: 'shadow', serviceUrl: 'https://example.run.app', samplePermille: 0 });
  });

  it.each([
    ['0', 0], ['1', 1], ['500', 500], ['1000', 1000],
    ['', 0], ['-1', 0], ['1001', 0], ['1.5', 0], ['abc', 0], [undefined, 0],
  ])('parses sample value %s safely', (value, expected) => {
    const config = readPrivateResolverConfig({
      mode: { value: () => 'shadow' },
      url: { value: () => 'https://example.run.app' },
      samplePermille: { value: () => value },
    });
    expect(config.samplePermille).toBe(expected);
  });

  it('lists every curb string param in the project dotenv so the emulator cannot prompt', () => {
    const dotenv = readFileSync(PROJECT_DOTENV, 'utf8');
    for (const name of [curbResolverMode.name, curbResolverUrl.name, curbShadowSamplePermille.name]) {
      expect(dotenv).toMatch(new RegExp(`^${name}=`, 'm'));
    }
    expect(dotenv).toMatch(/^CURB_RESOLVER_MODE=shadow$/m);
    expect(dotenv).toMatch(/^CURB_SHADOW_SAMPLE_PERMILLE=0$/m);
    expect(dotenv).toMatch(
      /^CURB_RESOLVER_URL=https:\/\/parqueen-curb-resolver-spike-oxbozdhlwa-uc\.a\.run\.app$/m,
    );
  });

  it('does not read URL or sampling configuration while mode is off', () => {
    const unread = { value: vi.fn(() => { throw new Error('must stay unread'); }) };
    expect(readPrivateResolverConfig({ mode: { value: () => 'off' }, url: unread, samplePermille: unread }))
      .toEqual({ mode: 'off', serviceUrl: '', samplePermille: 0 });
    expect(unread.value).not.toHaveBeenCalled();
  });
});
