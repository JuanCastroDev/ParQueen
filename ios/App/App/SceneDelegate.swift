import Capacitor
import FirebaseAuth
import FirebaseCore
import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = ParQueenBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        var remaining = Set<UIOpenURLContext>()
        for context in URLContexts {
            if FirebaseApp.app() != nil, Auth.auth().canHandle(context.url) {
                continue
            }
            remaining.insert(context)
        }
        if !remaining.isEmpty {
            SceneDelegateProxy.shared.scene(scene, openURLContexts: remaining)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
