import Capacitor
import FirebaseAuth
import FirebaseCore
import FirebaseFunctions

@objc(PhoneAuthPlugin)
public class PhoneAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhoneAuthPlugin"
    public let jsName = "PhoneAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startVerification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmVerification", returnType: CAPPluginReturnPromise),
    ]

    private let stateLock = NSLock()
    private var verificationInFlight = false
    private var confirmInFlight = false
    private var sessions: [String: String] = [:]
    private var activeSessionId: String?

    @objc func startVerification(_ call: CAPPluginCall) {
        guard beginVerification() else {
            reject(call, "ios_phone_auth_unknown")
            return
        }
        guard clearStaleNativeUser() else {
            finishVerification()
            reject(call, "ios_phone_auth_bridge_failed")
            return
        }

        guard let phoneNumber = call.getString("phoneNumber"), !phoneNumber.isEmpty else {
            finishVerification()
            reject(call, "ios_phone_auth_invalid_number")
            return
        }
        guard firebaseReady() else {
            finishVerification()
            reject(call, "ios_phone_auth_configuration")
            return
        }

        PhoneAuthProvider.provider().verifyPhoneNumber(phoneNumber, uiDelegate: nil) { verificationID, error in
            self.finishVerification()
            if let error {
                self.reject(call, Self.sendCode(for: error))
                return
            }
            guard let verificationID, !verificationID.isEmpty else {
                self.reject(call, "ios_phone_auth_unknown")
                return
            }
            let sessionId = UUID().uuidString
            self.storeSession(sessionId, verificationID: verificationID)
            call.resolve(["sessionId": sessionId])
        }
    }

    @objc func confirmVerification(_ call: CAPPluginCall) {
        guard beginConfirm() else {
            reject(call, "ios_phone_auth_unknown")
            return
        }
        guard let sessionId = call.getString("sessionId"), !sessionId.isEmpty else {
            finishConfirm()
            reject(call, "ios_phone_auth_invalid_session")
            return
        }
        guard let code = call.getString("code"), code.range(of: #"^\d{6}$"#, options: .regularExpression) != nil else {
            finishConfirm()
            reject(call, "ios_phone_auth_invalid_code")
            return
        }
        guard let verificationID = sessionVerificationID(sessionId) else {
            finishConfirm()
            reject(call, "ios_phone_auth_invalid_session")
            return
        }
        guard firebaseReady() else {
            finishConfirm()
            reject(call, "ios_phone_auth_configuration")
            return
        }

        let expectedUid = call.getString("expectedUid")
        if let expectedUid, expectedUid.isEmpty {
            finishConfirm()
            reject(call, "ios_phone_auth_uid_mismatch")
            return
        }

        let credential = PhoneAuthProvider.provider().credential(
            withVerificationID: verificationID,
            verificationCode: code
        )
        Auth.auth().signIn(with: credential) { result, error in
            if let error {
                let code = Self.confirmCode(for: error)
                if code == "ios_phone_auth_code_expired" || code == "ios_phone_auth_invalid_session" {
                    self.invalidateSession(sessionId)
                }
                self.finishConfirm()
                self.reject(call, code)
                return
            }
            guard let uid = result?.user.uid, !uid.isEmpty else {
                if !self.signOutNativeAuth() {
                    self.finishConfirm()
                    self.reject(call, "ios_phone_auth_bridge_failed")
                    return
                }
                self.finishConfirm()
                self.reject(call, "ios_phone_auth_unknown")
                return
            }
            if let expectedUid, expectedUid != uid {
                self.invalidateSession(sessionId)
                if !self.signOutNativeAuth() {
                    self.finishConfirm()
                    self.reject(call, "ios_phone_auth_bridge_failed")
                    return
                }
                self.finishConfirm()
                self.reject(call, "ios_phone_auth_uid_mismatch")
                return
            }
            self.exchangeCustomToken(expectedUid: expectedUid) { token, failure in
                if let failure {
                    if !self.signOutNativeAuth() {
                        self.invalidateSession(sessionId)
                        self.finishConfirm()
                        self.reject(call, "ios_phone_auth_bridge_failed")
                        return
                    }
                    self.finishConfirm()
                    self.reject(call, failure)
                    return
                }
                guard let token, !token.isEmpty else {
                    if !self.signOutNativeAuth() {
                        self.invalidateSession(sessionId)
                        self.finishConfirm()
                        self.reject(call, "ios_phone_auth_bridge_failed")
                        return
                    }
                    self.finishConfirm()
                    self.reject(call, "ios_phone_auth_bridge_failed")
                    return
                }
                guard self.signOutNativeAuth() else {
                    self.invalidateSession(sessionId)
                    self.finishConfirm()
                    self.reject(call, "ios_phone_auth_bridge_failed")
                    return
                }
                self.invalidateSession(sessionId)
                self.finishConfirm()
                call.resolve([
                    "customToken": token,
                    "uid": uid,
                ])
            }
        }
    }

    private func exchangeCustomToken(
        expectedUid: String?,
        completion: @escaping (String?, String?) -> Void
    ) {
        let functions = Functions.functions(region: "us-central1")
        var payload: [String: Any] = [:]
        if let expectedUid, !expectedUid.isEmpty {
            payload["expectedUid"] = expectedUid
        }
        functions.httpsCallable("exchangePhoneAuthSession").call(payload) { result, error in
            if let error {
                completion(nil, Self.bridgeCode(for: error, expectedUid: expectedUid))
                return
            }
            let data = result?.data as? [String: Any]
            let token = data?["token"] as? String
            if let token, !token.isEmpty {
                completion(token, nil)
            } else {
                completion(nil, "ios_phone_auth_bridge_failed")
            }
        }
    }

    private func firebaseReady() -> Bool {
        Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil
            && FirebaseApp.app() != nil
    }

    private func clearStaleNativeUser() -> Bool {
        signOutNativeAuth()
    }

    private func signOutNativeAuth() -> Bool {
        guard FirebaseApp.app() != nil, Auth.auth().currentUser != nil else { return true }
        do {
            try Auth.auth().signOut()
        } catch {
            return false
        }
        return Auth.auth().currentUser == nil
    }

    private func beginVerification() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        if verificationInFlight || confirmInFlight {
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

    private func beginConfirm() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        if confirmInFlight || verificationInFlight {
            return false
        }
        confirmInFlight = true
        return true
    }

    private func finishConfirm() {
        stateLock.lock()
        confirmInFlight = false
        stateLock.unlock()
    }

    private func storeSession(_ sessionId: String, verificationID: String) {
        stateLock.lock()
        defer { stateLock.unlock() }
        if let previous = activeSessionId {
            sessions.removeValue(forKey: previous)
        }
        sessions[sessionId] = verificationID
        activeSessionId = sessionId
    }

    private func sessionVerificationID(_ sessionId: String) -> String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return sessions[sessionId]
    }

    private func invalidateSession(_ sessionId: String) {
        stateLock.lock()
        defer { stateLock.unlock() }
        sessions.removeValue(forKey: sessionId)
        if activeSessionId == sessionId {
            activeSessionId = nil
        }
    }

    private func reject(_ call: CAPPluginCall, _ code: String) {
        call.reject(code, code)
    }

    private static func sendCode(for error: Error) -> String {
        switch authCode(error) {
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

    private static func confirmCode(for error: Error) -> String {
        switch authCode(error) {
        case .invalidVerificationCode:
            return "ios_phone_auth_invalid_code"
        case .sessionExpired:
            return "ios_phone_auth_code_expired"
        case .invalidVerificationID, .missingVerificationID:
            return "ios_phone_auth_invalid_session"
        case .tooManyRequests, .quotaExceeded:
            return "ios_phone_auth_too_many_requests"
        case .networkError, .webNetworkRequestFailed:
            return "ios_phone_auth_network"
        default:
            return "ios_phone_auth_unknown"
        }
    }

    private static func bridgeCode(for error: Error, expectedUid: String?) -> String {
        let nsError = error as NSError
        if nsError.domain == FunctionsErrorDomain,
           let code = FunctionsErrorCode(rawValue: nsError.code) {
            if code == .resourceExhausted {
                return "ios_phone_auth_too_many_requests"
            }
            if code == .permissionDenied, expectedUid != nil {
                return "ios_phone_auth_uid_mismatch"
            }
        }
        return "ios_phone_auth_bridge_failed"
    }

    private static func authCode(_ error: Error) -> AuthErrorCode? {
        let nsError = error as NSError
        guard nsError.domain == AuthErrors.domain else { return nil }
        return AuthErrorCode(rawValue: nsError.code)
    }
}
