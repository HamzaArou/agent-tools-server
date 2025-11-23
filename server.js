const express = require('express');
const cheerio = require('cheerio');
const { google } = require('googleapis');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ----- ENV -----
const BASE_URL = process.env.BASE_URL || 'https://yolo66.x.yupoo.com';
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';
const GSA_BASE64 = process.env.GSA_BASE64;

// ----- Google Sheets auth from base64 -----
let sheets;
(async () => {
  const json = Buffer.from(GSA_BASE64 || '', 'base64').toString('utf8');
  const creds = JSON.parse(json);
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  sheets = google.sheets({ version: 'v4', auth });
})();

// helpers
const abs = (u) => {
  if (!u) return '';
  if (u.startsWith('http')) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return BASE_URL + u;
  return `${BASE_URL.replace(/\/+$/,'')}/${u.replace(/^\/+/,'')}`;
};

// Playwright page getter
async function getHTML(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-gpu']
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  const html = await page.content();
  await browser.close();
  return html;
}

// extractors
function extractAlbums(html) {
  const $ = cheerio.load(html);
  const sels = [".album__main a", ".categories__main a", ".show__main a", "a"];
  const out = [];
  const seen = new Set();
  for (const s of sels) {
    $(s).each((_, el) => {
      const href = $(el).attr('href') || '';
      const title = ($(el).attr('title') || $(el).text() || '').trim();
      const url = abs(href);
      if (url && /\/albums?\//.test(url) && !seen.has(url)) {
        seen.add(url);
        out.push({ album_url: url, album_title: title || 'Untitled' });
      }
    });
  }
  return out;
}
function extractImages(html) {
  const $ = cheerio.load(html);
  const imgs = [];
  $('img').each((_, el) => {
    const src = $(el).attr('data-origin-src') || $(el).attr('src') || '';
    if (!src) return;
    if (src.includes('sprite') || src.includes('placeholder')) return;
    imgs.push(abs(src));
  });
  return Array.from(new Set(imgs));
}

// tools
app.get('/', (_req, res) => res.json({ ok: true, service: 'agent-tools-server' }));

app.post('/tool/fetch_html', async (req, res) => {
  try {
    const { url } = req.body;
    const html = await getHTML(url);
    res.json({ html, finalUrl: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/tool/extract_album_links', (req, res) => {
  try { res.json({ albums: extractAlbums(req.body.html || '') }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/tool/extract_image_links', (req, res) => {
  try { res.json({ images: extractImages(req.body.html || '') }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/tool/sheets_append_rows', async (req, res) => {
  try {
    const rows = req.body.rows || [];
    const header = ["Album Title","Album URL","Image 1","Image 2","Image 3","Image 4","Image 5","Image 6","Image 7","Image 8"];
    const values = rows.map(r => header.map(h => r[h] ?? ''));
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:J`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values }
    });
    res.json({ ok: true, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`tool server on :${PORT}`));
