const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8080/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(__dirname, 'artifacts');
const SHOT = path.join(OUT, 'screenshots');
fs.mkdirSync(SHOT, { recursive: true });

const results = { sections: [] };
let consoleMsgs = [];
let pageErrors = [];
let failedRequests = [];
let badResponses = [];

function addSection(name) {
  const s = { name, checks: [], notes: [], issues: [] };
  results.sections.push(s);
  return s;
}
function check(s, ok, label, detail) {
  s.checks.push({ ok: !!ok, label, detail: detail || '' });
}

async function run() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });

  // ---------- Section 1: Page load & basic ----------
  const s1 = addSection('页面加载与基础检查');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  page.on('console', (m) => { consoleMsgs.push({ type: m.type(), text: m.text() }); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('requestfailed', (r) => failedRequests.push({ url: r.url(), err: r.failure() && r.failure().errorText }));
  page.on('response', (r) => { if (r.status() >= 400) badResponses.push({ url: r.url(), status: r.status() }); });

  const t0 = Date.now();
  let resp;
  try {
    resp = await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    check(s1, false, '页面加载', 'networkidle 超时或失败: ' + e.message);
  }
  const loadMs = Date.now() - t0;
  check(s1, resp && resp.status() === 200, 'HTTP 状态 200', resp ? 'status=' + resp.status() : '无响应');
  check(s1, await page.title() === 'ProbeStation', '标题 ProbeStation', 'title=' + (await page.title()));
  check(s1, (await page.locator('.brand').textContent().catch(() => '')) === 'ProbeStation', '侧栏品牌渲染', '');
  check(s1, await page.locator('.sidebar').count() > 0, '侧栏存在', '');
  check(s1, await page.locator('.settings-btn').count() > 0, '设置按钮存在', '');
  // devices load
  await page.waitForSelector('.device-item', { timeout: 10000 }).catch(() => {});
  const devCount = await page.locator('.device-item').count();
  check(s1, devCount === 2, '加载 2 台设备', 'device-item 数量=' + devCount);
  s1.notes.push('networkidle 耗时(含轮询抖动)≈' + loadMs + 'ms');
  await page.screenshot({ path: path.join(SHOT, '01-empty-or-first.png') });

  // ---------- Section 2: Console & resources ----------
  const s2 = addSection('控制台与资源检查');
  await page.waitForTimeout(2500); // 等一会让 WS 轮询/错误冒出来
  const cErr = consoleMsgs.filter((m) => m.type === 'error');
  const cWarn = consoleMsgs.filter((m) => m.type === 'warning');
  check(s2, cErr.length === 0, '无 console.error', 'count=' + cErr.length);
  s2.notes.push('console.warning count=' + cWarn.length);
  cWarn.slice(0, 20).forEach((w) => s2.notes.push('  warn: ' + w.text.slice(0, 200)));
  check(s2, pageErrors.length === 0, '无未捕获 JS 异常', 'count=' + pageErrors.length);
  check(s2, failedRequests.length === 0, '无失败请求', 'count=' + failedRequests.length);
  check(s2, badResponses.length === 0, '无 4xx/5xx 响应', 'count=' + badResponses.length);
  failedRequests.forEach((f) => s2.issues.push('requestfailed: ' + f.url + ' -> ' + f.err));
  badResponses.forEach((b) => s2.issues.push('bad response: ' + b.status + ' ' + b.url));
  cErr.forEach((e) => s2.issues.push('console.error: ' + e.text.slice(0, 300)));
  pageErrors.forEach((e) => s2.issues.push('pageerror: ' + e.slice(0, 300)));

  // ---------- Section 3: Functional ----------
  const s3 = addSection('功能流程测试');

  // 3.1 选择设备1 -> 实时表
  await page.locator('.device-item').first().click();
  await page.waitForSelector('.group-block', { timeout: 10000 }).catch(() => {});
  const gBlocks = await page.locator('.group-block').count();
  check(s3, gBlocks === 2, '设备1 显示 2 个分组', 'count=' + gBlocks);
  const headName = await page.locator('.device-head .name').textContent().catch(() => '');
  check(s3, headName === '测试从站', '设备头显示设备名', 'name=' + headName);
  const tabCount = await page.locator('.tab').count();
  check(s3, tabCount === 4, '4 个 Tab', 'count=' + tabCount);
  const regRows = await page.locator('table.reg tbody tr').count();
  check(s3, regRows === 20, '实时表 20 行寄存器', 'rows=' + regRows);
  await page.screenshot({ path: path.join(SHOT, '02-live-device1.png') });

  // 3.2 历史数据
  await page.locator('.tab', { hasText: '历史数据' }).click();
  check(s3, await page.locator('.hist-input').count() === 2, '历史页有起止时间输入', '');
  await page.locator('.toolbar .btn.primary', { hasText: '查询' }).click();
  await page.waitForTimeout(1200);
  const histRows = await page.locator('.hist-table tbody tr').count();
  const histEmpty = await page.locator('.hist-empty').count();
  check(s3, histRows > 0 || histEmpty > 0, '历史查询有响应(表或空态)', 'rows=' + histRows + ' empty=' + histEmpty);
  s3.notes.push('历史查询结果行数=' + histRows);
  await page.screenshot({ path: path.join(SHOT, '03-history.png') });

  // 3.3 曲线
  await page.locator('.tab', { hasText: '曲线' }).click();
  await page.waitForTimeout(1500);
  const svgPaths = await page.locator('.chart-wrap svg path').count();
  check(s3, svgPaths > 0, '曲线渲染 SVG 折线', 'paths=' + svgPaths);
  await page.screenshot({ path: path.join(SHOT, '04-curve.png') });

  // 3.4 固件占位
  await page.locator('.tab', { hasText: '固件' }).click();
  const fw = await page.locator('.firmware-card').textContent().catch(() => '');
  check(s3, fw.includes('规划中') || fw.toLowerCase().includes('planned'), '固件占位提示', 'text=' + fw.trim());

  // 3.5 写寄存器 (设备2 本地模拟器，安全)
  await page.locator('.device-item').nth(1).click();
  await page.waitForSelector('.group-block', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  const firstVal = page.locator('td.value').first();
  await firstVal.dblclick().catch(() => {});
  const writeModal = page.locator('.modal', { hasText: '写寄存器' });
  const writeModalShown = await writeModal.count() > 0;
  check(s3, writeModalShown, '双击值弹出写寄存器弹窗', '');
  if (writeModalShown) {
    const info = await writeModal.textContent();
    s3.notes.push('写弹窗信息: ' + info.replace(/\s+/g, ' ').slice(0, 120));
    await writeModal.locator('input[placeholder]').fill('777');
    await writeModal.locator('.btn.primary', { hasText: '写' }).click();
    await page.waitForTimeout(800);
    const stillOpen = await page.locator('.modal', { hasText: '写寄存器' }).count();
    check(s3, stillOpen === 0, '写值提交后弹窗关闭', '');
  }

  // 3.6 新建设备弹窗 + 取消
  await page.locator('.ws-row-add').click().catch(() => {});
  const devModal = page.locator('.modal', { hasText: '新建设备' });
  const devModalShown = await devModal.count() > 0;
  check(s3, devModalShown, '新建设备弹窗可打开', '');
  if (devModalShown) {
    const inputs = await devModal.locator('input').count();
    check(s3, inputs === 3, '新建设备有 名称/IP/端口 3 个输入', 'inputs=' + inputs);
    await devModal.locator('.btn', { hasText: '取消' }).click();
  }

  // 3.7 新建->删除 全流程(自清理)
  await page.locator('.ws-row-add').click();
  await page.locator('.modal', { hasText: '新建设备' }).locator('input').nth(0).fill('E2E临时设备');
  await page.locator('.modal', { hasText: '新建设备' }).locator('input').nth(1).fill('127.0.0.1');
  await page.locator('.modal', { hasText: '新建设备' }).locator('input').nth(2).fill('8502');
  await page.locator('.modal', { hasText: '新建设备' }).locator('.btn.primary', { hasText: '添加' }).click();
  await page.waitForTimeout(800);
  const nowDevCount = await page.locator('.device-item').count();
  check(s3, nowDevCount === 3, '新建设备后列表变 3 台', 'count=' + nowDevCount);
  // 删除（观察是否有确认弹窗）
  const tmpItem = page.locator('.device-item', { hasText: 'E2E临时设备' });
  let confirmShown = false;
  page.on('dialog', async (d) => { confirmShown = true; await d.dismiss(); });
  await tmpItem.locator('.device-del').click();
  await page.waitForTimeout(600);
  const afterDel = await page.locator('.device-item').count();
  check(s3, afterDel === 2, '删除后恢复 2 台', 'count=' + afterDel);
  s3.notes.push('删除设备是否有确认对话框: ' + (confirmShown ? '有' : '无（直接删除）'));

  // 3.8 设置：主题 + 语言
  await page.locator('.settings-btn').click();
  const setModal = page.locator('.settings-modal');
  check(s3, await setModal.count() > 0, '设置弹窗打开', '');
  await setModal.locator('.seg button', { hasText: '深色' }).click();
  const themeAfterDark = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check(s3, themeAfterDark === 'dark', '切换深色主题生效', 'data-theme=' + themeAfterDark);
  await page.screenshot({ path: path.join(SHOT, '05-dark-theme.png') });
  await setModal.locator('.seg button', { hasText: 'English' }).click();
  const brandSubEn = await page.locator('.brand-sub').textContent().catch(() => '');
  check(s3, brandSubEn.includes('observation'), '切换英文生效', 'brandSub=' + brandSubEn);
  await page.locator('.modal-close').click();
  // 切回中文
  await page.locator('.settings-btn').click();
  await page.locator('.settings-modal .seg button', { hasText: '中文' }).click();
  await page.locator('.modal-close').click();

  // 3.9 工作区弹窗
  await page.locator('.new-workspace-btn').click();
  const wsModal = page.locator('.ws-modal');
  check(s3, await wsModal.count() > 0, '工作区弹窗打开', '');
  const wsDirs = await wsModal.locator('.ws-dir').count();
  s3.notes.push('工作区浏览子目录按钮数=' + wsDirs);
  await wsModal.locator('.modal-close').click();

  await ctx.close();

  // ---------- Section 4: Responsive ----------
  const s4 = addSection('多设备/响应式');
  const viewports = [
    { name: 'desktop', w: 1440, h: 900 },
    { name: 'tablet', w: 768, h: 1024 },
    { name: 'mobile', w: 375, h: 812 },
  ];
  for (const vp of viewports) {
    const c2 = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const p2 = await c2.newPage();
    await p2.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await p2.waitForSelector('.device-item', { timeout: 10000 }).catch(() => {});
    await p2.locator('.device-item').first().click().catch(() => {});
    await p2.waitForTimeout(500);
    const overflow = await p2.evaluate(() => {
      const doc = document.documentElement;
      const hOverflow = doc.scrollWidth > doc.clientWidth;
      const main = document.querySelector('main.main');
      const tableOverflow = main ? main.scrollWidth > main.clientWidth : false;
      return { hOverflow, tableOverflow, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
    });
    check(s4, !overflow.hOverflow, vp.name + ' 无横向溢出', JSON.stringify(overflow));
    await p2.screenshot({ path: path.join(SHOT, '06-' + vp.name + '.png'), fullPage: false });
    s4.notes.push(vp.name + ' 视口 ' + vp.w + 'x' + vp.h + ' scrollW=' + overflow.scrollWidth + ' clientW=' + overflow.clientWidth + ' tableOverflow=' + overflow.tableOverflow);
    await c2.close();
  }

  // ---------- Section 5: Performance ----------
  const s5 = addSection('性能/加载时间');
  const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p3 = await c3.newPage();
  let nav = null;
  try {
    await p3.goto(BASE, { waitUntil: 'load', timeout: 30000 });
    nav = await p3.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      const res = performance.getEntriesByType('resource');
      const byType = {};
      let totalBytes = 0, totalCount = 0;
      for (const r of res) {
        const t = r.initiatorType || 'other';
        byType[t] = byType[t] || { count: 0, bytes: 0 };
        byType[t].count++;
        byType[t].bytes += r.transferSize || 0;
        totalBytes += r.transferSize || 0;
        totalCount++;
      }
      return {
        ttfb: n ? Math.round(n.responseStart - n.requestStart) : -1,
        domContentLoaded: n ? Math.round(n.domContentLoadedEventEnd - n.requestStart) : -1,
        loadEvent: n ? Math.round(n.loadEventEnd - n.requestStart) : -1,
        resourceCount: totalCount,
        resourceBytes: totalBytes,
        byType,
      };
    });
  } catch (e) { s5.issues.push('性能采集失败: ' + e.message); }
  if (nav) {
    s5.notes.push('TTFB=' + nav.ttfb + 'ms, DOMContentLoaded=' + nav.domContentLoaded + 'ms, load=' + nav.loadEvent + 'ms');
    s5.notes.push('资源数=' + nav.resourceCount + ', 传输体积≈' + (nav.resourceBytes / 1024).toFixed(1) + 'KB');
    s5.notes.push('资源分类: ' + JSON.stringify(nav.byType));
    check(s5, nav.ttfb >= 0 && nav.ttfb < 1000, 'TTFB < 1s', 'ttfb=' + nav.ttfb + 'ms');
  }
  await c3.close();

  await browser.close();
}

run().then(() => {
  const out = {
    generatedAt: new Date().toISOString(),
    consoleErrorCount: consoleMsgs.filter((m) => m.type === 'error').length,
    consoleWarningCount: consoleMsgs.filter((m) => m.type === 'warning').length,
    pageErrorCount: pageErrors.length,
    failedRequestCount: failedRequests.length,
    badResponseCount: badResponses.length,
    consoleWarnings: consoleMsgs.filter((m) => m.type === 'warning').map((m) => m.text.slice(0, 200)),
    consoleErrors: consoleMsgs.filter((m) => m.type === 'error').map((m) => m.text.slice(0, 300)),
    pageErrors,
    failedRequests,
    badResponses,
    sections: results.sections,
  };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('=== SUMMARY ===');
  for (const s of results.sections) {
    const pass = s.checks.filter((c) => c.ok).length;
    const fail = s.checks.filter((c) => !c.ok).length;
    console.log(`[${s.name}] ${pass} pass / ${fail} fail`);
    for (const c of s.checks.filter((c) => !c.ok)) console.log('  FAIL: ' + c.label + ' | ' + c.detail);
    for (const c of s.checks.filter((c) => c.ok)) console.log('  ok: ' + c.label + ' | ' + c.detail);
  }
  console.log('console.error=' + out.consoleErrorCount + ' warn=' + out.consoleWarningCount + ' pageerror=' + out.pageErrorCount + ' failedReq=' + out.failedRequestCount + ' badResp=' + out.badResponseCount);
  console.log('DONE artifacts=' + OUT);
}).catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
