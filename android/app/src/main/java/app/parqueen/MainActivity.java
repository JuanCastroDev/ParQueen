package app.parqueen;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.WebView;

import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    /**
     * Upper bound for holding the branded launch screen while the web boot
     * logo loads. Launch is never held longer than this, even if the page
     * never paints (the web boot watchdog then takes over).
     */
    private static final long MAX_LAUNCH_SCREEN_HOLD_MS = 2500;
    private static final long WEB_LOGO_POLL_MS = 32;
    private static final long EXIT_FADE_DELAY_MS = 100;
    private static final long EXIT_FADE_MS = 200;

    /**
     * True once the index.html boot logo (data-pq-boot) has loaded, or once
     * the boot frame is gone (React already replaced it). Fails open: if the
     * markup ever changes, the launch screen is released immediately.
     */
    private static final String WEB_LOGO_READY_JS =
        "(function(){var b=document.querySelector('[data-pq-boot]');if(!b)return true;"
            + "var i=b.querySelector('img');return !!(i&&i.complete&&i.naturalWidth>0);})()";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean webLogoReady = false;
    private long holdStart;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Keep the native launch screen until the WebView shows the identical
        // web boot logo, so the hand-off has no logo-less gap.
        // See docs/LOADING_STATES.md.
        SplashScreen launchScreen = SplashScreen.installSplashScreen(this);
        holdStart = SystemClock.uptimeMillis();
        launchScreen.setKeepOnScreenCondition(() -> !webLogoReady && !launchHoldExpired());
        // The hold suppresses the app's draws, so the WebView presents its
        // first frames only after release. Cross-fade the launch screen out
        // instead of cutting to the WebView. This exit view lives inside the
        // app window, so its logo already sits exactly over the web logo.
        launchScreen.setOnExitAnimationListener(provider ->
            provider.getView().animate()
                .alpha(0f)
                .setStartDelay(EXIT_FADE_DELAY_MS)
                .setDuration(EXIT_FADE_MS)
                .withEndAction(provider::remove)
                .start()
        );
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                pollWebLogo(view);
            }
        });

        registerPlugin(PhoneAuthPlugin.class);
        registerPlugin(AppCheckBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }

    private boolean launchHoldExpired() {
        return SystemClock.uptimeMillis() - holdStart >= MAX_LAUNCH_SCREEN_HOLD_MS;
    }

    private void pollWebLogo(WebView view) {
        if (webLogoReady || launchHoldExpired()) return;
        view.evaluateJavascript(WEB_LOGO_READY_JS, result -> {
            if ("true".equals(result)) {
                webLogoReady = true;
            } else {
                mainHandler.postDelayed(() -> pollWebLogo(view), WEB_LOGO_POLL_MS);
            }
        });
    }
}
