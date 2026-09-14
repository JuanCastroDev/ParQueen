package app.parqueen;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;
import com.google.firebase.appcheck.AppCheckToken;
import com.google.firebase.appcheck.FirebaseAppCheck;

/**
 * Narrow Android App Check bridge. Returns the real Firebase AppCheckToken
 * token string and expireTimeMillis. Does not invent TTL. Does not log token
 * contents.
 */
@CapacitorPlugin(name = "AppCheckBridge")
public class AppCheckBridgePlugin extends Plugin {
    private static final String TAG = "ParQueenAppCheck";
    private static final String FAILURE = "Native App Check token request failed.";

    @Override
    public void load() {
        AppCheckProviderInstaller.install(getContext());
    }

    @PluginMethod
    public void getToken(PluginCall call) {
        if (!isFirebaseConfigured()) {
            Log.w(TAG, "Firebase Android is not configured; App Check token request skipped.");
            call.reject(FAILURE);
            return;
        }

        try {
            FirebaseAppCheck.getInstance()
                .getAppCheckToken(false)
                .addOnSuccessListener(appCheckToken -> resolveToken(call, appCheckToken))
                .addOnFailureListener(ignored -> {
                    Log.w(TAG, "App Check token request failed.");
                    call.reject(FAILURE);
                });
        } catch (Exception ignored) {
            Log.w(TAG, "App Check token request failed.");
            call.reject(FAILURE);
        }
    }

    private void resolveToken(PluginCall call, AppCheckToken appCheckToken) {
        if (appCheckToken == null) {
            Log.w(TAG, "App Check token request failed.");
            call.reject(FAILURE);
            return;
        }
        String token = appCheckToken.getToken();
        if (token == null || token.isEmpty()) {
            Log.w(TAG, "App Check token request failed.");
            call.reject(FAILURE);
            return;
        }
        JSObject result = new JSObject();
        result.put("token", token);
        result.put("expireTimeMillis", appCheckToken.getExpireTimeMillis());
        call.resolve(result);
    }

    private boolean isFirebaseConfigured() {
        try {
            FirebaseApp.getInstance();
            return true;
        } catch (IllegalStateException exception) {
            return false;
        }
    }
}
