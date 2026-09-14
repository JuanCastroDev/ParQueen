package app.parqueen;

import android.content.Context;
import android.util.Log;

import com.google.firebase.FirebaseApp;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory;
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory;

/**
 * Installs the native App Check provider factory once, before any token
 * request. DEBUG APKs use DebugAppCheckProviderFactory; release uses Play
 * Integrity. There is no reCAPTCHA fallback.
 */
final class AppCheckProviderInstaller {
    private static final String TAG = "ParQueenAppCheck";
    private static boolean installed = false;

    private AppCheckProviderInstaller() {}

    static synchronized void install(Context context) {
        if (installed) {
            return;
        }
        if (context == null) {
            Log.w(TAG, "App Check provider not installed; missing context.");
            return;
        }
        try {
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(context);
            }
            if (FirebaseApp.getApps(context).isEmpty()) {
                Log.w(TAG, "Firebase Android is not configured; App Check provider not installed.");
                return;
            }
            FirebaseAppCheck appCheck = FirebaseAppCheck.getInstance();
            if (BuildConfig.DEBUG) {
                appCheck.installAppCheckProviderFactory(
                    DebugAppCheckProviderFactory.getInstance()
                );
                Log.i(TAG, "Installed Debug App Check provider.");
            } else {
                appCheck.installAppCheckProviderFactory(
                    PlayIntegrityAppCheckProviderFactory.getInstance()
                );
                Log.i(TAG, "Installed Play Integrity App Check provider.");
            }
            installed = true;
        } catch (Exception ignored) {
            Log.w(TAG, "Failed to install App Check provider.");
        }
    }
}
