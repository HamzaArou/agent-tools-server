const express = require('express');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { google } = require('googleapis');

/*
 * Free scraping tool server for OpenAI Agent Builder
 *
 * This server exposes four HTTP endpoints that can be registered as custom tools:
 *
 * 1. POST /tool/fetch_html
 *    Body: { url: string, render?: boolean }
 *    Uses a headless Chromium browser (via Puppeteer) to fetch the full HTML of a page.
 *    Returns: { html: string, finalUrl: string }
 *
 * 2. POST /tool/extract_album_links
 *    Body: { html: string, baseUrl?: string }
 *    Extracts album URLs and titles from a category page using multiple CSS selectors.
 *    Returns: { albums: Array<{ album_url: string, album_title: string }> }
 *
 * 3. POST /tool/extract_image_links
 *    Body: { html: string }
 *    Extracts all image URLs from an album page. Looks at `data-origin-src` and
 *    falls back to `src`. Removes obvious placeholder images and de‑duplicates.
 *    Returns: { images: string[] }
 *
 * 4. POST /tool/sheets_append_rows
 *    Body: { rows: Array<Record<string,string>> }
 *    Appends rows to a Google Sheet using a service account. The sheet ID and
 *    sheet name must be provided via environment variables SHEET_ID and SHEET_NAME.
 *    Returns: { ok: true, count: number }
 *
 * Before running this server you must set the following environment variables:
 *  - GSA_BASE64: Base64 encoded contents of your Google service account JSON key
 *  - SHEET_ID: ID of the target Google spreadsheet
 *  - SHEET_NAME: Name of the sheet tab to append data to
 *
 * To deploy on Render for free, set the above environment variables in the Render
 * dashboard. The private key never leaves your Render environment.
 */

// Helper to convert relative or protocol-less URLs into absolute ones
function absolute(url) {
  if (!url) return '';
  // If protocol present return as is
  if (/^https?:\/\//i.test(url)) return url;
  // If protocol omitted but starts with // add https
  if (url.startsWith('//')) return 'https:' + url;
  // Otherwise combine with base domain
  const base = process.env.BASE_URL || 'https://yolo66.x.yupoo.com';
  if (url.startsWith('/')) {
    return base.replace(/\/$/, '') + url;
  }
  return `${base.replace(/\/$/, '')}/${url}`;
}

// Initialise Google Sheets API client from base64 encoded key
function initSheets() {
  const keyBase64 = process.env.GSA_BASE64;
  if (!keyBase64) {
    throw new Error('Missing GSA_BASE64 environment variable');
  }
  let keyJson;
  try {
    const keyBuf = Buffer.from(keyBase64, 'base64');
    keyJson = JSON.parse(keyBuf.toString('utf8'));
  } catch (err) {
    throw new Error('Failed to decode or parse GSA_BASE64: ' + err.message);
  }
  const auth = new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function fetchHTML(url, render = true) {
  // Use a single browser instance if possible to save resources
  if (!fetchHTML.browser) {
    fetchHTML.browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }
  const browser = fetchHTML.browser;
  const page = await browser.newPage();
  try {
    // Set a reasonable timeout
    await page.goto(url, { waitUntil: render ? 'networkidle2' : 'domcontentloaded', timeout: 60000 });
    const html = await page.content();
    const finalUrl = page.url();
    await page.close();
    return { html, finalUrl };
  } catch (err) {
    await page.close();
    throw err;
  }
}

function extractAlbums(html, baseUrl = 'https://yolo66.x.yupoo.com') {
  const $ = cheerio.load(html);
  const sels = ['.album__main a', '.categories__main a', '.show__main a', 'a'];
  const albums = [];
  const seen = new Set();
  for (const sel of sels) {
    $(sel).each((_, el) => {
      const href = $(el).attr('href') || '';
      const title = ($(el).attr('title') || $(el).text() || '').trim();
      if (!href) return;
      const url = absolute(href);
      if (/\/albums?\//.test(url) && !seen.has(url)) {
        seen.add(url);
        albums.push({ album_url: url, album_title: title || 'Untitled' });
      }
    });
  }
  return albums;
}

function extractImages(html) {
  const $ = cheerio.load(html);
  const urls = [];
  $('img').each((_, el) => {
    const d = $(el).attr('data-origin-src');
    const s = $(el).attr('src');
    const cand = d || s || '';
    if (!cand) return;
    // Filter out sprite or placeholder images
    if (/sprite|placeholder|loading/.test(cand)) return;
    urls.push(absolute(cand));
  });
  // Deduplicate while preserving order
  const unique = [];
  const set = new Set();
  for (const u of urls) {
    if (!set.has(u)) {
      set.add(u);
      unique.push(u);
    }
  }
  return unique;
}

async function appendRows(rows) {
  const sheets = initSheets();
  const spreadsheetId = process.env.SHEET_ID;
  const sheetName = process.env.SHEET_NAME;
  if (!spreadsheetId || !sheetName) {
    throw new Error('Missing SHEET_ID or SHEET_NAME environment variables');
  }
  const header = ['Album Title', 'Album URL', 'Image 1', 'Image 2', 'Image 3', 'Image 4', 'Image 5', 'Image 6', 'Image 7', 'Image 8'];
  const values = rows.map(row => header.map(h => row[h] || ''));
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:J`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
  return rows.length;
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Endpoint: fetch_html
app.post('/tool/fetch_html', async (req, res) => {
  try {
    const { url, render = true } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const result = await fetchHTML(url, render);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'fetch_html error' });
  }
});

// Endpoint: extract_album_links
app.post('/tool/extract_album_links', (req, res) => {
  try {
    const { html, baseUrl } = req.body;
    if (!html) return res.status(400).json({ error: 'html is required' });
    const albums = extractAlbums(html, baseUrl);
    res.json({ albums });
  } catch (err) {
    res.status(500).json({ error: err.message || 'extract_album_links error' });
  }
});

// Endpoint: extract_image_links
app.post('/tool/extract_image_links', (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'html is required' });
    const images = extractImages(html);
    res.json({ images });
  } catch (err) {
    res.status(500).json({ error: err.message || 'extract_image_links error' });
  }
});

// Endpoint: sheets_append_rows
app.post('/tool/sheets_append_rows', async (req, res) => {
  try {
    const { rows } = req.body;
    if (!rows || !Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });
    const count = await appendRows(rows);
    res.json({ ok: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message || 'sheets_append_rows error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Tool server listening on port ${port}`);
});