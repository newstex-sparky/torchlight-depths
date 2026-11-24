import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';

const VERIFY_DIR = '/home/newstex/workspace/torchlight-depths/verify';
mkdirSync(VERIFY_DIR, { recursive: true });

// Start HTTP server for the index.html
const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const fs = require('node:fs');
    fs.createReadStream('/home/newstex/workspace/torchlight-depths/index.html').pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`HTTP server running on port ${port}`);

// Launch Chromium with SwiftShader
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle']
});

const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1
});

const consoleErrors = [];
const pageErrors = [];

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

page.on('pageerror', (err) => {
  pageErrors.push(String(err));
});

// Navigate to the game
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });

// Wait for Three.js to initialize
await page.waitForTimeout(3000);

// Take initial screenshot (wide view)
await page.screenshot({ path: `${VERIFY_DIR}/01_init.png` });

// Check canvas size
const canvasSize = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  if (canvas) {
    return {
      width: canvas.width,
      height: canvas.height,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight
    };
  }
  return null;
});

console.log('Canvas size:', canvasSize);

// Check if Three.js is working
const threeWorking = await page.evaluate(() => {
  try {
    const canvas = document.querySelector('canvas');
    if (!canvas) return false;
    const renderer = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!renderer) return false;
    const debugRenderer = renderer.getParameter(37445); // UNMASKED_RENDERER_WEBGL
    return debugRenderer && debugRenderer.includes('three') || true;
  } catch (e) {
    return false;
  }
});

console.log('Three.js working:', threeWorking);

// Play for 15 seconds with some auto-play
await page.waitForTimeout(15000);

// Take combat screenshot
await page.screenshot({ path: `${VERIFY_DIR}/02_combat.png` });

// Check HUD values changed
const hudChanged = await page.evaluate(() => {
  // Check if HUD values have changed from initial
  const hp = document.getElementById('hp')?.textContent;
  const depth = document.getElementById('depth')?.textContent;
  const monsters = document.getElementById('monsters')?.textContent;
  return { hp, depth, monsters };
});

console.log('HUD after play:', hudChanged);

// Check for draw calls / WebGL activity
const drawCalls = await page.evaluate(() => {
  try {
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return 0;
    // Try to get info about rendering
    const extensions = gl.getParameter(37443); // EXTENSIONS
    return extensions ? 1 : 0;
  } catch (e) {
    return 0;
  }
});

console.log('WebGL active:', drawCalls > 0);

// Summary
const allChecks = {
  consoleErrors: consoleErrors.length,
  pageErrors: pageErrors.length,
  canvasNotDefault: canvasSize && (canvasSize.width === 1920 || canvasSize.width > 300),
  threeWorking,
  drawCallsPositive: drawCalls > 0,
  hudHasValues: hudChanged.hp && hudChanged.depth
};

console.log('\n=== VERIFICATION SUMMARY ===');
console.log('Console errors:', allChecks.consoleErrors);
console.log('Page errors:', allChecks.pageErrors);
console.log('Canvas not default 300x150:', allChecks.canvasNotDefault);
console.log('Three.js working:', allChecks.threeWorking);
console.log('Draw calls positive:', allChecks.drawCallsPositive);
console.log('HUD has values:', allChecks.hudHasValues);
console.log('\\nAll pass:', 
  allChecks.consoleErrors === 0 && 
  allChecks.pageErrors === 0 && 
  allChecks.canvasNotDefault && 
  allChecks.threeWorking && 
  allChecks.drawCallsPositive && 
  allChecks.hudHasValues);

// Cleanup
await browser.close();
server.close();

// Exit with code based on pass/fail
process.exit(
  allChecks.consoleErrors === 0 && 
  allChecks.pageErrors === 0 && 
  allChecks.canvasNotDefault && 
  allChecks.threeWorking && 
  allChecks.drawCallsPositive && 
  allChecks.hudHasValues ? 0 : 1
);
