package app.parqueen;

import android.app.Application;

/**
 * Installs the native App Check provider in Application.onCreate so it is
 * present before MainActivity, the Capacitor bridge, or the first JS
 * getToken() request.
 */
public class ParQueenApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        AppCheckProviderInstaller.install(this);
    }
}
