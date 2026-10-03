import Capacitor

class ParQueenBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(PhoneAuthPlugin())
    }
}
