import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_DIR = path.join(HERE, 'verify');
mkdirSync(VERIFY_DIR, { recursive: true });

// Start HTTP server for index.html
const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    createReadStream(path.join(HERE, 'index.html')).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`HTTP server running on port ${port}`);

const BG = { r: 10, g: 11, b: 16 };    // scene background rgb(10,11,16)
const failureMsgs = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => pageErrors.push(String(err)));

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });

// Game must expose its debug handle at boot
await page.waitForFunction(() => window.__tl && window.__tl.ready === true, null, { timeout: 15000 });
console.log('window.__tl ready at boot: YES');
const bootSpawn = await page.evaluate(() => ({ monsters: window.__tl.monsters(), depth: window.__tl.depth() }));
console.log('monsters on initial level at boot:', bootSpawn.monsters);

/**
 * Decode a PNG screenshot buffer inside the page and return { diffPct, pixels }:
 *  - diffPct: percent of pixels differing from rgb(10,11,16) by >8 on any channel
 *  - pixels: Uint8ClampedArray RGBA (downsampled is NOT used, full frame)
 */
async function screenshotAnalysis(buf) {
  return await page.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    return { w: img.width, h: img.height, data: Array.from(data) };
  }, 'data:image/png;base64,' + buf.toString('base64'));
}

function pctDiffBackground(a) {
  let diff = 0;
  const n = a.w * a.h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dr = Math.abs(a.data[o] - BG.r), dg = Math.abs(a.data[o + 1] - BG.g), db = Math.abs(a.data[o + 2] - BG.b);
    if (dr > 8 || dg > 8 || db > 8) diff++;
  }
  return diff / n;
}
function pctDiffFrames(a, b) {
  let diff = 0;
  const n = Math.min(a.w * a.h, b.w * b.h);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dr = Math.abs(a.data[o] - b.data[o]), dg = Math.abs(a.data[o + 1] - b.data[o + 1]), db = Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (dr > 8 || dg > 8 || db > 8) diff++;
  }
  return diff / n;
}

const t0 = Date.now();
// shot 1 at ~10s
while (Date.now() - t0 < 10000) await page.waitForTimeout(500);
const buf1 = await page.screenshot();
const a1 = await screenshotAnalysis(buf1);
const bg1 = pctDiffBackground(a1);

// shot 2 at ~20s
while (Date.now() - t0 < 20000) await page.waitForTimeout(500);
const buf2 = await page.screenshot();
const a2 = await screenshotAnalysis(buf2);
const bg2 = pctDiffBackground(a2);
const frameDiff12 = pctDiffFrames(a1, a2);

// 30s of live play -> gameplay gate
while (Date.now() - t0 < 30000) await page.waitForTimeout(500);
const buf3 = await page.screenshot();
const a3 = await screenshotAnalysis(buf3);
const bg3 = pctDiffBackground(a3);
const gameStats = await page.evaluate(() => ({
  monsters: window.__tl.monsters(),
  slain: window.__tl.slain(),
  gold: window.__tl.gold(),
  hp: window.__tl.hp(),
  maxHp: 5,
  depth: window.__tl.depth(),
  px: window.__tl.player.x,
  pz: window.__tl.player.z,
}));
const playerMoveDist = Math.abs(gameStats.px) + Math.abs(gameStats.pz);

// HUD must read 'Monsters slain: N' exactly once (no duplicated label)
const hudCheck = await page.evaluate(() => {
  const hud = document.getElementById('hud');
  const html = hud ? hud.innerHTML : '';
  const count = (html.match(/Monsters slain:/g) || []).length;
  const rowMatch = (hud ? hud.innerText : '').match(/Monsters slain:\s*(\d+)/);
  return { occurrences: count, value: rowMatch ? Number(rowMatch[1]) : null };
});

// run to a full 60s error-collection window before closing
while (Date.now() - t0 < 60000) await page.waitForTimeout(500);

const md5 = (b) => createHash('md5').update(b).digest('hex');
const shots = [
  { name: 'shot_10s.png', buf: buf1 },
  { name: 'shot_20s.png', buf: buf2 },
  { name: 'shot_30s.png', buf: buf3 },
];
// clear stale screenshots so verify/ always reflects this run
for (const f of ['01_init.png', '02_combat.png', 'shot_10s.png', 'shot_20s.png', 'shot_30s.png']) {
  try { rmSync(path.join(VERIFY_DIR, f)); } catch (e) { /* absent */ }
}
const md5s = {};
for (const s of shots) {
  writeFileSync(path.join(VERIFY_DIR, s.name), s.buf);
  md5s[s.name] = md5(s.buf);
}

await browser.close();
server.close();

// ==================== REGRESSION GATES ====================
const checks = [];
const gate = (name, pass, detail) => { checks.push({ name, pass, detail }); if (!pass) failureMsgs.push(`${name}: ${detail}`); };

gate('debug handle boot with >=3 monsters on initial level', bootSpawn.monsters >= 3, `monsters=${bootSpawn.monsters}`);
gate('canvas pixels differ from background >5% at t=10s', bg1 > 0.05, `pct=${(bg1 * 100).toFixed(2)}%`);
gate('canvas pixels differ from background >5% at t=20s', bg2 > 0.05, `pct=${(bg2 * 100).toFixed(2)}%`);
gate('screenshots 10s vs 20s differ from each other >0.3%', frameDiff12 > 0.003, `pct=${(frameDiff12 * 100).toFixed(3)}%`);
gate('canvas pixels differ from background >5% at t=30s', bg3 > 0.05, `pct=${(bg3 * 100).toFixed(2)}%`);
gate('monsters() >= 3 after 30s of live play', gameStats.monsters >= 3, `monsters=${gameStats.monsters}`);
gate('combat engagement: slain>=1 OR gold>0 OR hp<max', gameStats.slain >= 1 || gameStats.gold > 0 || gameStats.hp < gameStats.maxHp,
  `slain=${gameStats.slain} gold=${gameStats.gold} hp=${gameStats.hp}/${gameStats.maxHp}`);
gate('player moved from (0,0) by >2 tiles (x+z)', playerMoveDist > 2, `dx+dz=${playerMoveDist.toFixed(2)} (x=${gameStats.px.toFixed(2)} z=${gameStats.pz.toFixed(2)})`);
gate('zero console errors over 60s', consoleErrors.length === 0, `errors=${consoleErrors.length}${consoleErrors.length ? ' :: ' + consoleErrors.slice(0, 3).join(' | ') : ''}`);
gate('zero page errors over 60s', pageErrors.length === 0, `errors=${pageErrors.length}${pageErrors.length ? ' :: ' + pageErrors.slice(0, 3).join(' | ') : ''}`);
gate("HUD reads 'Monsters slain: N' exactly once", hudCheck.occurrences === 1 && hudCheck.value !== null,
  `occurrences=${hudCheck.occurrences} value=${hudCheck.value}`);
const distinctMd5s = new Set(Object.values(md5s));
gate('2-3 screenshots saved and distinct by md5', Object.keys(md5s).length >= 2 && distinctMd5s.size === Object.keys(md5s).length,
  `md5s=${JSON.stringify(md5s)}`);

console.log('\n=== VERIFICATION SUMMARY ===');
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`);
const allPass = checks.every(c => c.pass);
console.log('\nAll gates passed:', allPass);
console.log('\nScreenshot md5s:');
for (const [name, h] of Object.entries(md5s)) console.log(`  ${name}: ${h}`);

process.exit(allPass ? 0 : 1);
