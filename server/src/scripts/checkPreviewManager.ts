import assert from "node:assert/strict";
import {
  buildEmulatorArgs,
  resolveEmulatorLaunchConfig,
} from "../skills/previewManager.js";

const desktop = resolveEmulatorLaunchConfig({}, "darwin");
assert.equal(desktop.headless, false, "macOS must default to a visible emulator window");
assert.equal(desktop.gpu, "auto");
assert.ok(!buildEmulatorArgs("Pixel_9_Pro", 6144, 4, desktop).includes("-no-window"));

const server = resolveEmulatorLaunchConfig({}, "linux");
assert.equal(server.headless, true, "headless Linux must retain no-window mode");
assert.equal(server.gpu, "swiftshader_indirect");
assert.ok(buildEmulatorArgs("Pixel_9_Pro", 6144, 4, server).includes("-no-window"));

assert.equal(
  resolveEmulatorLaunchConfig({ DISPLAY: ":0" }, "linux").headless,
  false,
  "Linux with a desktop display must default to a visible emulator",
);

assert.equal(
  resolveEmulatorLaunchConfig({ PREVIEW_EMU_HEADLESS: "true" }, "darwin").headless,
  true,
  "the explicit headless override must win on desktop",
);
assert.equal(
  resolveEmulatorLaunchConfig({ PREVIEW_EMU_HEADLESS: "false" }, "linux").headless,
  false,
  "the explicit visible override must win on Linux",
);
assert.equal(
  resolveEmulatorLaunchConfig({ PREVIEW_EMU_HEADLESS: "false", PREVIEW_EMU_GPU: "host" }, "darwin").gpu,
  "host",
);
assert.throws(
  () => resolveEmulatorLaunchConfig({ PREVIEW_EMU_HEADLESS: "sometimes" }, "darwin"),
  /must be true or false/,
);

console.log("preview emulator launch-mode checks passed");
