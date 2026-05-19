#!/usr/bin/env node
// Renders the three SSAM portal guides to PDF using Playwright's Chromium.
//
// Inputs:   ~/Desktop/SSAM-Demo-Output/pdfs/{member,head,admin}-guide.html
// Outputs:  ~/Desktop/SSAM-Demo-Output/pdfs/{member,head,admin}-guide.pdf
//
// HTML files reference screenshots via `../screenshots/{portal}/...png` so
// the directory layout matters — keep both folders inside SSAM-Demo-Output.
//
// Why Playwright? Chrome's print-to-PDF stack is the same engine but
// Playwright gives us font-loading guarantees (waitForFunction on
// document.fonts.ready) and `printBackground:true` without extra flags.
//
// Run:  node scripts/screenshots/render-pdfs.mjs

import { chromium } from 'playwright';
import { homedir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { stat } from 'fs/promises';

const BASE = join(homedir(), 'Desktop', 'SSAM-Demo-Output', 'pdfs');
const GUIDES = [
  { name: 'member-guide', label: 'Member' },
  { name: 'head-guide',   label: 'Head' },
  { name: 'admin-guide',  label: 'Admin' },
  { name: 'dev-guide',    label: 'Dev' },
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1240, height: 1754 } });

const results = [];
for (const g of GUIDES) {
  const htmlPath = join(BASE, `${g.name}.html`);
  const pdfPath  = join(BASE, `${g.name}.pdf`);
  const fileUrl  = pathToFileURL(htmlPath).href;

  const page = await context.newPage();
  await page.goto(fileUrl, { waitUntil: 'networkidle' });
  // Wait for Almarai (web font) to finish loading before printing —
  // otherwise the first paint can land before glyphs are ready and the
  // PDF embeds the fallback Geeza Pro.
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });
  await page.close();

  const size = (await stat(pdfPath)).size;
  results.push({ label: g.label, pdfPath, size });
  console.log(`✓ ${g.label.padEnd(8)} → ${pdfPath} (${(size / 1024).toFixed(0)} KB)`);
}

await context.close();
await browser.close();

console.log(`\nDone. ${results.length} PDFs rendered.`);
