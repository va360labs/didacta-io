// Paga una Checkout Session alojada de Stripe con la tarjeta de prueba 4242.
const path = require('node:path');
const fs = require('node:fs');
// Playwright es dependencia de apps/e2e: se resuelve desde ahí.
const { chromium } = require(
  require.resolve('@playwright/test', { paths: [path.join(__dirname, '../../../apps/e2e')] }),
);
(async () => {
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'c-state.json'), 'utf8'));
  const url = process.argv[2] === 'sub' ? s.subCheckoutUrl : s.checkoutUrl;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'es-ES' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByText('Tarjeta', { exact: true }).first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(1500);
  await page
    .locator('button[data-testid="card-accordion-item-button"]')
    .first()
    .evaluate((el) => el.click());
  await page.waitForSelector('#cardNumber', { state: 'visible', timeout: 20000 });
  if (
    (await page.locator('#email').count()) &&
    !(await page
      .locator('#email')
      .inputValue()
      .catch(() => 'x'))
  )
    await page.fill('#email', 'alumna-compra+auditoria@example.com');
  await page.fill('#cardNumber', '4242 4242 4242 4242');
  await page.fill('#cardExpiry', '12 / 34');
  await page.fill('#cardCvc', '123');
  if (await page.locator('#billingName').count())
    await page.fill('#billingName', 'Alumna De Prueba');
  if (await page.locator('#billingPostalCode').count())
    await page.fill('#billingPostalCode', '28001').catch(() => {});
  await page.screenshot({ path: path.join(__dirname, 'checkout-antes.png') });
  await page.locator('[data-testid="hosted-payment-submit-button"], .SubmitButton').first().click();
  await page
    .waitForURL((u) => !u.toString().includes('checkout.stripe.com'), { timeout: 60000 })
    .catch(() => {});
  console.log('URL final:', page.url().slice(0, 120));
  await page.screenshot({ path: path.join(__dirname, 'checkout-despues.png') }).catch(() => {});
  await browser.close();
})().catch((e) => {
  console.error('ERROR', e.message.slice(0, 500));
  process.exit(1);
});
