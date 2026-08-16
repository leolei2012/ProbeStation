const { chromium } = require('playwright-core');
const BASE = 'http://localhost:8080/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const results = [];
const ok = (label, detail, pass) => results.push({ label, detail, pass });
let consoleMsgs = [];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(m.type() + ': ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.device-item', { timeout: 10000 });
  ok('加载 2 台设备', 'count=' + await page.locator('.device-item').count(), (await page.locator('.device-item').count()) === 2);

  // 新建设备弹窗：transport 选择器 + RTU 字段
  await page.locator('.new-device-btn').click();
  const modal = page.locator('.modal', { hasText: '新建设备' });
  ok('新建设备弹窗打开', '', await modal.count() > 0);
  const transportSel = modal.locator('select').first();
  const transportOptions = await transportSel.locator('option').allTextContents();
  ok('连接方式含 TCP/RTU', JSON.stringify(transportOptions), transportOptions.some(t => t.includes('TCP')) && transportOptions.some(t => t.includes('RTU')));

  // 切到 RTU，应出现串口字段
  await transportSel.selectOption('rtu');
  await page.waitForTimeout(200);
  const labels = await modal.locator('label').allTextContents();
  ok('RTU 串口字段出现', JSON.stringify(labels), labels.some(l => l.includes('串口路径')) && labels.some(l => l.includes('波特率')) && labels.some(l => l.includes('校验位')));
  await page.screenshot({ path: 'C:/Users/22671/AppData/Local/Temp/ps-browser-test/rtu-modal.png' });

  // 创建 RTU 设备
  await modal.locator('input').nth(0).fill('RTU-UI设备');
  await modal.locator('input').nth(1).fill('COM7');
  await modal.locator('.btn.primary', { hasText: '添加' }).click();
  await page.waitForTimeout(800);
  const devCount = await page.locator('.device-item').count();
  ok('RTU 设备创建成功', 'count=' + devCount, devCount === 3);
  const rtuItem = page.locator('.device-item', { hasText: 'RTU-UI设备' });
  ok('RTU 设备显示串口路径', '', (await rtuItem.textContent().catch(() => '')).includes('COM7'));

  // 删除 RTU 设备
  page.once('dialog', async (d) => { await d.accept(); });
  await rtuItem.locator('.device-del').click();
  await page.waitForTimeout(700);
  ok('删除 RTU 设备后恢复 2 台', 'count=' + await page.locator('.device-item').count(), (await page.locator('.device-item').count()) === 2);

  // 回归：设备1 实时表 / 历史 / 曲线
  await page.locator('.device-item').first().click();
  await page.waitForSelector('.group-block', { timeout: 10000 });
  ok('设备1 实时表 2 组', 'groups=' + await page.locator('.group-block').count(), (await page.locator('.group-block').count()) === 2);
  await page.locator('.tab', { hasText: '历史数据' }).click();
  await page.locator('.toolbar .btn.primary', { hasText: '查询' }).click();
  await page.waitForTimeout(1200);
  ok('历史查询有数据', 'rows=' + await page.locator('.hist-table tbody tr').count(), (await page.locator('.hist-table tbody tr').count()) > 0);
  await page.locator('.tab', { hasText: '曲线' }).click();
  await page.waitForTimeout(1200);
  ok('曲线渲染', 'paths=' + await page.locator('.chart-wrap svg path').count(), (await page.locator('.chart-wrap svg path').count()) > 0);

  await page.waitForTimeout(500);
  ok('无 console 错误/告警', 'msgs=' + consoleMsgs.length, consoleMsgs.length === 0);
  consoleMsgs.forEach((m) => console.log('  console: ' + m.slice(0, 150)));

  await browser.close();

  const pass = results.filter(r => r.pass).length;
  const fail = results.filter(r => !r.pass).length;
  console.log('=== RTU + 回归测试 ===');
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.label} | ${r.detail}`);
  console.log(`TOTAL: ${pass} pass / ${fail} fail`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
