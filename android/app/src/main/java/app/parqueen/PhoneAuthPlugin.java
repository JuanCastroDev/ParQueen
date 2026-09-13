package app.parqueen;

import android.app.Activity;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseException;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.PhoneAuthCredential;
import com.google.firebase.auth.PhoneAuthOptions;
import com.google.firebase.auth.PhoneAuthProvider;

import java.util.concurrent.TimeUnit;

/**
 * Narrow Android Phone Auth bridge. Starts Firebase native verification and
 * returns a verificationId so the existing ParQueen OTP UI can finish signup
 * with PhoneAuthProvider.credential + signInWithCredential on the JS Auth
 * instance. Does not present a native OTP dialog.
 */
@CapacitorPlugin(name = "PhoneAuth")
public class PhoneAuthPlugin extends Plugin {
    private PhoneAuthProvider.ForceResendingToken forceResendingToken;
    private PluginCall pendingCall;

    @PluginMethod
    public void startVerification(PluginCall call) {
        String phoneNumber = call.getString("phoneNumber");
        if (phoneNumber == null || phoneNumber.isEmpty()) {
            call.reject("phoneNumber is required");
            return;
        }

        if (!isFirebaseConfigured()) {
            call.reject(
                "Firebase Android is not configured. Register package app.parqueen, "
                    + "add debug SHA-1/SHA-256, and place android/app/google-services.json "
                    + "(do not commit that file)."
            );
            return;
        }

        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Phone verification requires an active Android activity.");
            return;
        }

        if (pendingCall != null) {
            pendingCall.reject("A verification request is already in progress.");
        }
        pendingCall = call;

        boolean resend = Boolean.TRUE.equals(call.getBoolean("resend", false));
        PhoneAuthOptions.Builder builder = PhoneAuthOptions.newBuilder(FirebaseAuth.getInstance())
            .setPhoneNumber(phoneNumber)
            .setTimeout(60L, TimeUnit.SECONDS)
            .setActivity(activity)
            .setCallbacks(new PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
                @Override
                public void onVerificationCompleted(@NonNull PhoneAuthCredential credential) {
                    // Instant / auto-retrieval must not replace ParQueen's 6-digit UI.
                    // The user still enters the SMS code; JS completes sign-in.
                    if (credential.getSmsCode() == null && pendingCall == call) {
                        rejectPending(
                            "Instant verification without an SMS code is not supported. "
                                + "Wait for the SMS and enter the code in ParQueen."
                        );
                    }
                }

                @Override
                public void onVerificationFailed(@NonNull FirebaseException exception) {
                    rejectPending(exception.getMessage());
                }

                @Override
                public void onCodeSent(
                    @NonNull String verificationId,
                    @NonNull PhoneAuthProvider.ForceResendingToken token
                ) {
                    forceResendingToken = token;
                    JSObject result = new JSObject();
                    result.put("verificationId", verificationId);
                    resolvePending(result);
                }
            });

        if (resend && forceResendingToken != null) {
            builder.setForceResendingToken(forceResendingToken);
        }

        PhoneAuthProvider.verifyPhoneNumber(builder.build());
    }

    private boolean isFirebaseConfigured() {
        try {
            FirebaseApp.getInstance();
            return true;
        } catch (IllegalStateException exception) {
            return false;
        }
    }

    private void resolvePending(JSObject result) {
        PluginCall call = pendingCall;
        pendingCall = null;
        if (call != null) {
            call.resolve(result);
        }
    }

    private void rejectPending(String message) {
        PluginCall call = pendingCall;
        pendingCall = null;
        if (call != null) {
            call.reject(message == null ? "Phone verification failed." : message);
        }
    }
}
