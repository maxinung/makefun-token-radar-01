const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function takeScreenshots() {
  const outDir = path.join(__dirname, 'out');
  const screenshotsDir = path.join(outDir, 'screenshots');
  const dashboardDir = path.join(outDir, 'dashboard');

  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });

  const indexPath = path.join(dashboardDir, 'index.html');
  const fileUrl = 'file://' + indexPath;
  await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 30000 });

  await page.waitForFunction(() => window.RADAR && document.getElementById('board').textContent.length > 100);
  await page.waitForTimeout(1000);

  // 1. Board view - clip to viewport size
  await page.screenshot({
    path: path.join(screenshotsDir, '1-board.png'),
    clip: { x: 0, y: 0, width: 1280, height: 800 },
    type: 'png',
  });
  console.log('Saved 1-board.png');

  // 2. Detail view - click on first row
  await page.click('tbody tr:first-child');
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(screenshotsDir, '2-detail.png'),
    clip: { x: 0, y: 0, width: 1280, height: 800 },
    type: 'png',
  });
  console.log('Saved 2-detail.png');

  // Close detail
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 3. Filtered view - search for "Risk Curators"
  const searchInput = await page.$('#q');
  await searchInput.fill('Risk Curators');
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(screenshotsDir, '3-filtered.png'),
    clip: { x: 0, y: 0, width: 1280, height: 800 },
    type: 'png',
  });
  console.log('Saved 3-filtered.png');

  await browser.close();
  console.log('All screenshots captured!');
}

takeScreenshots().catch(err => {
  console.error(err);
  process.exit(1);
});