package app.parqueen;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.webkit.WebView;

import androidx.core.splashscreen.SplashScreen;
import androidx.core.splashscreen.SplashScreenViewProvider;

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
    /** Upper bound for keeping the exit view up while the WebView presents its first frame. */
    private static final long MAX_EXIT_WAIT_MS = 1000;
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
        launchScreen.setOnExitAnimationListener(this::fadeOutWhenWebFramePresented);
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

    /**
     * The hold suppresses the app's draws, so the WebView presents its first
     * frame only after release, and on a slow device that can lag well behind
     * "logo loaded". Keep the exit view (it sits inside the app window, exactly
     * over the web logo) until the WebView reports its content is ready to be
     * drawn, give it one more frame, then cross-fade. Never longer than
     * MAX_EXIT_WAIT_MS.
     */
    private void fadeOutWhenWebFramePresented(SplashScreenViewProvider provider) {
        View exitView = provider.getView();
        boolean[] started = { false };
        Runnable fadeOut = () -> {
            if (started[0]) return;
            started[0] = true;
            exitView.animate().alpha(0f).setDuration(EXIT_FADE_MS).withEndAction(provider::remove).start();
        };
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView != null) {
            webView.postVisualStateCallback(0, new WebView.VisualStateCallback() {
                @Override
                public void onComplete(long requestId) {
                    webView.postOnAnimation(fadeOut);
                }
            });
        }
        mainHandler.postDelayed(fadeOut, MAX_EXIT_WAIT_MS);
    }
}
