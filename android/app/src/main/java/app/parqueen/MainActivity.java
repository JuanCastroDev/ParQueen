package app.parqueen;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PhoneAuthPlugin.class);
        registerPlugin(AppCheckBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
