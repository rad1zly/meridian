#!/usr/bin/env node
/**
 * Meridian Close Card — HTML to PNG converter
 * Uses Playwright to render HTML template and screenshot it.
 *
 * Usage:
 *   node html-to-image.js <output.png> <json_data>
 *
 * Example:
 *   node html-to-image.js /tmp/card.png '{"pair":"POKÉFIGHT-SOL","pnl_sol":0.0133,"pnl_pct":2.67,...}'
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const TEMPLATE = path.join(__dirname, 'meridian-close-template.html');

async function renderCard(data, outputPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Load HTML template
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  await page.setContent(html, { waitUntil: 'domcontentloaded' });

  // Inject data into the card
  await page.evaluate((d) => {
    // Call the render function defined in the HTML
    if (typeof render === 'function') {
      render(d);
    }
  }, data);

  // Wait a moment for fonts/rendering
  await page.waitForTimeout(300);

  // Screenshot
  await page.screenshot({
    path: outputPath,
    type: 'png',
    timeout: 10000,
  });

  await browser.close();
  console.log('Saved:', outputPath);
}

// CLI entry
if (require.main === module) {
  const outputPath = process.argv[2];
  const jsonData = process.argv[3];

  if (!outputPath || !jsonData) {
    console.error('Usage: node html-to-image.js <output.png> <json_data>');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(jsonData);
  } catch (e) {
    console.error('Invalid JSON:', e.message);
    process.exit(1);
  }

  renderCard(data, outputPath)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = { renderCard };
