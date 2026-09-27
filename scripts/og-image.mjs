// Generates public/og.png — the 1200×630 social preview (Open Graph) shown
// when maishare links are shared in chat apps. The design mirrors the app's
// home hero: dark backdrop with the brand glows, gradient bolt, wordmark and
// tagline. Rendered by headless Chrome so it stays faithful to the CSS used
// in the product.
//
//   node scripts/og-image.mjs
//
// Playwright drives the same Chrome binary the e2e suite uses.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const WIDTH = 1200;
const HEIGHT = 630;
const SCALE = 2; // render at 2x for crisp downscaling in preview cards

const html = `<!doctype html>
<html>
<head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body {
    display: flex; align-items: center; justify-content: center;
    background:
      radial-gradient(900px 440px at 82% -12%, rgba(99, 102, 241, 0.32), transparent 62%),
      radial-gradient(760px 420px at 6% 116%, rgba(34, 211, 238, 0.20), transparent 62%),
      #0b0d12;
    color: #e8ecf4;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  }
  .center { text-align: center; padding-bottom: 10px; }
  .brand-row { display: flex; align-items: center; justify-content: center; gap: 26px; }
  .wordmark { font-size: 104px; font-weight: 750; letter-spacing: -0.035em; }
  .tagline { margin-top: 30px; font-size: 31px; color: #8b93a7; }
  .tagline strong { color: #e8ecf4; font-weight: 600; }
  .chips { margin-top: 40px; display: flex; justify-content: center; gap: 16px; }
  .chip {
    padding: 11px 26px; border-radius: 999px; font-size: 21px; color: #aab3c8;
    background: rgba(26, 31, 46, 0.75); border: 1px solid #2e3750;
  }
  .chip b { color: #22d3ee; font-weight: 600; }
</style></head>
<body>
  <div class="center">
    <div class="brand-row">
      <svg width="104" height="104" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M13 2 4.5 13.5H11l-1 8.5L18.5 10.5H12l1-8.5z"
          fill="url(#g)" stroke="url(#g)" stroke-width="1.2" stroke-linejoin="round"
        />
        <defs>
          <linearGradient id="g" x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
            <stop stop-color="#818cf8" />
            <stop offset="1" stop-color="#22d3ee" />
          </linearGradient>
        </defs>
      </svg>
      <div class="wordmark">maishare</div>
    </div>
    <p class="tagline">Local-first, <strong>peer-to-peer</strong> sharing for everyone.</p>
    <div class="chips">
      <span class="chip">files <b>&amp;</b> text</span>
      <span class="chip"><b>end-to-end</b> encrypted</span>
      <span class="chip">no cloud</span>
    </div>
  </div>
</body>
</html>`;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
  });
  await page.setContent(html, { waitUntil: "load" });
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  const out = fileURLToPath(new URL("../public/og.png", import.meta.url));
  await writeFile(out, png);
  console.log(`og.png written (${WIDTH * SCALE}×${HEIGHT * SCALE}) → ${out}`);
} finally {
  await browser.close();
}
