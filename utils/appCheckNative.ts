import { registerPlugin, WebPlugin } from '@capacitor/core';

export interface NativeAppCheckToken {
  token: string;
  expireTimeMillis: number;
}

export interface AppCheckBridgePlugin {
  getToken(): Promise<NativeAppCheckToken>;
}

class AppCheckBridgeWeb extends WebPlugin implements AppCheckBridgePlugin {
  async getToken(): Promise<NativeAppCheckToken> {
    throw this.unimplemented('Native App Check is only available on Capacitor Android.');
  }
}

const AppCheckBridge = registerPlugin<AppCheckBridgePlugin>('AppCheckBridge', {
  web: () => new AppCheckBridgeWeb(),
});

export const nativeGetAppCheckToken = (): Promise<NativeAppCheckToken> => AppCheckBridge.getToken();
