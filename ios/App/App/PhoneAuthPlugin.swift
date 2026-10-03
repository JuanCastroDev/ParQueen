import Capacitor
import FirebaseAuth
import FirebaseCore

@objc(PhoneAuthPlugin)
public class PhoneAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhoneAuthPlugin"
    public let jsName = "PhoneAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startVerification", returnType: CAPPluginReturnPromise),
    ]

    private let stateLock = NSLock()
    private var verificationInFlight = false

    @objc func startVerification(_ call: CAPPluginCall) {
        guard beginVerification() else {
            reject(call, "ios_phone_auth_unknown")
            return
        }

        guard let phoneNumber = call.getString("phoneNumber"), !phoneNumber.isEmpty else {
            finishVerification()
            reject(call, "ios_phone_auth_invalid_number")
            return
        }

        do {
            try ensureFirebaseConfigured()
        } catch {
            finishVerification()
            reject(call, "ios_phone_auth_configuration")
            return
        }

        PhoneAuthProvider.provider().verifyPhoneNumber(phoneNumber, uiDelegate: nil) { verificationID, error in
            self.finishVerification()
            if let error {
                self.reject(call, Self.boundedCode(for: error))
                return
            }
            guard let verificationID, !verificationID.isEmpty else {
                self.reject(call, "ios_phone_auth_unknown")
                return
            }
            call.resolve(["verificationId": verificationID])
        }
    }

    private func ensureFirebaseConfigured() throws {
        guard Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil else {
            throw ConfigurationError.missingPlist
        }
        if FirebaseApp.app() == nil {
            FirebaseApp.configure()
        }
        guard FirebaseApp.app() != nil else {
            throw ConfigurationError.configureFailed
        }
    }

    private func beginVerification() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        if verificationInFlight {
            return false
        }
        verificationInFlight = true
        return true
    }

    private func finishVerification() {
        stateLock.lock()
        verificationInFlight = false
        stateLock.unlock()
    }

    private func reject(_ call: CAPPluginCall, _ code: String) {
        call.reject(code, code)
    }

    private static func boundedCode(for error: Error) -> String {
        let nsError = error as NSError
        guard nsError.domain == AuthErrors.domain,
              let code = AuthErrorCode(rawValue: nsError.code) else {
            return "ios_phone_auth_unknown"
        }
        switch code {
        case .invalidPhoneNumber, .missingPhoneNumber:
            return "ios_phone_auth_invalid_number"
        case .tooManyRequests, .quotaExceeded:
            return "ios_phone_auth_too_many_requests"
        case .networkError, .webNetworkRequestFailed:
            return "ios_phone_auth_network"
        case .captchaCheckFailed,
             .invalidAppCredential,
             .missingAppCredential,
             .appNotVerified,
             .missingAppToken,
             .notificationNotForwarded,
             .webContextCancelled,
             .webContextAlreadyPresented,
             .appVerificationUserInteractionFailure,
             .invalidClientID,
             .missingClientIdentifier,
             .recaptchaNotEnabled,
             .missingRecaptchaToken,
             .invalidRecaptchaToken,
             .invalidRecaptchaAction:
            return "ios_phone_auth_app_verification_failed"
        default:
            return "ios_phone_auth_unknown"
        }
    }

    private enum ConfigurationError: Error {
        case missingPlist
        case configureFailed
    }
}
