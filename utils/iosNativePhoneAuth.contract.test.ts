import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('native iOS phone auth project contract', () => {
  const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
  const info = read('ios/App/App/Info.plist');
  const plugin = read('ios/App/App/PhoneAuthPlugin.swift');
  const bridge = read('ios/App/App/ParQueenBridgeViewController.swift');
  const scene = read('ios/App/App/SceneDelegate.swift');
  const capPackage = read('ios/App/CapApp-SPM/Package.swift');
  const gitignore = read('.gitignore');

  it('compiles the plugin and bridge into the App target', () => {
    expect(pbx).toContain('PhoneAuthPlugin.swift in Sources');
    expect(pbx).toContain('ParQueenBridgeViewController.swift in Sources');
    expect(plugin).toContain('jsName = "PhoneAuth"');
    expect(plugin).toContain('startVerification');
    expect(plugin).not.toContain('signIn(with:');
    expect(bridge).toContain('registerPluginInstance(PhoneAuthPlugin())');
    expect(bridge).toContain('super.capacitorDidLoad()');
    expect(scene).toContain('ParQueenBridgeViewController()');
    expect(scene).toContain('Auth.auth().canHandle(context.url)');
    expect(scene).toContain('SceneDelegateProxy.shared.scene(scene, openURLContexts: remaining)');
  });

  it('pins Firebase Apple SDK 12.19.2 and links FirebaseAuth', () => {
    expect(pbx).toContain('https://github.com/firebase/firebase-ios-sdk');
    expect(pbx).toContain('kind = exactVersion;');
    expect(pbx).toContain('version = 12.19.2;');
    expect(pbx).toContain('productName = FirebaseAuth;');
    expect(pbx).toContain('productName = FirebaseCore;');
    expect(pbx).not.toMatch(/kind = branch;/);
    expect(capPackage).not.toContain('firebase-ios-sdk');
  });

  it('adds -ObjC on the App target while keeping inherited flags', () => {
    const releaseStart = pbx.indexOf('504EC3181FED79650016851F /* Release */ = {');
    const release = pbx.slice(releaseStart, pbx.indexOf('name = Release;', releaseStart));
    expect(release).toContain('OTHER_LDFLAGS = (');
    expect(release).toContain('"$(inherited)",');
    expect(release).toContain('"-ObjC",');
    expect(release).toContain('CURRENT_PROJECT_VERSION = 4;');
    expect(release).toContain('MARKETING_VERSION = 1.0;');
  });

  it('registers the encoded app id callback scheme and leaves swizzling and APNs unset', () => {
    expect(info).toContain('<string>app-1-768131391875-ios-1356ad05455bd17a3196b6</string>');
    expect(info).not.toContain('FirebaseAppDelegateProxyEnabled');
    expect(info).not.toContain('aps-environment');
    expect(info).not.toContain('UIBackgroundModes');
    expect(info).toContain('<key>ITSAppUsesNonExemptEncryption</key>');
    expect(pbx).not.toContain('aps-environment');
    expect(pbx).not.toContain('FirebaseAppDelegateProxyEnabled');
  });

  it('keeps GoogleService-Info.plist untracked', () => {
    expect(gitignore).toContain('GoogleService-Info.plist');
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
    expect(tracked.toLowerCase()).not.toContain('googleservice-info.plist');
  });

  it('configures Firebase lazily and copies the plist only when it is present', () => {
    expect(plugin).toContain('FirebaseApp.configure()');
    expect(plugin).toContain('FirebaseApp.app() == nil');
    expect(plugin).toContain('ios_phone_auth_configuration');
    expect(read('ios/App/App/AppDelegate.swift')).not.toContain('FirebaseApp.configure');
    expect(pbx).toContain('Copy GoogleService-Info.plist');
    expect(pbx).toContain('if [ -f \\"${SRCROOT}/App/GoogleService-Info.plist\\" ]');
  });
});
