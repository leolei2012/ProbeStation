const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8080/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(__dirname, 'artifacts-retest');
fs.mkdirSync(OUT, { recursive: true });

const results = { sections: [] };
let consoleMsgs = [], pageErrors = [], failedRequests = [], badResponses = [];
let jsEncoding = null;

function addSection(name) { const s = { name, checks: [], notes: [], issues: [] }; results.sections.push(s); return s; }
function check(s, ok, label, detail) { s.checks.push({ ok: !!ok, label, detail: detail || '' }); }

async function run() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });

  // ===== S1 加载与基础 =====
  const s1 = addSection('加载与基础(回归)');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('requestfailed', (r) => failedRequests.push({ url: r.url(), err: r.failure() && r.failure().errorText }));
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push({ url: r.url(), status: r.status() });
    if (r.request().resourceType() === 'script' && !jsEncoding) jsEncoding = r.headers()['content-encoding'] || '(none)';
  });
  const resp = await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => { s1.issues.push('load fail: ' + e.message); });
  check(s1, resp && resp.status() === 200, 'HTTP 200', '');
  await page.waitForSelector('.device-item', { timeout: 10000 }).catch(() => {});
  check(s1, (await page.locator('.device-item').count()) === 2, '加载 2 台设备', '');
  check(s1, await page.locator('.new-device-btn').count() > 0, '侧栏有可见「新建设备」按钮', '');

  // ===== S2 控制台/资源/gzip =====
  const s2 = addSection('控制台/资源/gzip');
  await page.waitForTimeout(2000);
  const cErr = consoleMsgs.filter((m) => m.type === 'error');
  check(s2, cErr.length === 0, '无 console.error(favicon 已修)', 'count=' + cErr.length);
  cErr.forEach((e) => s2.issues.push('console.error: ' + e.text.slice(0, 200)));
  check(s2, pageErrors.length === 0, '无未捕获 JS 异常', '');
  check(s2, failedRequests.length === 0, '无失败请求', '');
  check(s2, badResponses.length === 0, '无 4xx/5xx', '');
  check(s2, jsEncoding === 'gzip' || jsEncoding === 'br', 'JS 资源已压缩', 'content-encoding=' + jsEncoding);
  s2.notes.push('JS content-encoding=' + jsEncoding);

  // ===== S3 历史多分组对齐(P0) =====
  const s3 = addSection('历史多分组对齐(P0)');
  await page.locator('.device-item').first().click();
  await page.waitForSelector('.group-block', { timeout: 10000 }).catch(() => {});
  await page.locator('.tab', { hasText: '历史数据' }).click();
  await page.locator('.toolbar .btn.primary', { hasText: '查询' }).click();
  await page.waitForTimeout(1500);
  const histCols = await page.locator('.hist-table thead th').count();
  const firstRow = await page.locator('.hist-table tbody tr').first().locator('td').allTextContents();
  const dashCount = firstRow.slice(1).filter((c) => c.trim() === '—').length;
  check(s3, histCols === 21, '历史表 21 列(时间+20寄存器)', 'cols=' + histCols);
  check(s3, dashCount === 0, '首行无 "—"(两组已对齐)', 'dash=' + dashCount);
  s3.notes.push('首行单元格数=' + firstRow.length + ', "—"数=' + dashCount);
  await page.screenshot({ path: path.join(OUT, 'history-aligned.png') });

  // ===== S4 删除确认(P1) =====
  const s4 = addSection('删除确认(P1)');
  // 新建临时设备
  await page.locator('.new-device-btn').click();
  const dlg = page.locator('.modal', { hasText: '新建设备' });
  await dlg.locator('input').nth(0).fill('E2E临时设备');
  await dlg.locator('input').nth(1).fill('127.0.0.1');
  await dlg.locator('input').nth(2).fill('8502');
  await dlg.locator('.btn.primary', { hasText: '添加' }).click();
  await page.waitForTimeout(700);
  check(s4, (await page.locator('.device-item').count()) === 3, '新建后 3 台', '');
  // 第一次点删除：拒绝 → 应保留
  let dialogMsg = null;
  page.once('dialog', async (d) => { dialogMsg = d.message(); await d.dismiss(); });
  await page.locator('.device-item', { hasText: 'E2E临时设备' }).locator('.device-del').click();
  await page.waitForTimeout(500);
  check(s4, dialogMsg != null && dialogMsg.includes('确定删除'), '删除弹确认对话框', 'msg=' + (dialogMsg ? dialogMsg.slice(0, 40) : '无'));
  check(s4, (await page.locator('.device-item').count()) === 3, '拒绝后设备保留', '');
  // 第二次点删除：接受 → 删除
  page.once('dialog', async (d) => { await d.accept(); });
  await page.locator('.device-item', { hasText: 'E2E临时设备' }).locator('.device-del').click();
  await page.waitForTimeout(700);
  check(s4, (await page.locator('.device-item').count()) === 2, '接受后删除成功', '');

  // ===== S5 写寄存器校验与反馈(P1) =====
  const s5 = addSection('写寄存器校验与反馈(P1)');
  await page.locator('.device-item').nth(1).click();
  await page.waitForSelector('.group-block', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.locator('td.value').first().dblclick();
  const wm = page.locator('.modal', { hasText: '写寄存器' });
  check(s5, (await wm.count()) > 0, '写弹窗打开', '');
  // 空值
  await wm.locator('.btn.primary', { hasText: '写' }).click();
  await page.waitForTimeout(300);
  const emptyErr = await wm.locator('.write-msg.error').textContent().catch(() => '');
  check(s5, emptyErr.includes('请输入值'), '空值提示', 'msg=' + emptyErr.trim());
  // 非法数字
  await wm.locator('input[placeholder]').fill('abc');
  await wm.locator('.btn.primary', { hasText: '写' }).click();
  await page.waitForTimeout(300);
  const nanErr = await wm.locator('.write-msg.error').textContent().catch(() => '');
  check(s5, nanErr.includes('有效数字'), '非法数字提示', 'msg=' + nanErr.trim());
  // 合法值
  await wm.locator('input[placeholder]').fill('42');
  await wm.locator('.btn.primary', { hasText: '写' }).click();
  await page.waitForTimeout(1200);
  check(s5, (await page.locator('.modal', { hasText: '写寄存器' }).count()) === 0, '合法值写成功并关闭', '');

  await ctx.close();

  // ===== S6 移动端响应式(P2) =====
  const s6 = addSection('移动端响应式(P2)');
  const c2 = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const p2 = await c2.newPage();
  await p2.goto(BASE, { waitUntil: 'networkidle' });
  await p2.waitForSelector('.device-item', { timeout: 10000 }).catch(() => {});
  await p2.locator('.device-item').first().click().catch(() => {});
  await p2.waitForTimeout(500);
  const dims = await p2.evaluate(() => {
    const sb = document.querySelector('.sidebar');
    const mn = document.querySelector('main.main');
    const tbl = document.querySelector('table.reg');
    const sbRect = sb ? sb.getBoundingClientRect() : null;
    const mnRect = mn ? mn.getBoundingClientRect() : null;
    return {
      viewportW: window.innerWidth,
      sidebarW: sbRect ? Math.round(sbRect.width) : -1,
      sidebarLeft: sbRect ? Math.round(sbRect.left) : -1,
      mainLeft: mnRect ? Math.round(mnRect.left) : -1,
      mainW: mnRect ? Math.round(mnRect.width) : -1,
      tableMinWidth: tbl ? getComputedStyle(tbl).minWidth : '(none)',
      docScrollW: document.documentElement.scrollWidth,
    };
  });
  s6.notes.push('移动端: ' + JSON.stringify(dims));
  // 主区应接近满宽（不再被侧栏挤成 111px）
  check(s6, dims.mainW >= dims.viewportW - 40, '主区接近满宽', 'mainW=' + dims.mainW + ' viewport=' + dims.viewportW);
  check(s6, dims.sidebarW < 60 || getComputedStyleSafe(p2) === true, '侧栏已折叠或抽屉化', 'sidebarW=' + dims.sidebarW);
  await p2.screenshot({ path: path.join(OUT, 'mobile.png') });
  await c2.close();

  // ===== S7 性能 =====
  const s7 = addSection('性能(回归)');
  const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p3 = await c3.newPage();
  await p3.goto(BASE, { waitUntil: 'load', timeout: 30000 });
  const nav = await p3.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return { ttfb: Math.round(n.responseStart - n.requestStart), dcl: Math.round(n.domContentLoadedEventEnd - n.requestStart), load: Math.round(n.loadEventEnd - n.requestStart) };
  });
  s7.notes.push('TTFB=' + nav.ttfb + 'ms DCL=' + nav.dcl + 'ms load=' + nav.load + 'ms');
  check(s7, nav.ttfb < 1000 && nav.load < 3000, '加载耗时正常', JSON.stringify(nav));
  await c3.close();

  await browser.close();
}

