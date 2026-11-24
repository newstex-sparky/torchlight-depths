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
const TILE = 2.0;                       // world units per dungeon tile
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
 * Decode a PNG screenshot buffer inside the page and return pixel data.
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
// fraction of horizontally-adjacent pixel pairs that differ by a small amount
// (1-5 LSB) — flat frames without Bayer dither / grain are ~0, with them >2%
function fineNoiseFrac(a) {
  let pairs = 0, hit = 0;
  const rowStart = Math.floor(a.h * 0.5), rowEnd = Math.floor(a.h * 0.92);
  for (let y = rowStart; y < rowEnd; y += 2) {
    for (let x = 1; x < a.w; x += 2) {
      const o = (y * a.w + x) * 4, ol = o - 4;
      const d = Math.max(
        Math.abs(a.data[o] - a.data[ol]),
        Math.abs(a.data[o + 1] - a.data[ol + 1]),
        Math.abs(a.data[o + 2] - a.data[ol + 2]));
      pairs++;
      if (d >= 1 && d <= 5) hit++;
    }
  }
  return pairs ? hit / pairs : 0;
}

const t0 = Date.now();

// ==================== GATE A: IDLE PHASE (no start interaction) ====================
await page.waitForTimeout(1500); // let the module settle

const snapState = () => page.evaluate(() => ({
  px: window.__tl.player.x, pz: window.__tl.player.z,
  monsters: window.__tl.monsters(), slain: window.__tl.slain(),
  gold: window.__tl.gold(), hp: window.__tl.hp(), depth: window.__tl.depth(),
  started: window.__tl.gameStarted(),
  overlayVisible: (() => {
    const el = document.getElementById('startOverlay');
    return !!(el && el.style.display !== 'none' && getComputedStyle(el).display !== 'none');
  })(),
}));
const A1 = await snapState();
console.log('idle snapshot A1:', JSON.stringify(A1));

// wait to t=12s WITHOUT any interaction
while (Date.now() - t0 < 12000) await page.waitForTimeout(250);
const A2 = await snapState();
console.log('idle snapshot A2:', JSON.stringify(A2));

const bufIdle = await page.screenshot();
const aIdle = await screenshotAnalysis(bufIdle);
const bgIdle = pctDiffBackground(aIdle);

// ==================== GATE B: START + MANUAL GAMEPLAY ====================
await page.click('#startOverlay'); // ONE click starts gameplay (and audio)
await page.waitForTimeout(500);
const started = await page.evaluate(() => ({
  started: window.__tl.gameStarted(),
  overlayGone: (() => {
    const el = document.getElementById('startOverlay');
    const cs = getComputedStyle(el);
    return el.style.display === 'none' || cs.display === 'none';
  })(),
}));
const startPos = { x: A2.px, z: A2.pz };
console.log('after click: started=' + started.started + ' overlayGone=' + started.overlayGone);

// drive WASD + Space manually for 28s: chase the nearest monster, attack in range
let bufC1 = null, bufC2 = null;
const drvStart = Date.now();
while (Date.now() - drvStart < 28000) {
  const elapsed = Date.now() - drvStart;
  if (elapsed > 10500 && !bufC1) bufC1 = await page.screenshot();
  if (elapsed > 20500 && !bufC2) bufC2 = await page.screenshot();
  const st = await page.evaluate(() => ({ x: window.__tl.player.x, z: window.__tl.player.z, mons: window.__tl.monstersAt() }));
  let target = null, bd = Infinity;
  for (const m of st.mons) {
    const d = Math.hypot(m.x - st.x, m.z - st.z);
    if (d < bd) { bd = d; target = m; }
  }
  const held = [];
  if (target && bd < 30) {
    const dx = target.x - st.x, dz = target.z - st.z;
    if (dx > 0.25) held.push('KeyD'); else if (dx < -0.25) held.push('KeyA');
    if (dz > 0.25) held.push('KeyS'); else if (dz < -0.25) held.push('KeyW');
  }
  if (!held.length) held.push('KeyW');
  for (const k of held) await page.keyboard.down(k);
  if (target && bd < 1.9) {
    await page.keyboard.down('Space');
    await page.waitForTimeout(90);
    await page.keyboard.up('Space');
  }
  await page.waitForTimeout(260);
  for (const k of held) await page.keyboard.up(k);
}
if (!bufC1) bufC1 = await page.screenshot();
if (!bufC2) bufC2 = await page.screenshot();

