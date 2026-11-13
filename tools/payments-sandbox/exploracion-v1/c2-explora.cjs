/* global document -- el callback de page.evaluate corre en el navegador */
const path = require('node:path');
const fs = require('node:fs');
// Playwright es dependencia de apps/e2e: se resuelve desde ahí.
const { chromium } = require(
  require.resolve('@playwright/test', { paths: [path.join(__dirname, '../../../apps/e2e')] }),
);
(async () => {
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'c-state.json'), 'utf8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'es-ES', viewport: { width: 1280, height: 1400 } });
  await page.goto(s.checkoutUrl, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(__dirname, 'checkout-explora.png'), fullPage: true });
  const info = await page.evaluate(() => ({
    title: document.title,
    inputs: [...document.querySelectorAll('input,button,select')].slice(0, 60).map((e) => ({
      tag: e.tagName,
      id: e.id,
      name: e.getAttribute('name'),
      testid: e.getAttribute('data-testid'),
      type: e.getAttribute('type'),
      txt: (e.innerText || '').slice(0, 40),
    })),
    frames: [...document.querySelectorAll('iframe')].map(
      (f) => (f.name || '') + '|' + (f.src || '').slice(0, 70),
    ),
  }));
  console.log(JSON.stringify(info, null, 1).slice(0, 5000));
  await browser.close();
})().catch((e) => {
  console.error('ERROR', e.message.slice(0, 500));
  process.exit(1);
});
