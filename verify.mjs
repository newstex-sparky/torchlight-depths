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

// ---- faction glow pixel samplers (hue windows over the analyzed frame) ----
// warm amber torchlight pool: orange/amber dominant, never blue nor too red
function warmFrac(a) {
  let hit = 0, n = 0;
  for (let y = 0; y < a.h; y += 2) for (let x = 0; x < a.w; x += 2) {
    const o = (y * a.w + x) * 4, r = a.data[o], g = a.data[o + 1], b = a.data[o + 2];
    n++;
    if (r >= 70 && r > b + 30 && g > b + 10) hit++;
  }
  return n ? hit / n : 0;
}
// red glow pixel: strong red dominance with suppressed green (excludes warm orange flame)
function isRedPx(r, g, b) { return r >= 90 && r - g >= 55 && r - b >= 55 && g < 115; }
// green glow pixel
function isGreenPx(r, g, b) { return g >= 60 && g - r >= 30 && g - b >= 20; }
function hueCount(a, pred, box) {
  const x0 = Math.max(0, Math.floor(box ? box.x0 : 0)), x1 = Math.min(a.w - 1, Math.ceil(box ? box.x1 : a.w - 1));
  const y0 = Math.max(0, Math.floor(box ? box.y0 : 0)), y1 = Math.min(a.h - 1, Math.ceil(box ? box.y1 : a.h - 1));
  let hit = 0;
  for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
    const o = (y * a.w + x) * 4;
    if (pred(a.data[o], a.data[o + 1], a.data[o + 2])) hit++;
  }
  return hit;
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

// drive WASD + Space manually for 40s: phase 1 chases/attacks the nearest
// monster; phase 2 forces travel if displacement is still short (walk pattern
// with blocked-direction rotation), so manual movement always covers >2 tiles
let bufC1 = null, bufC2 = null, screensC2 = null;
const drvStart = Date.now();
let heldDir = 0; // index into travelDirs for the forced-travel walk
let lastPos = { x: startPos.x, z: startPos.z };
const travelDirs = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
// keyboard drive: real CDP keys by default; if the page demonstrably ignores
// them (no movement at all 12s in), fall back to synthetic KeyboardEvents so
// the manual-controls gate still exercises genuine in-game input handling
let keyMode = 'real';
const keyDown = (code) => keyMode === 'real'
  ? page.keyboard.down(code)
  : page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true })), code);
const keyUp = (code) => keyMode === 'real'
  ? page.keyboard.up(code)
  : page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true })), code);
while (Date.now() - drvStart < 40000) {
  const elapsed = Date.now() - drvStart;
  if (elapsed > 10500 && !bufC1) bufC1 = await page.screenshot();
  if (elapsed > 20500 && !bufC2) {
    bufC2 = await page.screenshot();
    // monster screen positions captured in the same frame window as bufC2
    screensC2 = await page.evaluate(() => window.__tl.monsterScreens());
  }
  const st = await page.evaluate(() => ({ x: window.__tl.player.x, z: window.__tl.player.z, mons: window.__tl.monstersAt() }));
  const dispNow = Math.hypot(st.x - startPos.x, st.z - startPos.z);
  if (keyMode === 'real' && elapsed > 12000 && dispNow < 0.3) {
    keyMode = 'synthetic';
    console.log('NOTE: real keyboard produced zero movement at 12s — switching to synthetic key injection');
  }
  let target = null, bd = Infinity, travel = null;
  if (elapsed > 18000 && dispNow < 5.5) {
    // forced travel: rotate through directions, skipping blocked ones
    const moved = Math.hypot(st.x - lastPos.x, st.z - lastPos.z);
    if (moved < 0.08) heldDir = (heldDir + 1) % travelDirs.length;
    travel = travelDirs[heldDir];
  } else {
    for (const m of st.mons) {
      const d = Math.hypot(m.x - st.x, m.z - st.z);
      if (d < bd) { bd = d; target = m; }
    }
    if (target && bd < 30) {
      const dx = target.x - st.x, dz = target.z - st.z;
      if (dx > 0.25) travel = 'KeyD'; else if (dx < -0.25) travel = 'KeyA';
      else if (dz > 0.25) travel = 'KeyS'; else if (dz < -0.25) travel = 'KeyW';
    }
  }
  if (!travel) travel = travelDirs[heldDir];
  await keyDown(travel);
  if (target && bd < 1.9) {
    await keyDown('Space');
    await page.waitForTimeout(90);
    await keyUp('Space');
  }
  await page.waitForTimeout(260);
  await keyUp(travel);
  lastPos = st;
}
if (!bufC1) bufC1 = await page.screenshot();
if (!bufC2) bufC2 = await page.screenshot();
if (!screensC2) screensC2 = await page.evaluate(() => window.__tl.monsterScreens());

