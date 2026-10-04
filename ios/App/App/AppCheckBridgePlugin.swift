import Capacitor
import FirebaseAppCheck
import FirebaseCore

@objc(AppCheckBridgePlugin)
public class AppCheckBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppCheckBridgePlugin"
    public let jsName = "AppCheckBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getToken", returnType: CAPPluginReturnPromise),
    ]

    private static let failure = "Native App Check token request failed."

    @objc func getToken(_ call: CAPPluginCall) {
        guard FirebaseApp.app() != nil else {
            call.reject(Self.failure, Self.failure)
            return
        }

        Task {
            do {
                let appCheckToken = try await AppCheck.appCheck().token(forcingRefresh: false)
                let expireTimeMillis = Int64(appCheckToken.expirationDate.timeIntervalSince1970 * 1000)
                await MainActor.run {
                    call.resolve([
                        "token": appCheckToken.token,
                        "expireTimeMillis": expireTimeMillis,
                    ])
                }
            } catch {
                await MainActor.run {
                    call.reject(Self.failure, Self.failure)
                }
            }
        }
    }
}
