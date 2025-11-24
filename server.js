// server.js  — MCP-compatible tool server (HTTP JSON)

const express = require('express');
const cheerio  = require('cheerio');
const { google } = require('googleapis');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '10mb' }));

/* ===== ENV ===== */
const BASE_URL  = process.env.BASE_URL || 'https://yolo66.x.yupoo.com';
const SHEET_ID  = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';
const GSA_BASE64 = process.env.GSA_BASE64;

/* ===== Google Sheets auth (lazy init) ===== */
let sheets;
async function getSheets() {
  if (sheets) return sheets;
  const json = Buffer.from(GSA_BASE64 || '', 'base64').toString('utf8');
  const creds = JSON.parse(json);
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

/* ===== Helpers ===== */
const abs = (u) => {
  if (!u) return '';
  if (u.startsWith('http')) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/'))  return BASE_URL + u;
  return `${BASE_URL.replace(/\/+$/,'')}/${u.replace(/^\/+/,'')}`;
};

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

async function appendRows(rows) {
  const api = await getSheets();
  const header = [
    "Album Title","Album URL",
    "Image 1","Image 2","Image 3","Image 4","Image 5","Image 6","Image 7","Image 8"
  ];
  const values = rows.map(r => header.map(h => r[h] ?? ''));
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:J`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values }
  });
  return { ok: true, count: rows.length };
}

/* ===== Plain HTTP endpoints (keep for curl/manual tests) ===== */
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'agent-tools-server', mcp: { protocol: '1.0' }});
});
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/tool/fetch_html', async (req,res)=>{
  try {
    const { url } = req.body || {};
    const html = await getHTML(url);
    res.json({ html, finalUrl: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/tool/extract_album_links', (req,res)=>{
  try {
    const { html } = req.body || {};
    res.json({ albums: extractAlbums(html || '') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/tool/extract_image_links', (req,res)=>{
  try {
    const { html } = req.body || {};
    res.json({ images: extractImages(html || '') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/tool/sheets_append_rows', async (req,res)=>{
  try {
    const rows = req.body?.rows || [];
    const r = await appendRows(rows);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ===== Minimal MCP over HTTP =====
   POST /mcp/describe → returns available tools + JSON schemas
   POST /mcp/call     → executes tool by name with args
*/
const TOOLS = [
  {
    name: "fetch_html",
    description: "Fetch rendered HTML of a URL using Playwright.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to load." }
      },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "extract_album_links",
    description: "Extract album links from a categories/list HTML.",
    input_schema: {
      type: "object",
      properties: {
        html: { type: "string" }
      },
      required: ["html"],
      additionalProperties: false
    }
  },
  {
    name: "extract_image_links",
    description: "Extract image URLs from an album HTML.",
    input_schema: {
      type: "object",
      properties: {
        html: { type: "string" }
      },
      required: ["html"],
      additionalProperties: false
    }
  },
  {
    name: "sheets_append_rows",
    description: "Append rows to Google Sheet (A:J) with Image 1..8.",
    input_schema: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true
          }
        }
      },
      required: ["rows"],
      additionalProperties: false
    }
  }
];

app.post('/mcp/describe', (_req, res) => {
  res.json({
    mcp: { protocol: "1.0" },
    tools: TOOLS
  });
});

app.post('/mcp/call', async (req, res) => {
  try {
    const { name, arguments: args } = req.body || {};
    if (name === 'fetch_html') {
      const html = await getHTML(args.url);
      return res.json({ content: { html, finalUrl: args.url } });
    }
    if (name === 'extract_album_links') {
      return res.json({ content: { albums: extractAlbums(args.html || '') } });
    }
    if (name === 'extract_image_links') {
      return res.json({ content: { images: extractImages(args.html || '') } });
    }
    if (name === 'sheets_append_rows') {
      const r = await appendRows(args.rows || []);
      return res.json({ content: r });
    }
    res.status(400).json({ error: `Unknown tool: ${name}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===== Start ===== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`MCP tool server on :${PORT}`));