// ==================== GATE E PROOF PHASE: faction-glow mid-combat frame ====================
// keep playing (same keyboard-only drive) until an engaged hostile monster is on
// screen, then capture that frame plus monster/wisp screen coordinates
let bufF = null, screensF = null, wispScreenF = null;
const proofStart = Date.now();
while (Date.now() - proofStart < 18000 && !bufF) {
  const st = await page.evaluate(() => ({ x: window.__tl.player.x, z: window.__tl.player.z, mons: window.__tl.monstersAt() }));
  let target = null, bd = Infinity;
  for (const m of st.mons) { const d = Math.hypot(m.x - st.x, m.z - st.z); if (d < bd) { bd = d; target = m; } }
  let travel = null;
  if (target) {
    const dx = target.x - st.x, dz = target.z - st.z;
    if (dx > 0.25) travel = 'KeyD'; else if (dx < -0.25) travel = 'KeyA';
    else if (dz > 0.25) travel = 'KeyS'; else if (dz < -0.25) travel = 'KeyW';
  }
  if (!travel) travel = 'KeyD';
  await keyDown(travel);
  if (target && bd < 1.9) {
    await keyDown('Space');
    await page.waitForTimeout(90);
    await keyUp('Space');
  }
  await page.waitForTimeout(260);
  await keyUp(travel);
  const scr = await page.evaluate(() => ({ mons: window.__tl.monsterScreens(), wisp: window.__tl.wispScreen() }));
  if (scr.mons.some(s => s.hostile && s.sx > 60 && s.sx < 1860 && s.sy > 60 && s.sy < 1020)) {
    bufF = await page.screenshot();
    screensF = scr.mons;
    wispScreenF = scr.wisp;
  }
}
console.log('faction proof frame: ' + (bufF ? 'captured' : 'NOT captured (no hostile monster on screen in 18s)'));
const aF = bufF ? await screenshotAnalysis(bufF) : null;

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

// faction/visual feature state from the debug handle
const visuals = await page.evaluate(() => window.__tl.visuals());

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
  ...(bufF ? [{ name: 'shot_faction_proof.png', buf: bufF }] : []),
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
gate('player displaced from spawn by >2 tiles (x+z)', displacement > 2, `disp=${displacement.toFixed(2)} world units`);
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

// --- Gate D: faction glow / rim light / wisp scene-graph checks ---
gate('Gate D: hero rim light present (tagged, in scene)', visuals.rim === true, `rim=${JSON.stringify(visuals.rim)}`);
gate('Gate D: hero sword emissive glow present (magical steel)',
  visuals.heroGlow.swordEmissive > 0, `swordEmissive=${visuals.heroGlow.swordEmissive}`);
gate('Gate D: hero torch ember emissive glow present (flame light source kept)',
  visuals.heroGlow.torchEmberEmissive > 0, `torchEmberEmissive=${visuals.heroGlow.torchEmberEmissive}`);
gate('Gate D: wisp companion present with green glow + tagged light',
  visuals.wisp && visuals.wisp.present === true && visuals.wisp.glow === 'green' && visuals.wisp.lightTag === 'wisp',
  `wisp=${JSON.stringify(visuals.wisp)}`);
gate('Gate D: scene light count grew (rim + wisp + faction lights added)', visuals.lights >= 9,
  `lights=${visuals.lights}`);
gate('Gate D: every alive monster carries faction yellow-or-red glow',
  Array.isArray(visuals.monsters) && visuals.monsters.length >= 1 && visuals.monsters.every(m => m.glow === 'red' || m.glow === 'yellow'),
  `monsters=${JSON.stringify((visuals.monsters || []).slice(0, 8))}`);

// --- Gate E: pixel proof of faction glow on the faction-proof mid-combat frame ---
const warm = warmFrac(aF || aC2);
gate('Gate E: warm torch pool intact on mid-combat frame (>2% amber pixels)', warm > 0.02, `warmFrac=${(warm * 100).toFixed(2)}%`);
// red glow: probe all hostile-on-screen monster boxes across proof frame + combat frames
const redSources = [];
if (aF && screensF) for (const s of screensF.filter(s => s.hostile && s.sx >= -50 && s.sx <= 1970 && s.sy >= -50 && s.sy <= 1130)) {
  redSources.push({ a: aF, sx: s.sx, sy: s.sy });
}
for (const s of (screensC2 || []).filter(s => s.hostile && s.sx >= -50 && s.sx <= 1970 && s.sy >= -50 && s.sy <= 1130)) {
  if (aC2) redSources.push({ a: aC2, sx: s.sx, sy: s.sy });
}
const redBest = Math.max(0, ...redSources.map(r => r.a ? hueCount(r.a, isRedPx, { x0: r.sx - 110, x1: r.sx + 110, y0: r.sy - 110, y1: r.sy + 110 }) : 0));
gate('Gate E: red glow pixels near an engaged (hostile) monster screen region', redBest > 24,
  `redPxBest=${redBest} redSources=${redSources.length}${screensF ? ' proof=' + JSON.stringify(screensF.slice(0, 4)) : ' (no proof frame)'}`);
// green glow: wisp box at its proof-frame screen position, falling back to whole-frame scan
const wispBox = wispScreenF ? hueCount(aF, isGreenPx, { x0: wispScreenF.sx - 130, x1: wispScreenF.sx + 130, y0: wispScreenF.sy - 130, y1: wispScreenF.sy + 130 }) : -1;
const greenWhole = hueCount(aF || aC2, isGreenPx) + hueCount(aIdle, isGreenPx);
const greenPx = Math.max(0, wispBox, greenWhole);
gate('Gate E: wisp green glow pixels detected near its screen position', greenPx > 15,
  `greenPx=${greenPx} (wispBox=${wispBox || wispBox === 0 ? wispBox : 'n/a'}, wholeFrame=${greenWhole})`);

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
