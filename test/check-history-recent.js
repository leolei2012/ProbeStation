const { chromium } = require('playwright-core');
const BASE = 'http://localhost:8080/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.device-item', { timeout: 10000 });
  await page.locator('.device-item').first().click();
  await page.waitForSelector('.group-block', { timeout: 10000 });
  await page.locator('.tab', { hasText: '历史数据' }).click();

  // 最近 5 分钟（应为修复后的新数据）
  const now = new Date();
  const start5 = new Date(now.getTime() - 5 * 60000);
  const fmt = (d) => { const p=(n)=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes()); };
  const inp = page.locator('.hist-input');
  await inp.nth(0).fill(fmt(start5));
  await inp.nth(1).fill(fmt(now));
  await page.locator('.toolbar .btn.primary', { hasText: '查询' }).click();
  await page.waitForTimeout(1500);
  const rows = await page.locator('.hist-table tbody tr').count();
  let firstDash = -1, lastDash = -1, lastRowCells = [];
  if (rows > 0) {
    const firstCells = await page.locator('.hist-table tbody tr').first().locator('td').allTextContents();
    firstDash = firstCells.slice(1).filter(c => c.trim() === '—').length;
    lastRowCells = await page.locator('.hist-table tbody tr').last().locator('td').allTextContents();
    lastDash = lastRowCells.slice(1).filter(c => c.trim() === '—').length;
  }
  console.log('最近5分钟 rows=', rows, ' 首行"—"=', firstDash, ' 末行"—"=', lastDash);
  console.log('末行前几列=', JSON.stringify(lastRowCells.slice(0, 6)));
  await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
