import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('native iOS phone auth project contract', () => {
  const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
  const info = read('ios/App/App/Info.plist');
  const plugin = read('ios/App/App/PhoneAuthPlugin.swift');
  const appCheckPlugin = read('ios/App/App/AppCheckBridgePlugin.swift');
  const bridge = read('ios/App/App/ParQueenBridgeViewController.swift');
  const scene = read('ios/App/App/SceneDelegate.swift');
  const appDelegate = read('ios/App/App/AppDelegate.swift');
  const releaseEntitlements = read('ios/App/App/App.entitlements');
  const debugEntitlements = read('ios/App/App/AppDebug.entitlements');
  const capPackage = read('ios/App/CapApp-SPM/Package.swift');
  const gitignore = read('.gitignore');

  it('compiles the plugin and bridge into the App target', () => {
    expect(pbx).toContain('PhoneAuthPlugin.swift in Sources');
    expect(pbx).toContain('ParQueenBridgeViewController.swift in Sources');
    expect(plugin).toContain('jsName = "PhoneAuth"');
    expect(plugin).toContain('startVerification');
    expect(plugin).toContain('confirmVerification');
    expect(plugin).toContain('signIn(with: credential)');
    expect(plugin).toContain('Auth.auth().signOut()');
    expect(plugin).not.toContain('verificationId');
    expect(plugin).not.toContain('call.resolve(["verificationID"');
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
    expect(pbx).toContain('productName = FirebaseFunctions;');
    expect(pbx).toContain('productName = FirebaseAppCheck;');
    expect(pbx).not.toMatch(/kind = branch;/);
    expect(capPackage).not.toContain('firebase-ios-sdk');
  });

  it('adds -ObjC on the App target while keeping inherited flags', () => {
    const releaseStart = pbx.indexOf('504EC3181FED79650016851F /* Release */ = {');
    const release = pbx.slice(releaseStart, pbx.indexOf('name = Release;', releaseStart));
    expect(release).toContain('OTHER_LDFLAGS = (');
    expect(release).toContain('"$(inherited)",');
    expect(release).toContain('"-ObjC",');
    expect(release).toContain('CURRENT_PROJECT_VERSION = 12;');
    expect(release).toContain('MARKETING_VERSION = 1.0;');
    expect(release).toContain('CODE_SIGN_ENTITLEMENTS = App/App.entitlements;');
  });

  it('uses native Firebase App Check with App Attest on iOS', () => {
    expect(pbx).toContain('AppCheckBridgePlugin.swift in Sources');
    expect(pbx).toContain('FirebaseAppCheck in Frameworks');
    expect(appCheckPlugin).toContain('jsName = "AppCheckBridge"');
    expect(appCheckPlugin).toContain('AppCheck.appCheck().token(forcingRefresh: false)');
    expect(bridge).toContain('registerPluginInstance(AppCheckBridgePlugin())');
    expect(appDelegate).toContain('import FirebaseAppCheck');
    expect(appDelegate).toContain('AppCheck.setAppCheckProviderFactory');
    expect(appDelegate).toContain('AppAttestProvider(app: app)');
    expect(appDelegate.indexOf('AppCheck.setAppCheckProviderFactory')).toBeLessThan(appDelegate.indexOf('FirebaseApp.configure()'));
    expect(releaseEntitlements).toContain('<key>com.apple.developer.devicecheck.appattest-environment</key>');
    expect(releaseEntitlements).toContain('<string>production</string>');
  });

  it('disables swizzling, forwards APNs manually, and declares background modes', () => {
    expect(info).toContain('<string>app-1-768131391875-ios-1356ad05455bd17a3196b6</string>');
    expect(info).toContain('<key>FirebaseAppDelegateProxyEnabled</key>');
    expect(info).toContain('<false/>');
    expect(info).toContain('<key>UIBackgroundModes</key>');
    expect(info).toContain('<string>fetch</string>');
    expect(info).toContain('<string>remote-notification</string>');
    expect(info).toContain('<key>ITSAppUsesNonExemptEncryption</key>');
    expect(appDelegate).toContain('FirebaseApp.configure()');
    expect(appDelegate).toContain('registerForRemoteNotifications()');
    expect(appDelegate).toContain('setAPNSToken(deviceToken, type: .unknown)');
    expect(appDelegate).toContain('canHandleNotification(userInfo)');
    expect(appDelegate).toContain('didFailToRegisterForRemoteNotificationsWithError');
    expect(appDelegate).not.toContain('UNUserNotificationCenter');
    expect(appDelegate).not.toContain('localizedDescription');
    expect(plugin).not.toContain('FirebaseApp.configure()');
    expect(pbx).toContain('com.apple.Push');
    expect(releaseEntitlements).toContain('<key>aps-environment</key>');
    expect(releaseEntitlements).toContain('<string>production</string>');
    expect(debugEntitlements).toContain('<string>development</string>');
  });

  it('keeps GoogleService-Info.plist untracked', () => {
    expect(gitignore).toContain('GoogleService-Info.plist');
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
    expect(tracked.toLowerCase()).not.toContain('googleservice-info.plist');
  });

  it('configures Firebase at launch and copies the plist only when it is present', () => {
    expect(plugin).toContain('ios_phone_auth_configuration');
    expect(plugin).toContain('exchangePhoneAuthSession');
    expect(plugin).toContain('clearStaleNativeUser');
    expect(plugin).not.toContain('try?');
    expect(plugin).not.toContain('localizedDescription');
    expect(plugin).toContain('try Auth.auth().signOut()');
    expect(plugin).toContain('guard clearStaleNativeUser() else');
    expect(plugin).toContain('guard self.signOutNativeAuth() else');
    const signInStart = plugin.indexOf('Auth.auth().signIn(with: credential)');
    const exchangeStart = plugin.indexOf('self.exchangeCustomToken', signInStart);
    const signInError = plugin.slice(signInStart, exchangeStart);
    expect(signInError).toContain('ios_phone_auth_code_expired');
    expect(signInError).toContain('ios_phone_auth_invalid_session');
    expect(signInError).toContain('invalidateSession(sessionId)');
    expect(signInError).not.toContain('ios_phone_auth_invalid_code');
    const beforeResolve = plugin.slice(exchangeStart, plugin.indexOf('"customToken": token'));
    expect(beforeResolve).toContain('guard self.signOutNativeAuth() else');
    expect(beforeResolve).not.toContain('ios_phone_auth_code_expired');
    expect(pbx).toContain('Copy GoogleService-Info.plist');
    expect(pbx).toContain('if [ -f \\"${SRCROOT}/App/GoogleService-Info.plist\\" ]');
    for (const workflow of [
      '.github/workflows/ios-signed-archive.yml',
      '.github/workflows/ios-testflight-upload.yml',
    ]) {
      const source = read(workflow);
      expect(source).toContain('UIBackgroundModes: fetch');
      expect(source).toContain('UIBackgroundModes: remote-notification');
      expect(source).toContain('"fetch" not in background_modes');
      expect(source).toContain('"remote-notification" not in background_modes');
    }
  });
});
