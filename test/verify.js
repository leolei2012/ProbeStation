const { chromium } = require('playwright-core');
const BASE = 'http://localhost:8080/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.device-item', { timeout: 10000 });
  await page.locator('.device-item').first().click();
  await page.waitForSelector('.group-block', { timeout: 10000 });
  await page.locator('.tab', { hasText: '历史数据' }).click();

  // 初始全选（默认），查询一次
  await page.locator('.toolbar .btn.primary', { hasText: '查询' }).click();
  await page.waitForTimeout(1000);
  const colCount1 = await page.locator('.hist-table thead th').count();
  console.log('第一次查询 表头列数(全选)=', colCount1);

  // 打开寄存器选择，清空，只勾选第1个
  await page.locator('.btn', { hasText: '选择寄存器' }).click();
  await page.locator('.reg-modal .btn', { hasText: '清空' }).click();
  await page.locator('.reg-modal .reg-item input').first().check();
  await page.locator('.reg-modal .btn.primary', { hasText: '保存' }).click();
  await page.waitForTimeout(300);
  const selLabel = await page.locator('.btn', { hasText: '选择寄存器' }).textContent();
  console.log('选择器按钮文字(应为 1/20)=', selLabel.trim());

  // 再查询一次 —— 若 stale closure，列数仍为全选列数
  await page.locator('.toolbar .btn.primary', { hasText: '查询' }).click();
  await page.waitForTimeout(1000);
  const colCount2 = await page.locator('.hist-table thead th').count();
  console.log('第二次查询 表头列数(应只 1 个寄存器 + 时间 = 2)=', colCount2);

  // 移动端侧栏占比
  const c2 = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const p2 = await c2.newPage();
  await p2.goto(BASE, { waitUntil: 'networkidle' });
  await p2.waitForSelector('.device-item', { timeout: 10000 });
  const dims = await p2.evaluate(() => {
    const sb = document.querySelector('.sidebar');
    const mn = document.querySelector('main.main');
    return {
      sidebarW: sb ? sb.getBoundingClientRect().width : -1,
      mainW: mn ? mn.getBoundingClientRect().width : -1,
      viewportW: window.innerWidth,
    };
  });
  console.log('移动端尺寸:', JSON.stringify(dims));

  await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
