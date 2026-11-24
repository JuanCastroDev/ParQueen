package app.parqueen;

import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.WebView;

import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    /**
     * Upper bound for holding the branded launch screen while the WebView
     * paints its first frame. Launch is never held longer than this, even if
     * the page never commits (the web boot watchdog then takes over).
     */
    private static final long MAX_LAUNCH_SCREEN_HOLD_MS = 2500;

    private volatile boolean webFirstFrameCommitted = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Keep the native launch screen until the WebView commits its first
        // frame, which is the identical web boot logo (index.html), so the
        // hand-off has no logo-less gap. See docs/LOADING_STATES.md.
        SplashScreen launchScreen = SplashScreen.installSplashScreen(this);
        final long holdStart = SystemClock.uptimeMillis();
        launchScreen.setKeepOnScreenCondition(() ->
            !webFirstFrameCommitted && SystemClock.uptimeMillis() - holdStart < MAX_LAUNCH_SCREEN_HOLD_MS
        );
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                webFirstFrameCommitted = true;
            }
        });

        registerPlugin(PhoneAuthPlugin.class);
        registerPlugin(AppCheckBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
