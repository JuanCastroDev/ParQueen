import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const gradle = readFileSync(new URL('./app/build.gradle', import.meta.url), 'utf8');
const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

describe('Android release signing contracts', () => {
  it('loads signing properties from user.home with an env override', () => {
    expect(gradle).toContain("System.getenv('PARQUEEN_SIGNING_PROPERTIES')");
    expect(gradle).toContain("System.getProperty('user.home')");
    expect(gradle).toContain('.android-keys/parqueen-signing.properties');
    expect(gradle).not.toMatch(/C:\\\\Users\\\\jayca/i);
    expect(gradle).not.toContain('C:\\Users\\jayca');
  });

  it('requires the four release signing fields and always assigns release.signingConfig', () => {
    expect(gradle).toContain("['storeFile', 'storePassword', 'keyAlias', 'keyPassword']");
    expect(gradle).toContain('signingConfigs {');
    expect(gradle).toContain('signingConfig signingConfigs.release');
    expect(gradle).toContain('gradle.taskGraph.whenReady');
    expect(gradle).toContain("n == 'validateSigningRelease' || n == 'signReleaseBundle' || n == 'packageRelease'");
    expect(gradle).not.toContain("tasks.register('validateParqueenReleaseSigning')");
    expect(gradle).not.toContain('parqueenReleasePackagingTaskNames');
    expect(gradle).not.toContain('parqueen-release-signing-not-configured');
    expect(gradle).not.toContain("'packageReleaseBundle'");
    expect(gradle).not.toContain("'assembleRelease'");
    expect(gradle).not.toContain("'bundleRelease'");
  });

  it('does not fall back to debug, unsigned placeholders, or hardcoded secrets', () => {
    expect(gradle).not.toMatch(/signingConfig\s+signingConfigs\.debug/);
    expect(gradle).not.toContain('storePassword "');
    expect(gradle).not.toContain("storePassword '");
    expect(gradle).not.toContain('keyPassword "');
    expect(gradle).not.toContain("keyPassword '");
    expect(gradle).not.toContain('parqueen-upload.jks');
    expect(gradle).not.toMatch(/storePassword\s*=\s*["']/);
    expect(gradle).not.toMatch(/keyPassword\s*=\s*["']/);
  });

  it('preserves exact storePassword and keyPassword values from Properties', () => {
    expect(gradle).toContain("if (key == 'storePassword' || key == 'keyPassword')");
    expect(gradle).toContain('values[key] = raw');
    expect(gradle).toContain('values[key] = raw.trim()');
    const passwordAssign = gradle.indexOf("if (key == 'storePassword' || key == 'keyPassword')");
    expect(passwordAssign).toBeGreaterThan(-1);
    const afterIf = gradle.slice(passwordAssign);
    expect(afterIf.indexOf('values[key] = raw')).toBeGreaterThan(-1);
    expect(afterIf.indexOf('values[key] = raw')).toBeLessThan(afterIf.indexOf('values[key] = raw.trim()'));
  });

  it('records malformed properties as a signing error instead of throwing at configuration', () => {
    expect(gradle).toContain('props.load(stream)');
    expect(gradle).toMatch(/try \{[\s\S]*props\.load\(stream\)[\s\S]*\} catch \(Exception ignored\)/);
    expect(gradle).toContain('could not be parsed or read');
    expect(gradle).not.toContain('ignored.getMessage()');
    expect(gradle).not.toContain('ignored.message');
    expect(gradle).not.toContain('${ignored');
  });

  it('ignores accidental copies of the signing properties filename', () => {
    expect(gitignore).toMatch(/^parqueen-signing\.properties$/m);
  });
});
