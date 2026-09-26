// One-off icon rasterizer: renders public/icon.svg (+ maskable variant) to
// the PNG sizes the web app manifest references, using the same headless
// Chrome the e2e suite uses. Re-run after changing the logo:
//
//   node scripts/pwa-icons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const targets = [
  { svg: "public/icon.svg", out: "public/pwa-192.png", size: 192 },
  { svg: "public/icon.svg", out: "public/pwa-512.png", size: 512 },
  { svg: "public/icon-maskable.svg", out: "public/maskable-512.png", size: 512 },
  { svg: "public/icon.svg", out: "public/apple-touch-icon.png", size: 180 },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage();
  for (const { svg, out, size } of targets) {
    const b64 = readFileSync(svg).toString("base64");
    await page.setContent(
      `<body style="margin:0"><img src="data:image/svg+xml;base64,${b64}" width="${size}" height="${size}"></body>`,
    );
    const img = page.locator("img");
    await img.waitFor();
    // rasterization of the SVG is async — wait until the image is decoded
    await page.waitForFunction(() => {
      const i = document.querySelector("img");
      return !!i && i.complete && i.naturalWidth > 0;
    });
    await page.waitForTimeout(120);
    const png = await img.screenshot({ type: "png", omitBackground: true });
    writeFileSync(out, png);
    console.log(`${out} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
