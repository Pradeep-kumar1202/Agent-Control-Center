/**
 * Pre-build patcher for hyperswitch-client-core's demo-app.
 *
 * Detox's `device.enableSynchronization()` / launch with
 * `detoxEnableSynchronization: 1` both cast the Application to
 * `com.facebook.react.ReactApplication` to reach the ReactNativeHost. The
 * vendored demo-app ships with no custom Application class, so Android
 * instantiates the default `android.app.Application` and Detox crashes:
 *
 *   android.app.Application cannot be cast to com.facebook.react.ReactApplication
 *
 * Rather than commit the fix upstream, we patch the source in the local
 * workspace clone every time we run tests:
 *
 *   1. Write `DemoApplication.kt` — a Kotlin class that extends Application,
 *      implements ReactApplication, and forwards to the SDK's
 *      `ReactNativeController` for its `ReactNativeHost` / `ReactHost`.
 *   2. Inject `android:name=".DemoApplication"` into `<application …>` in
 *      `AndroidManifest.xml`.
 *
 * Both steps are idempotent. `forceCheckoutBranch()` resets the working tree
 * back to a clean state every run, so the patch is re-applied fresh each
 * time and we never accidentally commit these changes to the fork.
 */

import fs from "node:fs";
import path from "node:path";

const DEMO_APP_PKG_DIR = "android/demo-app/src/main/kotlin/io/hyperswitch/demoapp";
const MANIFEST_PATH = "android/demo-app/src/main/AndroidManifest.xml";

const DEMO_APPLICATION_KT = `package io.hyperswitch.demoapp

import android.app.Application
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import io.hyperswitch.react.ReactNativeController

/**
 * Auto-injected by the test harness (server/src/skills/tests/patchDemoApp.ts)
 * so Detox can cast getApplicationContext() to ReactApplication and reach the
 * SDK's ReactNativeHost via ReactNativeController.
 *
 * Do not commit — this file is rewritten on every test run after
 * forceCheckoutBranch resets the working tree.
 */
class DemoApplication : Application(), ReactApplication {
    override fun onCreate() {
        super.onCreate()
        ReactNativeController.initialize(this)
    }

    override val reactNativeHost: ReactNativeHost
        get() = ReactNativeController.getReactNativeHost()

    override val reactHost: ReactHost
        get() = ReactNativeController.getReactHost()
}
`;

export function patchDemoAppForDetox(
  repoDir: string,
  log: (line: string) => void,
): void {
  const ktDir = path.join(repoDir, DEMO_APP_PKG_DIR);
  const ktFile = path.join(ktDir, "DemoApplication.kt");
  const manifestPath = path.join(repoDir, MANIFEST_PATH);

  // 1. Write DemoApplication.kt (overwrite every time — cheap, idempotent).
  fs.mkdirSync(ktDir, { recursive: true });
  fs.writeFileSync(ktFile, DEMO_APPLICATION_KT, "utf8");
  log(`[patch] wrote ${DEMO_APP_PKG_DIR}/DemoApplication.kt`);

  // 2. Inject android:name=".DemoApplication" into the <application> tag
  //    if not already there. Regex match is tight to avoid re-patching on
  //    repeated runs.
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`demo-app AndroidManifest.xml not found at ${manifestPath}`);
  }
  const original = fs.readFileSync(manifestPath, "utf8");
  if (/<application[^>]*\bandroid:name\s*=/.test(original)) {
    log(`[patch] AndroidManifest.xml already declares android:name — skipping`);
    return;
  }
  const patched = original.replace(
    /<application(\s+)/,
    `<application$1android:name=".DemoApplication"$1`,
  );
  if (patched === original) {
    throw new Error(`failed to inject android:name into ${MANIFEST_PATH}`);
  }
  fs.writeFileSync(manifestPath, patched, "utf8");
  log(`[patch] injected android:name=".DemoApplication" into AndroidManifest.xml`);
}
