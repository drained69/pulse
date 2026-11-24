import fs from "node:fs";
import path from "node:path";
import { Config } from "@remotion/cli/config";

// The video imports the web app's real stylesheet, icons and templates from ../apps/web.
// Those files must use this package's React, not a second copy from the pnpm workspace.
const here = process.cwd();
Config.overrideWebpackConfig((c) => ({
  ...c,
  resolve: {
    ...c.resolve,
    alias: {
      ...(c.resolve?.alias as Record<string, string> | undefined),
      react: path.join(here, "node_modules/react"),
      "react-dom": path.join(here, "node_modules/react-dom"),
    },
  },
}));

// Remotion downloads its own headless Chrome on first render. On a slow connection that can
// stall, so use the installed Google Chrome when there is one (set REMOTION_CHROME=download to skip).
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (process.env.REMOTION_CHROME !== "download" && fs.existsSync(chrome)) {
  Config.setBrowserExecutable(chrome);
  Config.setChromeMode("chrome-for-testing");
}

Config.setVideoImageFormat("png");
Config.setPixelFormat("yuv420p");
Config.setCodec("h264");
Config.setCrf(16);
Config.setColorSpace("bt709");
