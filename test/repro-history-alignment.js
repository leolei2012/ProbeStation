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

  // 1) 只选 1 个寄存器并查询
  await page.locator('.btn', { hasText: '选择寄存器' }).click();
  await page.locator('.reg-modal .btn', { hasText: '清空' }).click();
  await page.locator('.reg-modal .reg-item input').first().check();
  await page.locator('.reg-modal .btn.primary', { hasText: '保存' }).click();
  await page.waitForTimeout(200);
  await page.locator('.toolbar .btn.primary', { hasText: '查询' }).click();
  await page.waitForTimeout(1000);

  // 2) 再全选并再次查询
  await page.locator('.btn', { hasText: '选择寄存器' }).click();
  await page.locator('.reg-modal .btn', { hasText: '全选' }).click();
  await page.locator('.reg-modal .btn.primary', { hasText: '保存' }).click();
  await page.waitForTimeout(200);
  await page.locator('.toolbar .btn.primary', { hasText: '查询' }).click();
  await page.waitForTimeout(1200);

  const cols = await page.locator('.hist-table thead th').count();
  // 取第一行数据单元格
  const cells = await page.locator('.hist-table tbody tr').first().locator('td').allTextContents();
  const dashCount = cells.slice(1).filter((c) => c.trim() === '—').length;
  const valCount = cells.slice(1).filter((c) => c.trim() !== '—' && c.trim() !== '').length;
  console.log('第二次查询 列数=', cols, ' 数据列(去掉时间)=', cells.length - 1);
  console.log('  有值单元格=', valCount, ' 显示为"—"的单元格=', dashCount);
  console.log('  首行单元格=', JSON.stringify(cells));

  await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