const aC1 = await screenshotAnalysis(bufC1);
const bgC1 = pctDiffBackground(aC1);
const aC2 = await screenshotAnalysis(bufC2);
const bgC2 = pctDiffBackground(aC2);
const frameDiffIdleC1 = pctDiffFrames(aIdle, aC1);

const endPos = await page.evaluate(() => ({ x: window.__tl.player.x, z: window.__tl.player.z }));
const displacement = Math.hypot(endPos.x - startPos.x, endPos.z - startPos.z);

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

// post-processing chain must remain intact
const postState = await page.evaluate(() => (window.__tl.post ? { ...window.__tl.post } : null));

// HUD must read 'Monsters slain: N' exactly once (no duplicated label)
const hudCheck = await page.evaluate(() => {
  const hud = document.getElementById('hud');
  const html = hud ? hud.innerHTML : '';
  const count = (html.match(/Monsters slain:/g) || []).length;
  const rowMatch = (hud ? hud.innerText : '').match(/Monsters slain:\s*(\d+)/);
  return { occurrences: count, value: rowMatch ? Number(rowMatch[1]) : null };
});

// run to a full 60s error-collection window (spans idle + started phases)
while (Date.now() - t0 < 62000) await page.waitForTimeout(500);

const md5 = (b) => createHash('md5').update(b).digest('hex');
const shots = [
  { name: 'shot_idle.png', buf: bufIdle },
  { name: 'shot_combat1.png', buf: bufC1 },
  { name: 'shot_combat2.png', buf: bufC2 },
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

const noiseFrac = fineNoiseFrac(aC1);
console.log(`fine 1-5 LSB adjacent-pixel noise fraction (combat frame): ${(noiseFrac * 100).toFixed(2)}%`);

// ==================== REGRESSION GATES ====================
const checks = [];
const gate = (name, pass, detail) => { checks.push({ name, pass, detail }); if (!pass) failureMsgs.push(`${name}: ${detail}`); };

// --- original suite (kept) ---
gate('debug handle boot with >=3 monsters on initial level', bootSpawn.monsters >= 3, `monsters=${bootSpawn.monsters}`);
gate('canvas pixels differ from background >5% (idle title frame)', bgIdle > 0.05, `pct=${(bgIdle * 100).toFixed(2)}%`);
gate('canvas pixels differ from background >5% (combat frame 1)', bgC1 > 0.05, `pct=${(bgC1 * 100).toFixed(2)}%`);
gate('idle title vs combat frames differ from each other >0.3%', frameDiffIdleC1 > 0.003, `pct=${(frameDiffIdleC1 * 100).toFixed(3)}%`);
gate('canvas pixels differ from background >5% (combat frame 2)', bgC2 > 0.05, `pct=${(bgC2 * 100).toFixed(2)}%`);
gate('monsters() >= 3 after live play', gameStats.monsters >= 3, `monsters=${gameStats.monsters}`);
gate('combat engagement: slain>=1 OR gold>0 OR hp<max', gameStats.slain >= 1 || gameStats.gold > 0 || gameStats.hp < gameStats.maxHp,
  `slain=${gameStats.slain} gold=${gameStats.gold} hp=${gameStats.hp}/${gameStats.maxHp}`);
gate('player moved from (0,0) by >2 tiles (x+z)', playerMoveDist > 2, `dx+dz=${playerMoveDist.toFixed(2)} (x=${gameStats.px.toFixed(2)} z=${gameStats.pz.toFixed(2)})`);
gate('zero console errors over 60s', consoleErrors.length === 0, `errors=${consoleErrors.length}${consoleErrors.length ? ' :: ' + consoleErrors.slice(0, 3).join(' | ') : ''}`);
gate('zero page errors over 60s', pageErrors.length === 0, `errors=${pageErrors.length}${pageErrors.length ? ' :: ' + pageErrors.slice(0, 3).join(' | ') : ''}`);
gate("HUD reads 'Monsters slain: N' exactly once", hudCheck.occurrences === 1 && hudCheck.value !== null,
  `occurrences=${hudCheck.occurrences} value=${hudCheck.value}`);
const distinctMd5s = new Set(Object.values(md5s));
gate('3 screenshots saved and distinct by md5', Object.keys(md5s).length >= 2 && distinctMd5s.size === Object.keys(md5s).length,
  `count=${Object.keys(md5s).length} distinct=${distinctMd5s.size}`);

// --- Gate A: idle world, no AI, no self-play ---
gate('Gate A: title overlay visible at boot and world not started', A1.overlayVisible && !A1.started,
  `overlay=${A1.overlayVisible} started=${A1.started}`);
gate('Gate A: idle 12s — player position static', Math.hypot(A2.px - A1.px, A2.pz - A1.pz) < 0.01,
  `dr=${Math.hypot(A2.px - A1.px, A2.pz - A1.pz).toFixed(5)} (A1 ${A1.px.toFixed(3)},${A1.pz.toFixed(3)} -> A2 ${A2.px.toFixed(3)},${A2.pz.toFixed(3)})`);
gate('Gate A: idle 12s — monsters untouched (count static, zero slain)', A1.monsters === A2.monsters && A2.slain === 0,
  `monsters ${A1.monsters} -> ${A2.monsters}, slain=${A2.slain}`);
gate('Gate A: idle 12s — HUD gold/hp/depth unchanged', A1.gold === A2.gold && A1.hp === A2.hp && A1.depth === A2.depth,
  `gold ${A1.gold}->${A2.gold} hp ${A1.hp}->${A2.hp} depth ${A1.depth}->${A2.depth}`);

// --- Gate B: start + manual combat ---
gate('Gate B: first click starts game (overlay hidden, gameStarted)', started.started && started.overlayGone,
  `started=${started.started} overlayGone=${started.overlayGone}`);
gate('Gate B: WASD moved player >2 tiles driven from __tl', displacement > 2 * TILE,
  `disp=${displacement.toFixed(2)} world units (> ${(2 * TILE).toFixed(0)})`);
gate('Gate B: Space attacks land (slain >= 1)', gameStats.slain >= 1, `slain=${gameStats.slain}`);
gate('Gate B: monsters alive >= 3 after combat', gameStats.monsters >= 3, `monsters=${gameStats.monsters}`);

// --- Gate C: visuals / post chain ---
gate('Gate C: post chain intact (rtScale=0.5, Bayer dither, tilt-shift)', !!postState && postState.rtScale === 0.5 && postState.tiltShift === true && postState.ditherAmp > 0,
  `post=${JSON.stringify(postState)}`);
gate('Gate C: fine dither/grain noise visible in combat frame (>2%)', noiseFrac > 0.02, `frac=${(noiseFrac * 100).toFixed(2)}%`);

console.log('\n=== VERIFICATION SUMMARY ===');
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`);
const allPass = checks.every(c => c.pass);
console.log('\nAll gates passed:', allPass);
if (failureMsgs.length) {
  console.log('\nFailures:');
  for (const f of failureMsgs) console.log('  - ' + f);
}
console.log('\nScreenshot md5s:');
for (const [name, h] of Object.entries(md5s)) console.log(`  ${name}: ${h}`);

process.exit(allPass ? 0 : 1);