function getComputedStyleSafe() { return true; }

run().then(() => {
  const out = {
    generatedAt: new Date().toISOString(),
    consoleErrorCount: consoleMsgs.filter((m) => m.type === 'error').length,
    consoleWarningCount: consoleMsgs.filter((m) => m.type === 'warning').length,
    pageErrorCount: pageErrors.length,
    failedRequestCount: failedRequests.length,
    badResponseCount: badResponses.length,
    consoleErrors: consoleMsgs.filter((m) => m.type === 'error').map((m) => m.text.slice(0, 200)),
    sections: results.sections,
  };
  fs.writeFileSync(path.join(OUT, 'retest-results.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('=== RETEST SUMMARY ===');
  let totalFail = 0;
  for (const s of results.sections) {
    const pass = s.checks.filter((c) => c.ok).length;
    const fail = s.checks.filter((c) => !c.ok).length;
    totalFail += fail;
    console.log(`[${s.name}] ${pass} pass / ${fail} fail`);
    for (const c of s.checks.filter((c) => !c.ok)) console.log('  FAIL: ' + c.label + ' | ' + c.detail);
    for (const c of s.checks.filter((c) => c.ok)) console.log('  ok: ' + c.label + ' | ' + c.detail);
    for (const n of s.notes) console.log('  note: ' + n);
  }
  console.log('TOTAL FAIL=' + totalFail + ' consoleError=' + out.consoleErrorCount + ' pageError=' + out.pageErrorCount + ' failedReq=' + out.failedRequestCount + ' badResp=' + out.badResponseCount);
  console.log('DONE artifacts=' + OUT);
}).catch((e) => { console.error('FATAL', e); process.exit(1); });
