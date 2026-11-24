// Usage: node scripts/android/render-splash-logo.cjs <path-to-sharp> assets/Parqueen_Logo.png
//          android/app/src/main/res/drawable-nodpi/pq_splash_logo.png
// (sharp ships in functions/node_modules.)
// Renders the Android 12+ splash icon from the approved logo asset, unchanged:
// a 288dp transparent canvas (xxxhdpi: 1152 px) with the full 818x669 logo
// canvas scaled to 160dp wide (the web LoadingScreen width), centered and
// lowered 12dp: the WebView starts below the status bar, so the web logo's
// center sits about half a status bar (measured 13dp) below screen center.
const sharp = require(process.argv[2]);
const [, , , src, out] = process.argv;
const SCALE = 4, CANVAS = 288 * SCALE, LOGO_W = 160 * SCALE, DROP = 12 * SCALE;
(async () => {
  const logo = await sharp(src).resize({ width: LOGO_W }).png().toBuffer();
  const { height } = await sharp(logo).metadata();
  await sharp({ create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: logo, left: (CANVAS - LOGO_W) / 2, top: Math.round((CANVAS - height) / 2) + DROP }])
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(JSON.stringify({ CANVAS, LOGO_W, logoH: height, DROP }));
})();
