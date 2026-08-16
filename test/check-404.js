const { chromium } = require('playwright-core');
const BASE = 'http://localhost:8080/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext()).newPage();
  const fourOhFour = [];
  page.on('response', (r) => { if (r.status() >= 400) fourOhFour.push(r.status() + ' ' + r.url()); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  console.log('4xx/5xx responses:', JSON.stringify(fourOhFour, null, 2));
  await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
