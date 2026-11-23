/*
 * Tab Graveyard
 * Closes tabs you haven't used for a while and keeps each one in a searchable
 * archive with a one-line summary. Chrome extension, Manifest V3, no server.
 *
 * Everything lives in this one file.
 *
 *   node Graveyard.js                 build the extension into ./tab-graveyard
 *   node Graveyard.js build <folder>  build it somewhere else
 *   node Graveyard.js test            run the unit tests
 *
 * Load it: chrome://extensions → turn on Developer mode → Load unpacked → pick
 * the tab-graveyard folder. After editing this file, build again and click the
 * reload icon on the extension's card.
 *
 * The build copies this file into the extension as graveyard.js. Chrome runs it
 * as the service worker and as the script of every extension page; boot() at
 * the bottom checks where it is running and starts the right part.
 *
 * Fast testing mode (stale after 2 minutes, sweep every minute) is on the
 * hidden developer section of the settings page: options.html#dev
 *
 * Map of the file
 *   1. Settings and constants
 *   2. Rules: which tabs may close
 *   3. Text helpers and the non-AI summary
 *   4. Search index (prefix and fuzzy matching)
 *   5. Archive database (IndexedDB)
 *   6. Page text extraction (injected into a tab)
 *   7. AI summaries (Chrome's on-device Summarizer API)
 *   8. Service worker: activity tracking, sweep, archiving
 *   9. Extension pages: popup, archive, options, onboarding, offscreen
 *  10. Build: manifest, HTML, CSS, icons
 *  11. Tests
 *  12. Boot
 */
'use strict';

// ---------------------------------------------------------------------------
// 1. Settings and constants
// ---------------------------------------------------------------------------

const VERSION = '1.0.0';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DEFAULT_SETTINGS = Object.freeze({
  thresholdHours: 72,
  protectedDomains: ['mail.google.com', 'outlook.live.com', 'calendar.google.com', 'web.whatsapp.com'],
  summariesEnabled: true,
  pausedUntil: 0,
  notify: true,
  devFastMode: false,
});

const THRESHOLD_CHOICES = [24, 48, 72, 168];
const SWEEP_MINUTES = 30;
const FAST_SWEEP_MINUTES = 1;
const FAST_THRESHOLD_MS = 2 * MINUTE;
const MAX_ARCHIVE_PER_RUN = 20;
const SNIPPET_CHARS = 2000;        // kept with the record, used for search
const EXTRACT_CHARS = 8000;        // read from the page; kept only until the AI summary exists
const EXTRACT_TIMEOUT_MS = 4000;
const AI_SUMMARY_CHARS = 120;
const FALLBACK_SUMMARY_CHARS = 160;
const MIN_TEXT_FOR_AI = 200;
const PENDING_SUMMARY_MAX_AGE = 14 * DAY;
const RESTORE_POOL_MS = 10 * MINUTE;
const SUMMARIZER_LANGUAGES = ['en', 'es', 'ja', 'de', 'fr'];
const SUMMARIZER_OPTIONS = Object.freeze({ type: 'tldr', format: 'plain-text', length: 'short' });

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

function effectiveConfig(settings) {
  const fast = Boolean(settings.devFastMode);
  return {
    thresholdMs: fast ? FAST_THRESHOLD_MS : settings.thresholdHours * HOUR,
    periodMs: (fast ? FAST_SWEEP_MINUTES : SWEEP_MINUTES) * MINUTE,
  };
}

function thresholdLabel(settings) {
  if (settings.devFastMode) return '2 minutes';
  const days = settings.thresholdHours / 24;
  return days === 1 ? '1 day' : `${days} days`;
}

function plural(n, word, many = word + 's') {
  return `${n.toLocaleString()} ${n === 1 ? word : many}`;
}

// ---------------------------------------------------------------------------
// 2. Rules: which tabs may close
// ---------------------------------------------------------------------------

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function displayDomain(url) {
  return hostnameOf(url).replace(/^www\./, '');
}

// "https://www.MyBank.com/login" → "mybank.com". Returns '' when it isn't a domain.
function normalizeDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '');
  try { s = new URL('http://' + s).hostname; } catch { return ''; }
  s = s.replace(/^www\./, '').replace(/\.$/, '');
  if (s === 'localhost') return s;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

// A protected domain also covers its subdomains: "google.com" protects "docs.google.com".
function isProtected(url, protectedDomains) {
  const host = hostnameOf(url).replace(/^www\./, '');
  if (!host) return false;
  return (protectedDomains || []).some((entry) => {
    const d = normalizeDomain(entry);
    return d && (host === d || host.endsWith('.' + d));
  });
}

// Only normal web pages: never chrome://, extension pages, file://, the new tab page or the Web Store.
function isArchivableUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'chromewebstore.google.com') return false;
  if (host === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return false;
  return true;
}

// Returns null when the tab may be archived, otherwise why it is kept.
// ctx = { now, thresholdMs, settings, activity }
function keepReason(tab, ctx) {
  if (ctx.now < (ctx.settings.pausedUntil || 0)) return 'paused';
  if (tab.incognito) return 'incognito';
  if (!isArchivableUrl(tab.url || '')) return 'not-a-web-page';
  if (tab.active) return 'active';
  if (tab.pinned) return 'pinned';
  if (tab.audible) return 'audible';
  if (isProtected(tab.url, ctx.settings.protectedDomains)) return 'protected-domain';
  const entry = ctx.activity[tab.id];
  if (!entry || typeof entry.lastUsed !== 'number') return 'not-tracked';
  if (ctx.now - entry.lastUsed <= ctx.thresholdMs) return 'recently-used';
  return null;
}

function passesAllRules(tab, ctx) {
  return keepReason(tab, ctx) === null;
}

// Oldest first, at most `max`, and never the last tab left in a window.
function selectCandidates(tabs, ctx, max = MAX_ARCHIVE_PER_RUN) {
  const left = new Map();
  for (const t of tabs) left.set(t.windowId, (left.get(t.windowId) || 0) + 1);
  const stale = tabs
    .filter((t) => passesAllRules(t, ctx))
    .sort((a, b) => ctx.activity[a.id].lastUsed - ctx.activity[b.id].lastUsed);
  const picked = [];
  for (const t of stale) {
    if (picked.length >= max) break;
    if (left.get(t.windowId) <= 1) continue;
    left.set(t.windowId, left.get(t.windowId) - 1);
    picked.push(t);
  }
  return picked;
}

// The sweep runs every period. If several runs were missed, the computer was
// asleep or Chrome was closed. That time is not inactivity, so every lastUsed
// moves forward by the missing time.
function applySleepGap(activity, lastSweepAt, now, periodMs) {
  if (!lastSweepAt) return { activity, shiftedBy: 0 };
  const gap = now - lastSweepAt;
  if (gap <= 3 * periodMs) return { activity, shiftedBy: 0 };
  const shift = gap - periodMs;
  const out = {};
  for (const [id, entry] of Object.entries(activity)) {
    out[id] = { ...entry, lastUsed: Math.min(now, entry.lastUsed + shift) };
  }
  return { activity: out, shiftedBy: shift };
}

// Tab IDs change when Chrome restarts. Match open tabs to old entries by URL.
// Duplicated URLs get the most recent time first, which errs toward keeping tabs.
function carryOverByUrl(oldActivity, tabs, now) {
  const pool = new Map();
  for (const entry of Object.values(oldActivity)) {
    if (!entry || !entry.url) continue;
    if (!pool.has(entry.url)) pool.set(entry.url, []);
    pool.get(entry.url).push(entry.lastUsed);
  }
  for (const list of pool.values()) list.sort((a, b) => b - a);
  const activity = {};
  for (const tab of tabs) {
    const list = pool.get(tab.url);
    activity[tab.id] = list && list.length
      ? { url: tab.url, lastUsed: list.shift() }
      : { url: tab.url || '', lastUsed: now, seeded: true };
  }
  const leftovers = [];
  for (const [url, list] of pool) for (const lastUsed of list) leftovers.push({ url, lastUsed });
  return { activity, leftovers };
}

// ---------------------------------------------------------------------------
// 3. Text helpers and the non-AI summary
// ---------------------------------------------------------------------------

function squash(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function clip(text, max) {
  const s = squash(text);
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…';
}

// A sentence ends at . ! ? followed by a space and a non-lowercase letter, or at the end of the line.
const SENTENCE_RE = /[^]+?(?:[.!?]+["”’')\]]*(?=\s+[^\sa-z]|\s*$)|[。！？]|$)/g;
const SENTENCE_END_RE = /[.!?。！？]["”’')\]]*$/;
const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/;

// First real sentence of the text: skips menus, headings and fragments.
function firstSentence(text) {
  for (const line of String(text || '').split(/\n+/)) {
    for (const match of line.trim().matchAll(SENTENCE_RE)) {
      const s = squash(match[0]);
      const longEnough = (s.split(' ').length >= 6 && s.length >= 30) || (CJK_RE.test(s) && s.length >= 15);
      if (longEnough && SENTENCE_END_RE.test(s)) return s;
    }
  }
  return '';
}

// Instant and always available: meta description, else first sentence, else title.
function fallbackSummary({ title = '', text = '', description = '' } = {}) {
  const desc = clip(description, FALLBACK_SUMMARY_CHARS);
  if (desc.length >= 25 && desc.toLowerCase() !== squash(title).toLowerCase()) return desc;
  const sentence = firstSentence(text);
  if (sentence) return clip(sentence, FALLBACK_SUMMARY_CHARS);
  return clip(title, FALLBACK_SUMMARY_CHARS) || 'Untitled page';
}

// The Summarizer may answer with bullets or several sentences: keep one short line.
function oneLineSummary(raw) {
  let s = String(raw || '')
    .replace(/^\s*(?:[-*•#>]+|\d+[.)])\s*/gm, '')
    .replace(/\*\*|__|`/g, '');
  s = squash(s);
  const first = s.match(/^[^]+?[.!?。！？](?=\s|$)/);
  if (first && first[0].length >= 20) s = first[0];
  return clip(s, AI_SUMMARY_CHARS);
}

const DAY_GROUPS = ['Today', 'Yesterday', 'This week', 'Older'];

function dayGroup(ts, now = Date.now()) {
  const startOf = (daysAgo) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d.getTime();
  };
  if (ts >= startOf(0)) return 'Today';
  if (ts >= startOf(1)) return 'Yesterday';
  if (ts >= startOf(6)) return 'This week';
  return 'Older';
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// 4. Search index (prefix and fuzzy matching)
// ---------------------------------------------------------------------------
// Weights are integers (boost × 10). Adjacent words in the title and summary are
// also indexed joined together, so "jetfule" still finds "jet fuel".

const SEARCH_FIELDS = [['title', 30], ['summary', 20], ['domain', 15], ['textSnippet', 10]];

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC')
    .match(/[\p{L}\p{N}\p{M}]+/gu) || [];
}

function buildSearchIndex(records) {
  const postings = new Map(); // term → [doc, weight, doc, weight, ...]
  records.forEach((record, doc) => {
    const local = new Map();
    const add = (term, weight) => {
      if (term.length <= 40 && (local.get(term) || 0) < weight) local.set(term, weight);
    };
    for (const [field, boost] of SEARCH_FIELDS) {
      const tokens = tokenize(record[field]);
      for (let i = 0; i < tokens.length; i++) {
        add(tokens[i], boost);
        if (boost >= 20 && i + 1 < tokens.length) add(tokens[i] + tokens[i + 1], boost - 6);
      }
    }
    for (const [term, weight] of local) {
      let list = postings.get(term);
      if (!list) postings.set(term, (list = []));
      list.push(doc, weight);
    }
  });
  return { records, postings, vocab: [...postings.keys()].sort() };
}

function lowerBound(sorted, value) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Optimal string alignment distance (a swap of two letters counts as one edit).
// Stops early and returns max + 1 once the distance must exceed max.
function editDistance(a, b, max) {
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > max) return max + 1;
  let prev2 = new Array(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[m];
}

// Every query word must match (exactly, as a prefix, or with a typo).
// Returns [{ record, score }] with the best match first.
function searchIndex(index, query) {
  const terms = [...new Set(tokenize(query))];
  const n = index.records.length;
  if (!terms.length || !n) return [];
  let total = null;
  for (const term of terms) {
    const best = new Float32Array(n);
    const take = (vocabTerm, factor) => {
      const list = index.postings.get(vocabTerm);
      for (let k = 0; k < list.length; k += 2) {
        const score = list[k + 1] * factor;
        if (score > best[list[k]]) best[list[k]] = score;
      }
    };
    if (index.postings.has(term)) take(term, 1);
    for (let i = lowerBound(index.vocab, term); i < index.vocab.length && index.vocab[i].startsWith(term); i++) {
      if (index.vocab[i] !== term) take(index.vocab[i], 0.7);
    }
    const maxEdits = term.length >= 7 ? 2 : term.length >= 4 ? 1 : 0;
    if (maxEdits) {
      for (const v of index.vocab) {
        if (v === term || Math.abs(v.length - term.length) > maxEdits) continue;
        const d = editDistance(term, v, maxEdits);
        if (d <= maxEdits) take(v, d === 1 ? 0.5 : 0.35);
      }
    }
    if (!total) total = best;
    else for (let d = 0; d < n; d++) total[d] = total[d] > 0 && best[d] > 0 ? total[d] + best[d] : 0;
  }
  const hits = [];
  for (let d = 0; d < n; d++) if (total[d] > 0) hits.push({ record: index.records[d], score: total[d] });
  return hits.sort((a, b) => b.score - a.score || b.record.archivedAt - a.record.archivedAt);
}

// ---------------------------------------------------------------------------
// 5. Archive database (IndexedDB)
// ---------------------------------------------------------------------------
// Record: { id, url, title, domain, favIconUrl, summary, summarySource
// ('pending' | 'ai' | 'fallback'), textSnippet, pendingText, lang, lastUsed,
// archivedAt, restoredAt }. pendingText holds up to 8,000 characters for the AI
// summary and is emptied once the summary is made.

const DB_NAME = 'tab-graveyard';
const DB_VERSION = 1;
const STORE = 'archive';
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('archivedAt', 'archivedAt');
        store.createIndex('domain', 'domain');
        store.createIndex('url', 'url');
        store.createIndex('summarySource', 'summarySource');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

function requestP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

const ArchiveDB = {
  // Same URL archived again: update the existing record instead of adding one.
  // Resolves only after the data is committed to disk.
  async upsert(record) {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE);
    const existing = await requestP(store.index('url').get(record.url));
    const saved = existing ? { ...existing, ...record, id: existing.id } : record;
    store.put(saved);
    await done;
    return saved;
  },
  async update(id, patch) {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE);
    const record = await requestP(store.get(id));
    if (record) store.put({ ...record, ...patch });
    await done;
    return Boolean(record);
  },
  async all() {
    const db = await openDB();
    return requestP(db.transaction(STORE).objectStore(STORE).getAll());
  },
  async pending(limit) {
    const db = await openDB();
    return requestP(db.transaction(STORE).objectStore(STORE).index('summarySource').getAll('pending', limit));
  },
  async count() {
    const db = await openDB();
    return requestP(db.transaction(STORE).objectStore(STORE).count());
  },
  async remove(id) {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE).delete(id);
    await done;
  },
  async clear() {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE).clear();
    await done;
  },
};

// Tells open archive pages and popups to reload. Returns the version written.
async function notifyArchiveChanged() {
  const version = Date.now() + Math.random();
  try {
    if (chrome.storage && chrome.storage.local) await chrome.storage.local.set({ archiveVersion: version });
    else await chrome.runtime.sendMessage({ type: 'archiveChanged' }); // offscreen pages have no storage API
  } catch { /* nothing is listening */ }
  return version;
}

// ---------------------------------------------------------------------------
// 6. Page text extraction (injected into a tab)
// ---------------------------------------------------------------------------
// chrome.scripting serializes this function into the page, so it must not use
// anything from outside its own body. It is a small Readability-style
// extractor: find the block with the most paragraph text, then read its text.

function extractReadablePage(maxChars) {
  const out = { title: '', description: '', lang: '', text: '' };
  try {
    const clean = (s) => String(s || '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    const meta = (...selectors) => {
      for (const sel of selectors) {
        const value = document.querySelector(sel)?.getAttribute('content');
        if (value && value.trim()) return value.trim();
      }
      return '';
    };
    out.title = document.title || '';
    out.description = meta('meta[name="description" i]', 'meta[property="og:description"]', 'meta[name="twitter:description"]').slice(0, 400);
    out.lang = (document.documentElement.lang || meta('meta[http-equiv="content-language" i]') || '').toLowerCase().split(/[-_]/)[0];

    const SKIP = 'nav, header, footer, aside, form, button, script, style, noscript, svg, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"]';
    const scores = new Map();
    for (const p of document.querySelectorAll('p, pre, blockquote')) {
      if (p.closest(SKIP)) continue;
      const len = (p.textContent || '').trim().length;
      if (len < 60) continue;
      const parent = p.parentElement;
      const grand = parent && parent.parentElement;
      if (parent) scores.set(parent, (scores.get(parent) || 0) + len);
      if (grand) scores.set(grand, (scores.get(grand) || 0) + len / 2);
    }
    let root = null;
    let best = 0;
    for (const [el, score] of scores) if (score > best) { best = score; root = el; }
    const semantic = document.querySelector('article, main, [role="main"]');
    if (semantic && (!root || semantic.contains(root))) root = semantic;

    const parts = [];
    let length = 0;
    if (root) {
      for (const el of root.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre, dd, figcaption')) {
        if (el.closest(SKIP)) continue;
        if (el.querySelector('p, li, h1, h2, h3, blockquote')) continue; // a container: its children are read instead
        const t = clean(el.textContent);
        if (!t) continue;
        parts.push(t);
        length += t.length + 1;
        if (length > maxChars) break;
      }
    }
    let text = parts.join('\n');
    if (text.length < 200 && document.body) text = clean(document.body.innerText);
    out.text = text.slice(0, maxChars);
  } catch { /* return what we have */ }
  return out;
}

// ---------------------------------------------------------------------------
// 7. AI summaries (Chrome's on-device Summarizer API)
// ---------------------------------------------------------------------------
// Pending records are summarized wherever the API exists: the service worker
// if Chrome exposes it there, otherwise an offscreen page, the popup, the
// archive page or the settings page. The first download of the model needs a
// click, so it is started from the settings page.

function summaryLanguage(lang) {
  const l = String(lang || 'en').toLowerCase();
  return SUMMARIZER_LANGUAGES.includes(l) ? l : null;
}

function summarizerOptions(lang) {
  return { ...SUMMARIZER_OPTIONS, expectedInputLanguages: [lang], outputLanguage: lang };
}

// Returns a summarizer, 'unavailable' (this device or language can't), or 'waiting' (model not downloaded yet).
async function openSummarizer(lang) {
  const options = summarizerOptions(lang);
  let availability;
  try { availability = await Summarizer.availability(options); } catch { return 'unavailable'; }
  if (availability === 'unavailable') return 'unavailable';
  if (availability !== 'available') return 'waiting';
  try { return await Summarizer.create(options); } catch { return 'waiting'; }
}

async function summarizeText(summarizer, text) {
  for (const size of [6000, 2500]) {
    try {
      const raw = await summarizer.summarize(text.slice(0, size), { context: 'A web page the user had open in a browser tab.' });
      return oneLineSummary(raw);
    } catch (err) {
      if (err && err.name === 'QuotaExceededError') continue;
      return '';
    }
  }
  return '';
}

let summaryRun = null;

// Returns 'done', 'waiting' (model needs a download), 'no-api' or 'error'.
function processSummaryQueue(options = {}) {
  if (!summaryRun) summaryRun = summarizePending(options).finally(() => { summaryRun = null; });
  return summaryRun;
}

async function summarizePending({ canMarkFallback = false } = {}) {
  const hasApi = typeof Summarizer !== 'undefined';
  if (!hasApi && !canMarkFallback) return 'no-api';
  const instances = new Map(); // language → summarizer | 'unavailable' | 'waiting'
  const skipped = new Set();
  let changed = false;
  let waiting = false;
  const keepFallback = async (record) => {
    await ArchiveDB.update(record.id, { summarySource: 'fallback', pendingText: '' });
    changed = true;
  };
  try {
    for (let round = 0; round < 20; round++) {
      const batch = (await ArchiveDB.pending(skipped.size + 20)).filter((r) => !skipped.has(r.id));
      if (!batch.length) break;
      for (const record of batch) {
        const text = record.pendingText || '';
        const lang = summaryLanguage(record.lang);
        const tooOld = Date.now() - record.archivedAt > PENDING_SUMMARY_MAX_AGE;
        if (!hasApi || !lang || text.length < MIN_TEXT_FOR_AI || tooOld) { await keepFallback(record); continue; }
        if (!instances.has(lang)) instances.set(lang, await openSummarizer(lang));
        const summarizer = instances.get(lang);
        if (summarizer === 'unavailable') { await keepFallback(record); continue; }
        if (summarizer === 'waiting') { waiting = true; skipped.add(record.id); continue; }
        const line = await summarizeText(summarizer, text);
        if (line) {
          await ArchiveDB.update(record.id, { summary: line, summarySource: 'ai', pendingText: '' });
          changed = true;
        } else {
          await keepFallback(record);
        }
      }
    }
  } catch (err) {
    console.warn('[Tab Graveyard] summaries:', err);
    return 'error';
  } finally {
    for (const s of instances.values()) if (s && typeof s === 'object') { try { s.destroy(); } catch { /* ignore */ } }
    if (changed) await notifyArchiveChanged();
  }
  if (!hasApi) return 'no-api';
  return waiting ? 'waiting' : 'done';
}

// ---------------------------------------------------------------------------
// 8. Service worker: activity tracking, sweep, archiving
// ---------------------------------------------------------------------------
// Manifest V3 stops the worker when idle, so all state lives in
// chrome.storage.local (activity, settings, lastSweepAt) and IndexedDB (archive).

// Activity updates run one at a time so two events can't overwrite each other.
let workerChain = Promise.resolve();
function serial(task) {
  const run = workerChain.then(task, task);
  workerChain = run.catch(() => {});
  return run;
}

function updateActivity(mutate) {
  return serial(async () => {
    const { activity = {} } = await chrome.storage.local.get('activity');
    const result = await mutate(activity);
    await chrome.storage.local.set({ activity });
    return result;
  });
}

function trackable(tab) {
  return Boolean(tab) && tab.id != null && tab.id >= 0 && !tab.incognito;
}

function markUsed(tab) {
  if (!trackable(tab)) return;
  const now = Date.now();
  return updateActivity((a) => {
    a[tab.id] = { url: tab.url || (a[tab.id] && a[tab.id].url) || '', lastUsed: now };
  });
}

// A tab was created or changed URL without the user looking at it.
function noteTab(tab) {
  if (!trackable(tab)) return;
  return updateActivity(async (a) => {
    const entry = a[tab.id];
    if (entry && !entry.seeded) {
      if (tab.url) entry.url = tab.url;
      return;
    }
    const restored = tab.url ? await takeFromRestorePool(tab.url) : null;
    a[tab.id] = restored != null
      ? { url: tab.url, lastUsed: restored }
      : { url: tab.url || '', lastUsed: entry ? entry.lastUsed : Date.now(), seeded: true };
  });
}

// Tabs that Chrome restores a little after startup still get their old time.
async function takeFromRestorePool(url) {
  const { restorePool } = await chrome.storage.local.get('restorePool');
  if (!restorePool || Date.now() - restorePool.at > RESTORE_POOL_MS) return null;
  const i = restorePool.entries.findIndex((e) => e.url === url);
  if (i < 0) return null;
  const [hit] = restorePool.entries.splice(i, 1);
  await chrome.storage.local.set({ restorePool });
  return hit.lastUsed;
}

async function ensureAlarm(settings) {
  const { periodMs } = effectiveConfig(settings || (await loadSettings()));
  const period = periodMs / MINUTE;
  const existing = await chrome.alarms.get('sweep');
  if (!existing || existing.periodInMinutes !== period) {
    await chrome.alarms.create('sweep', { periodInMinutes: period, delayInMinutes: period });
  }
}

async function onInstalled({ reason }) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } });
  const now = Date.now();
  const tabs = await chrome.tabs.query({});
  await updateActivity((activity) => {
    for (const tab of tabs) {
      if (!trackable(tab)) continue;
      // Fresh install: every open tab counts as used now, so nothing closes on day one.
      if (reason === 'install' || !activity[tab.id]) activity[tab.id] = { url: tab.url || '', lastUsed: now };
    }
  });
  await chrome.storage.local.set({ lastSweepAt: now });
  await chrome.storage.session.set({ ready: true });
  await ensureAlarm();
  if (reason === 'install') await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
}

// After a restart tab IDs are new: carry lastUsed over by URL, and do not count
// the time Chrome was closed.
async function reconcileAfterRestart() {
  const now = Date.now();
  const settings = await loadSettings();
  const { periodMs } = effectiveConfig(settings);
  const tabs = (await chrome.tabs.query({})).filter(trackable);
  await serial(async () => {
    const stored = await chrome.storage.local.get(['activity', 'lastSweepAt']);
    const shifted = applySleepGap(stored.activity || {}, stored.lastSweepAt, now, periodMs).activity;
    const { activity, leftovers } = carryOverByUrl(shifted, tabs, now);
    await chrome.storage.local.set({ activity, lastSweepAt: now, restorePool: { at: now, entries: leftovers } });
  });
  await chrome.storage.session.set({ ready: true }); // session storage is emptied when Chrome restarts
  await ensureAlarm(settings);
}

// The alarm can fire before onStartup. Never read old tab IDs as if they were current.
async function ensureSessionReady() {
  const { ready } = await chrome.storage.session.get('ready');
  if (!ready) await reconcileAfterRestart();
}

let sweepInFlight = null;
function sweep(options) {
  if (!sweepInFlight) sweepInFlight = runSweep(options).finally(() => { sweepInFlight = null; });
  return sweepInFlight;
}

async function runSweep({ manual = false } = {}) {
  await ensureSessionReady();
  const now = Date.now();
  const settings = await loadSettings();
  const { thresholdMs, periodMs } = effectiveConfig(settings);
  const tabs = (await chrome.tabs.query({ windowType: 'normal' })).filter((t) => !t.incognito);
  const focused = await chrome.windows.getLastFocused().catch(() => null);

  const activity = await serial(async () => {
    const stored = await chrome.storage.local.get(['activity', 'lastSweepAt']);
    const next = applySleepGap(stored.activity || {}, stored.lastSweepAt, now, periodMs).activity;
    const open = new Set();
    for (const tab of tabs) {
      open.add(String(tab.id));
      // A tab we have never seen is not archived now; its clock starts today.
      if (!next[tab.id]) next[tab.id] = { url: tab.url || '', lastUsed: now, seeded: true };
      // The tab in front of the focused window is being used right now.
      if (focused && focused.focused && tab.windowId === focused.id && tab.active) next[tab.id].lastUsed = now;
    }
    for (const id of Object.keys(next)) if (!open.has(id)) delete next[id];
    await chrome.storage.local.set({ activity: next, lastSweepAt: now });
    return next;
  });

  if (now < (settings.pausedUntil || 0)) return { archived: 0, paused: true };

  const ctx = { now, thresholdMs, settings, activity };
  let archived = 0;
  for (const tab of selectCandidates(tabs, ctx)) {
    if (await archiveTab(tab, ctx)) archived++;
  }
  if (archived) {
    await notifyArchiveChanged();
    if (!manual && settings.notify) showArchivedNotification(archived, settings);
    startSummaries();
  }
  return { archived };
}

async function archiveTab(tab, ctx) {
  const [page, favIconUrl] = await Promise.all([extractFromTab(tab), faviconDataUrl(tab.favIconUrl)]);

  // Reading the page takes a moment: check the tab again in case the user switched to it.
  let fresh;
  try { fresh = await chrome.tabs.get(tab.id); } catch { return false; }
  const [{ activity = {} }, settings] = await Promise.all([chrome.storage.local.get('activity'), loadSettings()]);
  if (fresh.url !== tab.url || !passesAllRules(fresh, { ...ctx, settings, now: Date.now(), activity })) return false;
  if ((await chrome.tabs.query({ windowId: fresh.windowId })).length <= 1) return false;

  const text = page.text || '';
  const wantsAi = settings.summariesEnabled && text.length >= MIN_TEXT_FOR_AI;
  const title = fresh.title || page.title || fresh.url;
  const record = {
    id: crypto.randomUUID(),
    url: fresh.url,
    title,
    domain: displayDomain(fresh.url),
    favIconUrl,
    summary: fallbackSummary({ title, text, description: page.description }),
    summarySource: wantsAi ? 'pending' : 'fallback',
    textSnippet: text.slice(0, SNIPPET_CHARS),
    pendingText: wantsAi ? text : '',
    lang: page.lang || '',
    lastUsed: activity[fresh.id].lastUsed,
    archivedAt: Date.now(),
    restoredAt: null,
  };

  // The most important rule: never close a tab unless its record is saved.
  try {
    await ArchiveDB.upsert(record);
  } catch (err) {
    console.error('[Tab Graveyard] Could not save, tab left open:', fresh.url, err);
    return false;
  }
  try { await chrome.tabs.remove(fresh.id); } catch { /* the user closed it already; the record stays */ }
  return true;
}

async function extractFromTab(tab) {
  const empty = { title: '', description: '', lang: '', text: '' };
  if (tab.discarded) return empty; // memory saver unloaded it; title and URL are still saved
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractReadablePage, args: [EXTRACT_CHARS] }),
      EXTRACT_TIMEOUT_MS,
    );
    return { ...empty, ...(results && results[0] && results[0].result) };
  } catch {
    return empty; // restricted page, PDF, frozen tab…
  }
}

// Keep the icon inside the record so the archive works offline and loads nothing from the web.
async function faviconDataUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url.length < 60000 ? url : '';
  if (!/^https?:/i.test(url)) return '';
  try {
    const res = await withTimeout(fetch(url, { credentials: 'omit', cache: 'force-cache' }), 2500);
    if (!res.ok) return url;
    const blob = await res.blob();
    if (blob.size > 40000 || !blob.type.startsWith('image/')) return url;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${blob.type};base64,${btoa(binary)}`;
  } catch {
    return url;
  }
}

function showArchivedNotification(count, settings) {
  chrome.notifications.create('tab-graveyard-archived', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Tab Graveyard',
    message: `Archived ${plural(count, 'tab')} you haven’t used in ${thresholdLabel(settings)}.`,
    buttons: [{ title: 'View archive' }],
  }, () => void chrome.runtime.lastError);
}

async function openExtensionPage(path) {
  const url = chrome.runtime.getURL(path);
  const existing = (await chrome.tabs.query({})).find((t) => t.url && t.url.split('#')[0] === url);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function startSummaries() {
  try {
    if (!(await loadSettings()).summariesEnabled) return;
    if (!(await ArchiveDB.pending(1)).length) return;
    if (typeof Summarizer !== 'undefined') {
      const result = await processSummaryQueue({ canMarkFallback: true });
      if (result !== 'no-api' && result !== 'error') return;
    }
    await openOffscreen();
  } catch (err) {
    console.warn('[Tab Graveyard] summaries:', err);
  }
}

async function openOffscreen() {
  if (!chrome.offscreen) return;
  const { offscreenOpenedAt = 0 } = await chrome.storage.session.get('offscreenOpenedAt');
  if (await chrome.offscreen.hasDocument()) {
    if (Date.now() - offscreenOpenedAt < 10 * MINUTE) return; // still working
    await chrome.offscreen.closeDocument().catch(() => {});  // stuck: start over
  }
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Summarize archived tabs with Chrome’s on-device Summarizer API.',
  });
  await chrome.storage.session.set({ offscreenOpenedAt: Date.now() });
}

const WORKER_MESSAGES = {
  sweepNow: () => sweep({ manual: true }),
  archiveChanged: () => notifyArchiveChanged(),
  summariesFinished: () => chrome.offscreen && chrome.offscreen.closeDocument().catch(() => {}),
};

// Listeners must be registered synchronously when the worker starts.
function startServiceWorker() {
  chrome.runtime.onInstalled.addListener(onInstalled);
  chrome.runtime.onStartup.addListener(reconcileAfterRestart);

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId).then(markUsed, () => {});
  });
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (!trackable(tab)) return;
    if (info.status === 'complete' && tab.active) markUsed(tab);
    else if (info.url) noteTab(tab);
  });
  chrome.tabs.onCreated.addListener((tab) => noteTab(tab));
  chrome.tabs.onRemoved.addListener((tabId) => updateActivity((a) => { delete a[tabId]; }));
  chrome.tabs.onReplaced.addListener((addedId, removedId) => updateActivity((a) => {
    if (a[removedId]) { a[addedId] = a[removedId]; delete a[removedId]; }
  }));
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    chrome.tabs.query({ active: true, windowId }).then(([tab]) => markUsed(tab), () => {});
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'sweep') sweep({ manual: false });
  });

  const openArchiveFromNotification = (id) => {
    if (!id.startsWith('tab-graveyard')) return;
    chrome.notifications.clear(id);
    openExtensionPage('archive.html');
  };
  chrome.notifications.onClicked.addListener(openArchiveFromNotification);
  chrome.notifications.onButtonClicked.addListener(openArchiveFromNotification);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const before = changes.settings.oldValue || {};
    const after = changes.settings.newValue || {};
    if (before.devFastMode !== after.devFastMode) ensureAlarm(after);
    if (after.summariesEnabled && !before.summariesEnabled) startSummaries();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = message && WORKER_MESSAGES[message.type];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(message, sender))
      .then((result) => sendResponse(result), (err) => sendResponse({ error: String((err && err.message) || err) }));
    return true;
  });

  ensureAlarm().catch(() => {}); // recreate the alarm if it went missing
}

// ---------------------------------------------------------------------------
// 9. Extension pages: popup, archive, options, onboarding, offscreen
// ---------------------------------------------------------------------------

function $(selector, root = document) {
  return root.querySelector(selector);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

function toast(message) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2800);
}

// First click arms the button, second click within a few seconds confirms.
function armConfirm(button, label) {
  if (button.dataset.armed === '1') return true;
  const original = button.textContent;
  button.dataset.armed = '1';
  button.textContent = label;
  button.classList.add('btn-danger');
  clearTimeout(button._disarm);
  button._disarm = setTimeout(() => disarm(button, original), 4000);
  button._original = original;
  return false;
}

function disarm(button, original = button._original) {
  clearTimeout(button._disarm);
  delete button.dataset.armed;
  button.classList.remove('btn-danger');
  if (original) button.textContent = original;
}

function onArchiveChanged(callback) {
  let timer = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.archiveVersion) return;
    clearTimeout(timer);
    timer = setTimeout(() => callback(changes.archiveVersion.newValue), 250);
  });
}

async function runQueuedSummaries(settings) {
  if (!settings.summariesEnabled) return;
  try { await processSummaryQueue({ canMarkFallback: true }); } catch { /* try again next time */ }
}

async function summarizerAvailability() {
  if (typeof Summarizer === 'undefined') return 'no-api';
  try { return await Summarizer.availability(summarizerOptions('en')); } catch { return 'unavailable'; }
}

function protectedChips(list, domains, onRemove) {
  list.replaceChildren(...domains.map((d) => el('li', { class: onRemove ? 'chip' : 'chip chip-static' },
    el('span', { text: d }),
    onRemove && el('button', { type: 'button', class: 'chip-x', 'aria-label': `Stop protecting ${d}`, onclick: () => onRemove(d) }, '×'))));
  if (!domains.length) list.append(el('li', { class: 'muted', text: 'No protected sites yet.' }));
}

// Adds a domain from a text field. Returns the new list, or null with an error shown.
async function addProtectedDomain(field, errorEl, settings) {
  const domain = normalizeDomain(field.value);
  if (!domain) { errorEl.textContent = 'Enter a site address, like mybank.com'; return null; }
  if (settings.protectedDomains.includes(domain)) { errorEl.textContent = `${domain} is already protected.`; return null; }
  errorEl.textContent = '';
  field.value = '';
  return (await saveSettings({ protectedDomains: [...settings.protectedDomains, domain] })).protectedDomains;
}

// ---- Popup

async function initPopup() {
  const button = $('#sweep-now');
  const result = $('#sweep-result');
  const pause = $('#pause');
  let settings = await loadSettings();

  async function refresh() {
    const now = Date.now();
    settings = await loadSettings();
    const [tabs, stored, archived] = await Promise.all([
      chrome.tabs.query({ windowType: 'normal' }),
      chrome.storage.local.get(['activity', 'lastSweepAt']),
      ArchiveDB.count(),
    ]);
    const { thresholdMs, periodMs } = effectiveConfig(settings);
    const activity = applySleepGap(stored.activity || {}, stored.lastSweepAt, now, periodMs).activity;
    const open = tabs.filter((t) => !t.incognito);
    const stale = selectCandidates(open, { now, thresholdMs, settings: { ...settings, pausedUntil: 0 }, activity }, Infinity).length;
    const paused = now < settings.pausedUntil;

    $('#open-count').textContent = open.length.toLocaleString();
    $('#archived-count').textContent = archived.toLocaleString();
    pause.checked = paused;
    button.disabled = paused;
    $('#pause-sub').textContent = paused
      ? `Paused until ${new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(settings.pausedUntil)}`
      : 'Stops all automatic closing for a day';
    $('#stale-hint').textContent = paused
      ? 'No tabs will be closed while paused.'
      : stale
        ? `${plural(stale, 'tab')} unused for over ${thresholdLabel(settings)}.`
        : `No tabs unused for over ${thresholdLabel(settings)}.`;
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Archiving…';
    result.textContent = '';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'sweepNow' });
      if (res && res.error) throw new Error(res.error);
      result.textContent = res && res.archived ? `Archived ${plural(res.archived, 'tab')}.`
        : res && res.paused ? 'Paused, so nothing was archived.'
        : 'Nothing to archive right now.';
    } catch {
      result.textContent = 'Something went wrong. Please try again.';
    }
    button.textContent = 'Archive stale tabs now';
    await refresh();
  });

  pause.addEventListener('change', async () => {
    await saveSettings({ pausedUntil: pause.checked ? Date.now() + DAY : 0 });
    result.textContent = '';
    await refresh();
  });

  const go = (path) => (event) => {
    event.preventDefault();
    const opening = path ? openExtensionPage(path) : chrome.runtime.openOptionsPage();
    opening.finally(() => window.close());
  };
  $('#open-archive').addEventListener('click', go('archive.html'));
  $('#open-settings').addEventListener('click', go(null));
  $('#ai-setup').addEventListener('click', go(null));

  await refresh();
  if (settings.summariesEnabled && (await summarizerAvailability()) === 'downloadable') $('#ai-hint').hidden = false;
  runQueuedSummaries(settings);
}

// ---- Archive page

async function initArchive() {
  const input = $('#q');
  const list = $('#results');
  const countEl = $('#count');
  const PAGE_SIZE = 200;
  const state = { records: [], index: null, query: '', entries: [], rendered: 0, removed: new Set(), settings: await loadSettings() };
  let ownVersion = null;
  const formats = new Map();

  const sentinel = el('div', { class: 'sentinel', 'aria-hidden': 'true' });
  const observer = new IntersectionObserver((seen) => {
    if (seen.some((s) => s.isIntersecting)) renderMore();
  }, { rootMargin: '800px' });

  function index() {
    return state.index || (state.index = buildSearchIndex(state.records));
  }

  async function load() {
    state.records = (await ArchiveDB.all()).sort((a, b) => b.archivedAt - a.archivedAt);
    state.removed.clear();
    state.index = null;
    render(state.rendered);
    if (state.records.length) setTimeout(index, 0); // build the search index while the user reads
  }

  function closedLabel(ts, group) {
    if (!formats.has(group)) {
      const options = group === 'Today' || group === 'Yesterday' ? { hour: 'numeric', minute: '2-digit' }
        : group === 'This week' ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
        : { day: 'numeric', month: 'short', year: 'numeric' };
      formats.set(group, new Intl.DateTimeFormat(undefined, options));
    }
    return 'Closed ' + formats.get(group).format(ts);
  }

  function faviconFor(record) {
    const letter = el('span', { class: 'fav fav-letter', 'aria-hidden': 'true', text: (record.domain || '?')[0].toUpperCase() });
    if (!record.favIconUrl) return letter;
    const img = el('img', { class: 'fav', src: record.favIconUrl, alt: '', width: 20, height: 20, loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(letter), { once: true });
    return img;
  }

  function rowFor(record, group) {
    const summary = el('p', { class: 'row-summary' }, record.summary || '');
    if (record.summarySource === 'ai') summary.append(' ', el('span', { class: 'tag', title: 'Summarized on this device', text: 'AI' }));
    return el('article', { class: 'row', dataset: { id: record.id } },
      faviconFor(record),
      el('div', { class: 'row-main' },
        el('h3', { class: 'row-title', title: record.url, text: record.title || record.url }),
        summary,
        el('p', { class: 'row-meta' },
          el('span', { class: 'row-domain', text: record.domain }),
          el('span', { 'aria-hidden': 'true', text: '·' }),
          el('time', { datetime: new Date(record.archivedAt).toISOString(), text: closedLabel(record.archivedAt, group) }))),
      el('div', { class: 'row-actions' },
        el('button', { class: 'btn btn-sm', type: 'button', dataset: { act: 'restore' }, text: 'Restore' }),
        el('button', { class: 'btn btn-sm btn-quiet', type: 'button', dataset: { act: 'delete' }, text: 'Delete' })));
  }

  function render(minRendered = 0) {
    const now = Date.now();
    const query = state.query.trim();
    const alive = (r) => !state.removed.has(r.id);
    const matches = query ? searchIndex(index(), query).map((h) => h.record).filter(alive) : state.records.filter(alive);
    const groups = new Map(DAY_GROUPS.map((g) => [g, []]));
    for (const r of matches) groups.get(dayGroup(r.archivedAt, now)).push(r);

    state.entries = [];
    for (const [group, records] of groups) {
      if (!records.length) continue;
      state.entries.push({ group, count: records.length });
      for (const record of records) state.entries.push({ group, record });
    }
    state.rendered = 0;
    list.replaceChildren();
    const total = state.records.length - state.removed.size;
    countEl.textContent = query ? plural(matches.length, 'result') : total ? plural(total, 'archived tab') : '';

    if (!total) {
      list.append(el('div', { class: 'empty' },
        el('h2', { text: 'Nothing archived yet' }),
        el('p', { text: `Tabs you haven’t used for ${thresholdLabel(state.settings)} are closed and saved here, each with a one-line summary, so you can find them again by searching.` })));
    } else if (!matches.length) {
      list.append(el('div', { class: 'empty' },
        el('h2', { text: 'No matches' }),
        el('p', { text: `No archived tab matches “${query}”. Try fewer or shorter words.` })));
    } else {
      do renderMore(); while (state.rendered < minRendered && state.rendered < state.entries.length);
    }
  }

  function renderMore() {
    sentinel.remove();
    const fragment = document.createDocumentFragment();
    const end = Math.min(state.entries.length, state.rendered + PAGE_SIZE);
    for (let i = state.rendered; i < end; i++) {
      const entry = state.entries[i];
      fragment.append(entry.record
        ? rowFor(entry.record, entry.group)
        : el('h2', { class: 'group-title' }, entry.group, el('span', { class: 'group-count', text: entry.count.toLocaleString() })));
    }
    state.rendered = end;
    list.append(fragment);
    if (end < state.entries.length) {
      list.append(sentinel);
      observer.observe(sentinel);
    }
  }

  async function removeFromView(id) {
    state.removed.add(id);
    const y = window.scrollY;
    render(state.rendered);
    window.scrollTo(0, y);
    ownVersion = await notifyArchiveChanged();
  }

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const id = button.closest('.row').dataset.id;
    const record = state.records.find((r) => r.id === id);
    if (!record) return;

    if (button.dataset.act === 'restore') {
      button.disabled = true;
      try {
        await chrome.tabs.create({ url: record.url, active: false });
      } catch {
        button.disabled = false;
        toast('Could not reopen this tab.');
        return;
      }
      await ArchiveDB.remove(id); // restoring removes the record (MVP)
      await removeFromView(id);
      toast(`Reopened “${clip(record.title || record.url, 60)}” in a new tab.`);
    } else if (button.dataset.act === 'delete') {
      if (!armConfirm(button, 'Confirm delete')) return;
      disarm(button);
      await ArchiveDB.remove(id);
      await removeFromView(id);
      toast('Deleted from the archive.');
    }
  });

  let typing = 0;
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => { state.query = input.value; render(); window.scrollTo(0, 0); }, 150);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== input) { event.preventDefault(); input.focus(); }
    if (event.key === 'Escape' && document.activeElement === input && input.value) { input.value = ''; state.query = ''; render(); }
  });

  onArchiveChanged((version) => { if (version !== ownVersion) load(); });

  await load();
  runQueuedSummaries(state.settings);
}

// ---- Settings page

async function initOptions() {
  let settings = await loadSettings();
  const status = $('#save-status');

  async function save(patch) {
    settings = await saveSettings(patch);
    status.textContent = 'Saved';
    status.classList.add('show');
    clearTimeout(save.timer);
    save.timer = setTimeout(() => status.classList.remove('show'), 1500);
  }

  for (const radio of document.querySelectorAll('input[name="threshold"]')) {
    radio.checked = Number(radio.value) === settings.thresholdHours;
    radio.addEventListener('change', () => { if (radio.checked) save({ thresholdHours: Number(radio.value) }); });
  }

  const domainList = $('#domains');
  const renderDomains = () => protectedChips(domainList, settings.protectedDomains, async (domain) => {
    await save({ protectedDomains: settings.protectedDomains.filter((d) => d !== domain) });
    renderDomains();
  });
  renderDomains();
  $('#domain-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const next = await addProtectedDomain($('#domain-input'), $('#domain-error'), settings);
    if (next) { await save({ protectedDomains: next }); renderDomains(); }
  });

  const summaries = $('#summaries');
  summaries.checked = settings.summariesEnabled;
  summaries.addEventListener('change', () => save({ summariesEnabled: summaries.checked }));

  const notify = $('#notify');
  notify.checked = settings.notify;
  notify.addEventListener('change', () => save({ notify: notify.checked }));

  setupSummarizerStatus();

  const showCount = async () => {
    const n = await ArchiveDB.count();
    $('#data-count').textContent = n ? `${plural(n, 'tab')} in the archive.` : 'The archive is empty.';
  };
  showCount();
  onArchiveChanged(showCount);

  $('#export').addEventListener('click', exportArchive);
  const clearButton = $('#clear');
  clearButton.addEventListener('click', async () => {
    if (!armConfirm(clearButton, 'Click again to delete everything')) return;
    disarm(clearButton);
    await ArchiveDB.clear();
    await notifyArchiveChanged();
    await showCount();
    toast('The archive is now empty.');
  });

  const showDev = () => {
    if (location.hash !== '#dev') return;
    $('#dev').hidden = false;
    const fast = $('#fast');
    fast.checked = settings.devFastMode;
    fast.onchange = () => save({ devFastMode: fast.checked });
  };
  showDev();
  window.addEventListener('hashchange', showDev);

  $('#version').textContent = 'v' + VERSION;
  runQueuedSummaries(settings);
}

async function setupSummarizerStatus() {
  const text = $('#ai-status');
  const button = $('#ai-download');
  const bar = $('#ai-progress');
  const show = (message, withButton = false) => { text.textContent = message; button.hidden = !withButton; };
  const availability = await summarizerAvailability();

  if (availability === 'no-api') {
    return show('This version of Chrome has no on-device summarizer (it needs Chrome 138 or later on a computer). Summaries use the page’s own description or first sentence instead.');
  }
  if (availability === 'available') return show('On-device AI summaries are ready. Pages are summarized on this computer and no text leaves it.');
  if (availability === 'unavailable') {
    return show('This computer can’t run Chrome’s on-device AI model (it needs enough free disk space and a capable graphics card or processor). Summaries use the page’s own description or first sentence instead.');
  }
  show(availability === 'downloading'
    ? 'Chrome is downloading its on-device AI model.'
    : 'AI summaries need a one-time download of Chrome’s on-device model. Until then, summaries use the page’s own description or first sentence.', true);
  button.textContent = availability === 'downloading' ? 'Show progress' : 'Download model';
  button.addEventListener('click', async () => {
    button.disabled = true;
    bar.hidden = false;
    try {
      const summarizer = await Summarizer.create({
        ...summarizerOptions('en'),
        monitor(m) { m.addEventListener('downloadprogress', (e) => { bar.value = e.loaded; }); },
      });
      summarizer.destroy();
      bar.hidden = true;
      show('On-device AI summaries are ready. Archived tabs are being summarized now.');
      processSummaryQueue({ canMarkFallback: true });
    } catch {
      button.disabled = false;
      bar.hidden = true;
      show('The download didn’t start. Check that there is enough free disk space, then try again.', true);
    }
  });
}

async function exportArchive() {
  const records = (await ArchiveDB.all())
    .sort((a, b) => b.archivedAt - a.archivedAt)
    .map(({ pendingText, ...record }) => record);
  const json = JSON.stringify({ app: 'Tab Graveyard', version: VERSION, exportedAt: new Date().toISOString(), records }, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = el('a', { href: url, download: `tab-graveyard-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`Exported ${plural(records.length, 'tab')}.`);
}

// ---- Onboarding

async function initOnboarding() {
  let settings = await loadSettings();
  for (const node of document.querySelectorAll('[data-threshold]')) node.textContent = thresholdLabel(settings);
  const list = $('#protected-list');
  protectedChips(list, settings.protectedDomains);

  $('#bank-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const next = await addProtectedDomain($('#bank-input'), $('#bank-error'), settings);
    if (!next) return;
    settings = { ...settings, protectedDomains: next };
    protectedChips(list, next);
  });

  $('#done').addEventListener('click', async () => {
    const tab = await chrome.tabs.getCurrent();
    if (tab) chrome.tabs.remove(tab.id); else window.close();
  });
}

// ---- Offscreen page (only chrome.runtime is available here)

async function initOffscreen() {
  try {
    await processSummaryQueue({ canMarkFallback: false });
  } finally {
    chrome.runtime.sendMessage({ type: 'summariesFinished' }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 10. Build: manifest, HTML, CSS, icons
// ---------------------------------------------------------------------------

function nodeRequire(name) {
  return typeof require === 'function' ? require(name) : process.getBuiltinModule(name);
}

function selfPath() {
  return typeof __filename === 'string' ? __filename : nodeRequire('path').resolve(process.argv[1]);
}

const MANIFEST = {
  manifest_version: 3,
  name: 'Tab Graveyard',
  version: VERSION,
  description: 'Closes tabs you haven’t used in days and saves each one to a searchable archive with a one-line summary.',
  minimum_chrome_version: '116',
  icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  action: {
    default_title: 'Tab Graveyard',
    default_popup: 'popup.html',
    default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png' },
  },
  background: { service_worker: 'graveyard.js' },
  options_ui: { page: 'options.html', open_in_tab: true },
  permissions: ['tabs', 'storage', 'unlimitedStorage', 'alarms', 'scripting', 'notifications', 'offscreen'],
  host_permissions: ['<all_urls>'],
  incognito: 'not_allowed',
};

function htmlPage(title, page, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="icons/icon32.png">
<link rel="stylesheet" href="graveyard.css">
</head>
<body${page ? ` data-page="${page}"` : ''}${page === 'popup' ? ' class="popup"' : ''}>
${body.trim()}
${page ? '<script src="graveyard.js"></script>\n' : ''}</body>
</html>
`;
}

const BRAND = '<a class="brand" href="archive.html"><img src="icons/icon48.png" width="26" height="26" alt=""><span>Tab Graveyard</span></a>';

function buildPages() {
  const thresholdOptions = THRESHOLD_CHOICES
    .map((h) => `<label><input type="radio" name="threshold" value="${h}"><span>${h / 24} ${h === 24 ? 'day' : 'days'}</span></label>`)
    .join('\n        ');

  return {
    'popup.html': htmlPage('Tab Graveyard', 'popup', `
<header class="popup-head">
  <img src="icons/icon32.png" width="22" height="22" alt="">
  <span>Tab Graveyard</span>
</header>
<div class="stats">
  <div class="stat"><span class="stat-num" id="open-count">–</span><span class="stat-label">open tabs</span></div>
  <div class="stat"><span class="stat-num" id="archived-count">–</span><span class="stat-label">in the archive</span></div>
</div>
<p class="popup-hint" id="stale-hint">&nbsp;</p>
<button type="button" class="btn btn-primary btn-block" id="sweep-now">Archive stale tabs now</button>
<p class="popup-result" id="sweep-result" role="status" aria-live="polite"></p>
<label class="setting setting-compact">
  <span class="setting-text"><span class="setting-title">Pause for 24 hours</span><span class="setting-sub" id="pause-sub">Stops all automatic closing for a day</span></span>
  <input type="checkbox" class="switch" id="pause">
</label>
<p class="ai-hint" id="ai-hint" hidden>AI summaries need a one-time model download. <a href="options.html" id="ai-setup">Set up</a></p>
<nav class="popup-links">
  <a href="archive.html" id="open-archive">Open archive</a>
  <a href="options.html" id="open-settings">Settings</a>
</nav>`),

    'archive.html': htmlPage('Archive · Tab Graveyard', 'archive', `
<div class="page">
  <header class="topbar">
    ${BRAND}
    <a class="topbar-link" href="options.html">Settings</a>
  </header>
  <div class="search">
    <svg class="search-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.75" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m13 13 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    <input id="q" type="search" placeholder="Search by title, summary or site" autocomplete="off" spellcheck="false" autofocus aria-label="Search the archive">
    <kbd class="search-kbd">/</kbd>
  </div>
  <p class="results-count" id="count" aria-live="polite"></p>
  <main id="results"></main>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>`),

    'options.html': htmlPage('Settings · Tab Graveyard', 'options', `
<div class="page page-narrow">
  <header class="topbar">
    ${BRAND}
    <span class="save-status" id="save-status" role="status" aria-live="polite"></span>
  </header>
  <h1 class="page-title">Settings</h1>

  <section class="panel">
    <h2>Close tabs after</h2>
    <p class="panel-sub">A tab is archived when you haven’t switched to it for this long. Time when the computer is asleep or Chrome is closed doesn’t count.</p>
    <div class="seg" role="radiogroup" aria-label="Close tabs after">
        ${thresholdOptions}
    </div>
  </section>

  <section class="panel">
    <h2>Protected sites</h2>
    <p class="panel-sub">Tabs on these sites and their subdomains are never closed. Pinned tabs, tabs playing audio and the tab in front are always kept too.</p>
    <ul class="chips" id="domains"></ul>
    <form class="inline-form" id="domain-form" novalidate>
      <input type="text" id="domain-input" placeholder="mybank.com" autocomplete="off" spellcheck="false" aria-label="Site to protect">
      <button class="btn" type="submit">Add</button>
    </form>
    <p class="field-error" id="domain-error" role="alert"></p>
  </section>

  <section class="panel">
    <h2>Summaries</h2>
    <label class="setting">
      <span class="setting-text"><span class="setting-title">One-line AI summaries</span><span class="setting-sub">Made by Chrome’s built-in model on this computer.</span></span>
      <input type="checkbox" class="switch" id="summaries">
    </label>
    <div class="ai-box">
      <p id="ai-status">Checking whether this computer can make AI summaries…</p>
      <progress id="ai-progress" max="1" value="0" hidden></progress>
      <button class="btn" type="button" id="ai-download" hidden>Download model</button>
    </div>
  </section>

  <section class="panel">
    <h2>Notifications</h2>
    <label class="setting">
      <span class="setting-text"><span class="setting-title">Tell me when tabs are archived</span><span class="setting-sub">One notification per clean-up, never one per tab.</span></span>
      <input type="checkbox" class="switch" id="notify">
    </label>
  </section>

  <section class="panel">
    <h2>Your data</h2>
    <p class="panel-sub"><span id="data-count">&nbsp;</span> Everything is stored in this browser only.</p>
    <div class="btn-row">
      <button class="btn" type="button" id="export">Export archive</button>
      <button class="btn btn-quiet-danger" type="button" id="clear">Clear archive</button>
    </div>
  </section>

  <section class="panel panel-dev" id="dev" hidden>
    <h2>Developer</h2>
    <label class="setting">
      <span class="setting-text"><span class="setting-title">Fast testing mode</span><span class="setting-sub">Tabs count as stale after 2 minutes and the sweep runs every minute.</span></span>
      <input type="checkbox" class="switch" id="fast">
    </label>
  </section>

  <footer class="foot">Tab Graveyard <span id="version"></span> · <a href="privacy.html">Privacy</a></footer>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>`),

    'onboarding.html': htmlPage('Welcome · Tab Graveyard', 'onboarding', `
<div class="page page-narrow onboarding">
  <header class="onb-head">
    <img src="icons/icon128.png" width="64" height="64" alt="">
    <h1>Close tabs without fear</h1>
    <p class="lead">Tab Graveyard closes the tabs you’ve stopped using and keeps every one in an archive you can search.</p>
  </header>
  <ol class="cards">
    <li class="card">
      <span class="card-step">1</span>
      <h2>What it does</h2>
      <p>Every 30 minutes it looks for tabs you haven’t switched to in <strong data-threshold>3 days</strong>. Each one is saved with its title, address and a one-line summary, then closed. The clock starts now, so nothing closes for at least <span data-threshold>3 days</span>.</p>
      <p>To get a tab back, open the archive from the toolbar icon, type a word you remember and click <strong>Restore</strong>.</p>
    </li>
    <li class="card">
      <span class="card-step">2</span>
      <h2>What is protected</h2>
      <p>Pinned tabs, tabs playing audio, the tab you’re looking at and the last tab in a window are never closed. Neither are tabs on these sites:</p>
      <ul class="chips" id="protected-list"></ul>
      <form class="inline-form" id="bank-form" novalidate>
        <input type="text" id="bank-input" placeholder="Add your online bank, e.g. mybank.com" autocomplete="off" spellcheck="false" aria-label="Site to protect">
        <button class="btn" type="submit">Protect</button>
      </form>
      <p class="field-error" id="bank-error" role="alert"></p>
      <p class="note">A half-written post or unsaved form can’t be detected. Pin those tabs, or protect sites where you write long text.</p>
    </li>
    <li class="card">
      <span class="card-step">3</span>
      <h2>Everything stays on your device</h2>
      <p>There is no server, no account and no analytics. Summaries are made by Chrome’s on-device AI when your computer supports it; page text is never sent anywhere. Incognito windows are never touched.</p>
    </li>
  </ol>
  <div class="onb-actions">
    <button class="btn btn-primary" id="done" type="button">Got it</button>
    <a href="options.html">Open settings</a>
  </div>
</div>`),

    'offscreen.html': htmlPage('Tab Graveyard summaries', 'offscreen', ''),

    'privacy.html': htmlPage('Privacy · Tab Graveyard', null, `
<div class="page page-narrow prose">
  <header class="topbar">${BRAND}</header>
  <h1>Privacy policy</h1>
  <p class="muted">Last updated 23 November 2026</p>
  <p><strong>Tab Graveyard keeps everything on your computer.</strong> It has no server, no account and no analytics, and it never sends the content of the pages you visit anywhere.</p>
  <h2>What it reads</h2>
  <ul>
    <li>The address, title and icon of your open tabs, and when you last switched to each one. This is how it knows which tabs are stale.</li>
    <li>The readable text of a tab, just before closing it. The text is used to write a one-line summary and to make the archive searchable.</li>
  </ul>
  <h2>Where it is stored</h2>
  <ul>
    <li>In this browser’s extension storage and IndexedDB, on this device only. At most about 2,000 characters of text are kept for each archived tab.</li>
    <li>Nothing is synced to other devices.</li>
  </ul>
  <h2>Summaries</h2>
  <p>Summaries are made by Chrome’s built-in on-device model when the computer supports it. Otherwise the page’s own description or first sentence is used. Page text is never sent to a server.</p>
  <h2>Network requests</h2>
  <p>When a tab is archived, the extension downloads that site’s small icon (favicon) once, without cookies, so the archive can show it later without loading anything. It makes no other requests.</p>
  <h2>Incognito</h2>
  <p>The extension cannot run in incognito windows, so those tabs are never tracked or archived.</p>
  <h2>Your control</h2>
  <p>You can export or permanently delete the whole archive at any time in Settings. Removing the extension deletes all of its data.</p>
  <h2>Permissions</h2>
  <ul>
    <li><strong>Tabs</strong>: read tab addresses and titles, close stale tabs and reopen archived ones.</li>
    <li><strong>Storage and unlimited storage</strong>: keep your settings and an archive of any size.</li>
    <li><strong>Alarms</strong>: check for stale tabs every 30 minutes.</li>
    <li><strong>Scripting and access to all sites</strong>: read a page’s text just before it is closed, for the summary and search.</li>
    <li><strong>Notifications</strong>: say how many tabs were archived.</li>
    <li><strong>Offscreen</strong>: make summaries in a hidden page.</li>
  </ul>
  <h2>Contact</h2>
  <p>Add a contact email address here before publishing.</p>
</div>`),
  };
}

const CSS = `*, *::before, *::after { box-sizing: border-box; }

:root {
  color-scheme: light;
  --bg: #f6f5f1;
  --surface: #ffffff;
  --surface-2: #efede7;
  --text: #1b1d1a;
  --muted: #5f645c;
  --faint: #878b83;
  --border: #e2dfd6;
  --border-strong: #cdc9be;
  --accent: #2f5a40;
  --accent-hover: #244833;
  --accent-ink: #ffffff;
  --accent-soft: #e1eae3;
  --danger: #a8382b;
  --shadow: 0 1px 2px rgb(20 24 20 / 0.05), 0 6px 20px rgb(20 24 20 / 0.06);
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #121412;
    --surface: #1b1e1b;
    --surface-2: #242824;
    --text: #e8eae5;
    --muted: #a3a89e;
    --faint: #7e8379;
    --border: #2c302b;
    --border-strong: #3c413a;
    --accent: #8cc29b;
    --accent-hover: #a5d2b2;
    --accent-ink: #0e1a12;
    --accent-soft: #1f3326;
    --danger: #ec8a78;
    --shadow: 0 1px 2px rgb(0 0 0 / 0.3), 0 6px 20px rgb(0 0 0 / 0.25);
  }
}

html { background: var(--bg); }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, p { margin: 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[hidden] { display: none !important; }
.muted { color: var(--muted); }

/* Buttons */
.btn {
  appearance: none;
  display: inline-flex; align-items: center; justify-content: center;
  height: 34px; padding: 0 14px;
  border: 1px solid var(--border-strong); border-radius: 8px;
  background: var(--surface); color: var(--text);
  font: inherit; font-weight: 550; white-space: nowrap; cursor: pointer;
  transition: background-color 0.12s, border-color 0.12s, color 0.12s;
}
.btn:hover { background: var(--surface-2); }
.btn:disabled { opacity: 0.55; cursor: default; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn-primary:disabled:hover { background: var(--accent); }
.btn-block { width: 100%; height: 38px; }
.btn-sm { height: 28px; padding: 0 10px; font-size: 13px; }
.btn-quiet { border-color: transparent; background: transparent; color: var(--muted); }
.btn-quiet:hover { background: var(--surface-2); color: var(--text); }
.btn-quiet-danger { color: var(--danger); }
.btn.btn-danger, .btn.btn-danger:hover { background: var(--danger); border-color: var(--danger); color: var(--surface); }
.btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }

/* Switch */
.switch {
  appearance: none; flex: none; position: relative;
  width: 36px; height: 20px; margin: 0;
  border-radius: 999px; background: var(--border-strong);
  cursor: pointer; transition: background-color 0.15s;
}
.switch::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
  transition: transform 0.15s;
}
.switch:checked { background: var(--accent); }
.switch:checked::after { transform: translateX(16px); }
.switch:focus-visible { outline-offset: 3px; }

.setting { display: flex; align-items: center; justify-content: space-between; gap: 16px; cursor: pointer; }
.setting-text { display: flex; flex-direction: column; gap: 1px; }
.setting-title { font-weight: 600; }
.setting-sub { color: var(--muted); font-size: 12.5px; }

/* Page layout */
.page { max-width: 860px; margin: 0 auto; padding: 28px 24px 80px; }
.page-narrow { max-width: 680px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--text); font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
.brand:hover { text-decoration: none; }
.topbar-link { color: var(--muted); font-weight: 550; }

/* Search */
.search { position: relative; display: flex; align-items: center; }
.search-icon { position: absolute; left: 15px; width: 18px; height: 18px; color: var(--faint); pointer-events: none; }
.search input {
  width: 100%; height: 48px; padding: 0 44px 0 43px;
  border: 1px solid var(--border); border-radius: 12px;
  background: var(--surface); color: var(--text); box-shadow: var(--shadow);
  font: inherit; font-size: 15px;
}
.search input::placeholder { color: var(--faint); }
.search input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.search input::-webkit-search-cancel-button { display: none; }
.search-kbd {
  position: absolute; right: 12px; padding: 0 7px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2);
  color: var(--faint); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.search input:focus + .search-kbd { display: none; }
.results-count { min-height: 20px; margin: 14px 2px 0; color: var(--muted); font-size: 13px; }

/* Archive list */
.group-title {
  display: flex; align-items: baseline; gap: 8px; margin: 24px 2px 8px;
  color: var(--muted); font-size: 12px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase;
}
.group-count { color: var(--faint); font-weight: 500; letter-spacing: 0; }
.row {
  display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: start; gap: 14px;
  padding: 14px 16px; background: var(--surface);
  border: 1px solid var(--border); border-radius: 12px;
}
.row + .row { margin-top: 8px; }
.row:hover { border-color: var(--border-strong); }
.fav { width: 20px; height: 20px; margin-top: 1px; border-radius: 4px; object-fit: contain; }
.fav-letter { display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); font-size: 11px; font-weight: 700; }
.row-title { overflow: hidden; font-size: 14.5px; font-weight: 600; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.row-summary {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  margin-top: 3px; color: var(--muted); font-size: 13.5px;
}
.tag {
  display: inline-block; padding: 0 5px; border-radius: 4px; vertical-align: 1px;
  background: var(--accent-soft); color: var(--accent); font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em;
}
.row-meta { display: flex; gap: 6px; min-width: 0; margin-top: 6px; color: var(--faint); font-size: 12.5px; }
.row-domain { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-meta time { flex: none; }
.row-actions { display: flex; gap: 4px; }
.sentinel { height: 1px; }
.empty { margin-top: 32px; padding: 40px 24px; border: 1px dashed var(--border-strong); border-radius: 14px; text-align: center; }
.empty h2 { margin-bottom: 6px; font-size: 16px; }
.empty p { max-width: 440px; margin: 0 auto; color: var(--muted); }

.toast {
  position: fixed; left: 50%; bottom: 24px; max-width: calc(100vw - 32px);
  padding: 10px 16px; border-radius: 10px; background: var(--text); color: var(--bg);
  box-shadow: var(--shadow); font-weight: 500;
  opacity: 0; pointer-events: none; transform: translate(-50%, 12px);
  transition: opacity 0.18s, transform 0.18s;
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }

/* Popup */
body.popup { width: 320px; padding: 16px; }
.popup-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; font-size: 15px; font-weight: 650; }
.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.stat { padding: 11px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.stat-num { display: block; font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; line-height: 1.15; }
.stat-label { color: var(--muted); font-size: 12.5px; }
.popup-hint { margin: 12px 2px 10px; color: var(--muted); font-size: 13px; }
.popup-result { margin: 8px 2px; color: var(--accent); font-size: 13px; font-weight: 550; }
.popup-result:empty { margin: 4px 0; }
.setting-compact { padding: 10px 2px; border-top: 1px solid var(--border); }
.ai-hint { margin: 2px 0 10px; padding: 8px 10px; border-radius: 8px; background: var(--accent-soft); font-size: 12.5px; }
.popup-links { display: flex; justify-content: space-between; padding: 10px 2px 0; border-top: 1px solid var(--border); font-size: 13px; font-weight: 600; }
.popup-links a + a { color: var(--muted); }

/* Settings */
.page-title { margin-bottom: 16px; font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
.panel { padding: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; }
.panel + .panel { margin-top: 12px; }
.panel h2 { font-size: 15px; font-weight: 650; }
.panel-sub { margin-top: 4px; color: var(--muted); font-size: 13.5px; }
.panel .setting { margin-top: 10px; }
.panel-dev { border-style: dashed; }
.seg { display: inline-flex; flex-wrap: wrap; gap: 2px; margin-top: 14px; padding: 3px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; }
.seg label { position: relative; }
.seg input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.seg span { display: block; padding: 6px 14px; border-radius: 7px; color: var(--muted); font-weight: 550; }
.seg input:checked + span { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.08), 0 0 0 1px var(--border); }
.seg input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 1px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0 0; padding: 0; list-style: none; }
.chip { display: inline-flex; align-items: center; gap: 2px; height: 30px; padding: 0 4px 0 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; font-size: 13px; font-weight: 500; }
.chip-static { padding-right: 12px; }
.chip-x { appearance: none; width: 24px; height: 24px; border: 0; border-radius: 50%; background: transparent; color: var(--faint); font-size: 16px; line-height: 1; cursor: pointer; }
.chip-x:hover { background: var(--border); color: var(--text); }
.inline-form { display: flex; gap: 8px; margin-top: 12px; }
.inline-form input { flex: 1; min-width: 0; height: 34px; padding: 0 12px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 8px; color: var(--text); font: inherit; }
.inline-form input::placeholder { color: var(--faint); }
.inline-form input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.field-error { margin-top: 6px; color: var(--danger); font-size: 13px; }
.field-error:empty { display: none; }
.ai-box { display: grid; justify-items: start; gap: 10px; margin-top: 14px; padding: 12px 14px; background: var(--surface-2); border-radius: 10px; color: var(--muted); font-size: 13px; }
.ai-box progress { width: 100%; accent-color: var(--accent); }
.save-status { color: var(--accent); font-size: 13px; font-weight: 600; opacity: 0; transition: opacity 0.2s; }
.save-status.show { opacity: 1; }
.foot { margin-top: 28px; color: var(--faint); font-size: 12.5px; text-align: center; }

/* Onboarding */
.onboarding { padding-top: 48px; }
.onb-head { margin-bottom: 28px; text-align: center; }
.onb-head img { margin-bottom: 14px; }
.onb-head h1 { font-size: 30px; font-weight: 750; letter-spacing: -0.025em; }
.lead { max-width: 480px; margin: 8px auto 0; color: var(--muted); font-size: 16px; }
.cards { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.card { position: relative; padding: 22px 22px 22px 64px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; }
.card-step { position: absolute; top: 22px; left: 22px; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-size: 13px; font-weight: 700; }
.card h2 { margin-bottom: 6px; font-size: 16px; font-weight: 650; }
.card p { color: var(--muted); }
.card p + p { margin-top: 8px; }
.card strong { color: var(--text); font-weight: 600; }
.card .note { margin-top: 12px; font-size: 12.5px; }
.onb-actions { display: flex; align-items: center; justify-content: center; gap: 18px; margin-top: 24px; }
.onb-actions .btn { height: 40px; padding: 0 24px; }

/* Privacy */
.prose h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
.prose h2 { margin: 24px 0 6px; font-size: 16px; font-weight: 650; }
.prose p, .prose li { color: var(--muted); }
.prose p + p { margin-top: 10px; }
.prose ul { margin: 0; padding-left: 20px; }
.prose li + li { margin-top: 4px; }
.prose strong { color: var(--text); font-weight: 600; }

@media (max-width: 560px) {
  .page { padding: 20px 16px 64px; }
  .row { grid-template-columns: 20px minmax(0, 1fr); }
  .row-actions { grid-column: 2; }
  .search-kbd { display: none; }
  .card { padding-left: 22px; }
  .card-step { position: static; margin-bottom: 10px; }
}
`;

// ---- Icons: a pale headstone on a moss-green tile, drawn with 4×4 supersampling.

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + r, Math.min(x, x1 - r));
    const cy = Math.max(y0 + r, Math.min(y, y1 - r));
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const moss = rgb('#2f5a40');
  const stone = rgb('#ece8dd');
  const ground = rgb('#c9c2b1');
  const layers = [
    [moss, (x, y) => inRoundRect(x, y, 0, 0, 1, 1, 0.22)],
    [stone, (x, y) => (x >= 0.3 && x <= 0.7 && y >= 0.4 && y <= 0.8) || (x - 0.5) ** 2 + (y - 0.4) ** 2 <= 0.2 ** 2],
    [ground, (x, y) => inRoundRect(x, y, 0.18, 0.77, 0.82, 0.85, 0.03)],
  ];
  if (size >= 48) {
    layers.push([moss, (x, y) => inRoundRect(x, y, 0.41, 0.45, 0.59, 0.49, 0.02) || inRoundRect(x, y, 0.41, 0.55, 0.59, 0.59, 0.02)]);
  }
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          let color = null;
          for (const [c, inside] of layers) if (inside(x, y)) color = c;
          if (color) { r += color[0]; g += color[1]; b += color[2]; hits++; }
        }
      }
      const i = (py * size + px) * 4;
      if (hits) {
        pixels[i] = Math.round(r / hits);
        pixels[i + 1] = Math.round(g / hits);
        pixels[i + 2] = Math.round(b / hits);
        pixels[i + 3] = Math.round((255 * hits) / (S * S));
      }
    }
  }
  return pixels;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodePNG(width, height, rgba) {
  const zlib = nodeRequire('zlib');
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function build(outDir) {
  const fs = nodeRequire('fs');
  const path = nodeRequire('path');
  const self = selfPath();
  const target = path.join(outDir, 'graveyard.js');
  if (path.resolve(target).toLowerCase() === path.resolve(self).toLowerCase()) {
    throw new Error('Choose an output folder other than the one holding Graveyard.js.');
  }
  fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });
  const write = (name, content) => fs.writeFileSync(path.join(outDir, name), content);
  write('manifest.json', JSON.stringify(MANIFEST, null, 2) + '\n');
  for (const [name, html] of Object.entries(buildPages())) write(name, html);
  write('graveyard.css', CSS);
  fs.copyFileSync(self, target);
  for (const size of [16, 32, 48, 128]) write(`icons/icon${size}.png`, encodePNG(size, size, renderIcon(size)));
  console.log(`Built Tab Graveyard ${VERSION} in ${outDir}

Load it in Chrome:
  1. Open chrome://extensions
  2. Turn on Developer mode (top right)
  3. Click "Load unpacked" and choose that folder

Fast testing mode: open the extension's settings and add #dev to the address.`);
}

function runNode(args) {
  const [command = 'build', folder] = args;
  if (command === 'test') return runTests();
  if (command !== 'build') {
    console.log('Usage: node Graveyard.js [build [folder] | test]');
    process.exitCode = 1;
    return;
  }
  const path = nodeRequire('path');
  build(path.resolve(folder || path.join(path.dirname(selfPath()), 'tab-graveyard')));
}

// ---------------------------------------------------------------------------
// 11. Tests  (node Graveyard.js test)
// ---------------------------------------------------------------------------

function fakeChrome(tabs, storage = {}) {
  const local = structuredClone(storage);
  const session = { ready: true };
  const removed = [];
  const area = (data) => ({
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
  });
  return {
    removed,
    local,
    runtime: { id: 'test', getURL: (p) => 'chrome-extension://test/' + p, lastError: null },
    storage: { local: area(local), session: area(session) },
    tabs: {
      async query(q = {}) {
        return tabs
          .filter((t) => (q.windowId == null || t.windowId === q.windowId) && (q.active == null || t.active === q.active))
          .map((t) => ({ ...t }));
      },
      async get(id) {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error('No tab with id ' + id);
        return { ...t };
      },
      async remove(id) {
        const i = tabs.findIndex((x) => x.id === id);
        if (i >= 0) tabs.splice(i, 1);
        removed.push(id);
      },
    },
    windows: { async getLastFocused() { return { id: 1, focused: false }; } },
    scripting: {
      async executeScript() {
        return [{ result: { title: '', description: '', lang: 'en', text: 'Markets\nDelta Air Lines said on Tuesday that its jet fuel bill rose sharply in 2023 as prices climbed. ' + 'Analysts expect costs to stay high next year. '.repeat(6) } }];
      },
    },
    notifications: { create() {} },
    alarms: { async get() { return null; }, async create() {} },
  };
}

function fakeArchiveDB() {
  const rows = new Map();
  const state = { fail: false };
  return {
    rows,
    state,
    methods: {
      async upsert(record) {
        if (state.fail) throw new Error('disk full');
        const existing = [...rows.values()].find((r) => r.url === record.url);
        const saved = existing ? { ...existing, ...record, id: existing.id } : record;
        rows.set(saved.id, saved);
        return saved;
      },
      async update(id, patch) { if (rows.has(id)) rows.set(id, { ...rows.get(id), ...patch }); return rows.has(id); },
      async pending(limit = Infinity) { return [...rows.values()].filter((r) => r.summarySource === 'pending').slice(0, limit); },
      async all() { return [...rows.values()]; },
      async count() { return rows.size; },
      async remove(id) { rows.delete(id); },
      async clear() { rows.clear(); },
    },
  };
}

async function runTests() {
  const assert = nodeRequire('assert/strict');
  let passed = 0;
  let failed = 0;
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log('  ✓ ' + name);
    } catch (err) {
      failed++;
      console.log('  ✗ ' + name + '\n      ' + String((err && err.stack) || err).split('\n').slice(0, 3).join('\n      '));
    }
  };

  const now = Date.UTC(2026, 10, 23, 12);
  const settings = { ...DEFAULT_SETTINGS };
  const tab = (over = {}) => ({ id: 1, windowId: 1, url: 'https://example.com/a', title: 'A', active: false, pinned: false, audible: false, incognito: false, ...over });
  const ctx = (activity, over = {}) => ({ now, thresholdMs: 72 * HOUR, settings, activity, ...over });
  const stale = { 1: { url: 'https://example.com/a', lastUsed: now - 80 * HOUR } };

  console.log('\nRules: which tabs close');
  await test('a normal tab unused for longer than the threshold can be archived', () => {
    assert.equal(keepReason(tab(), ctx(stale)), null);
  });
  await test('a tab used within the threshold is kept', () => {
    assert.equal(keepReason(tab(), ctx({ 1: { lastUsed: now - 71 * HOUR } })), 'recently-used');
  });
  await test('active, pinned, audible and incognito tabs are kept', () => {
    assert.equal(keepReason(tab({ active: true }), ctx(stale)), 'active');
    assert.equal(keepReason(tab({ pinned: true }), ctx(stale)), 'pinned');
    assert.equal(keepReason(tab({ audible: true }), ctx(stale)), 'audible');
    assert.equal(keepReason(tab({ incognito: true }), ctx(stale)), 'incognito');
  });
  await test('protected domains and their subdomains are kept', () => {
    const s = { ...settings, protectedDomains: ['mybank.com', 'mail.google.com'] };
    assert.equal(keepReason(tab({ url: 'https://online.mybank.com/x' }), ctx(stale, { settings: s })), 'protected-domain');
    assert.equal(keepReason(tab({ url: 'https://www.mybank.com/' }), ctx(stale, { settings: s })), 'protected-domain');
    assert.equal(keepReason(tab({ url: 'https://mail.google.com/mail/u/0' }), ctx(stale, { settings: s })), 'protected-domain');
    assert.equal(keepReason(tab({ url: 'https://docs.google.com/d/1' }), ctx(stale, { settings: s })), null);
    assert.equal(keepReason(tab({ url: 'https://notmybank.com/' }), ctx(stale, { settings: s })), null);
  });
  await test('only http and https pages; never chrome://, extensions, files, the new tab page or the Web Store', () => {
    for (const url of ['chrome://settings', 'chrome://newtab/', 'chrome-extension://abc/archive.html', 'file:///Users/me/a.pdf', 'about:blank', 'https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/detail/x']) {
      assert.equal(keepReason(tab({ url }), ctx(stale)), 'not-a-web-page', url);
    }
    assert.equal(keepReason(tab({ url: 'http://example.com' }), ctx(stale)), null);
  });
  await test('nothing is archived while paused', () => {
    assert.equal(keepReason(tab(), ctx(stale, { settings: { ...settings, pausedUntil: now + HOUR } })), 'paused');
  });
  await test('a tab with no recorded activity is never archived', () => {
    assert.equal(keepReason(tab(), ctx({})), 'not-tracked');
  });
  await test('at most 20 per run, oldest first', () => {
    const tabs = [];
    const activity = {};
    for (let i = 1; i <= 30; i++) {
      tabs.push(tab({ id: i, url: `https://example.com/${i}` }));
      activity[i] = { lastUsed: now - (100 + i) * HOUR };
    }
    tabs.push(tab({ id: 99, active: true }));
    const picked = selectCandidates(tabs, ctx(activity));
    assert.equal(picked.length, 20);
    assert.equal(picked[0].id, 30);
    assert.equal(picked[19].id, 11);
  });
  await test('the last tab in a window is never closed', () => {
    const tabs = [tab({ id: 1, windowId: 1 }), tab({ id: 2, windowId: 2 }), tab({ id: 3, windowId: 2, url: 'https://example.com/b' })];
    const activity = { 1: { lastUsed: now - 90 * HOUR }, 2: { lastUsed: now - 90 * HOUR }, 3: { lastUsed: now - 80 * HOUR } };
    assert.deepEqual(selectCandidates(tabs, ctx(activity)).map((t) => t.id), [2]);
  });
  await test('protected domains are typed loosely and stored cleanly', () => {
    assert.equal(normalizeDomain('https://www.MyBank.com/login?x=1'), 'mybank.com');
    assert.equal(normalizeDomain('*.example.co.uk'), 'example.co.uk');
    assert.equal(normalizeDomain('docs.google.com:443'), 'docs.google.com');
    assert.equal(normalizeDomain('not a domain'), '');
    assert.equal(normalizeDomain(''), '');
  });

  console.log('\nSleep and restarts');
  await test('normal gaps between sweeps change nothing', () => {
    const a = { 1: { lastUsed: now - 5 * HOUR } };
    assert.equal(applySleepGap(a, now - 80 * MINUTE, now, 30 * MINUTE).shiftedBy, 0);
  });
  await test('a 10-hour sleep moves lastUsed forward by the missed time', () => {
    const a = { 1: { lastUsed: now - 11 * HOUR } };
    const { activity, shiftedBy } = applySleepGap(a, now - 10 * HOUR, now, 30 * MINUTE);
    assert.equal(shiftedBy, 10 * HOUR - 30 * MINUTE);
    assert.equal(activity[1].lastUsed, now - 11 * HOUR + shiftedBy);
  });
  await test('a tab used after waking is never pushed into the future', () => {
    const a = { 1: { lastUsed: now - MINUTE } };
    assert.equal(applySleepGap(a, now - 7 * DAY, now, 30 * MINUTE).activity[1].lastUsed, now);
  });
  await test('after a restart, lastUsed follows the URL to the new tab ID', () => {
    const old = { 5: { url: 'https://a.com/', lastUsed: now - 50 * HOUR }, 6: { url: 'https://b.com/', lastUsed: now - 2 * HOUR }, 7: { url: 'https://gone.com/', lastUsed: 1 } };
    const tabs = [{ id: 101, url: 'https://a.com/' }, { id: 102, url: 'https://b.com/' }, { id: 103, url: 'https://new.com/' }];
    const { activity, leftovers } = carryOverByUrl(old, tabs, now);
    assert.equal(activity[101].lastUsed, now - 50 * HOUR);
    assert.equal(activity[102].lastUsed, now - 2 * HOUR);
    assert.equal(activity[103].lastUsed, now);
    assert.deepEqual(leftovers, [{ url: 'https://gone.com/', lastUsed: 1 }]);
  });

  console.log('\nSummaries');
  await test('the fallback uses the meta description first', () => {
    assert.equal(fallbackSummary({ title: 'T', description: 'Article about Delta’s 2023 jet fuel costs.', text: 'Other text here.' }), 'Article about Delta’s 2023 jet fuel costs.');
  });
  await test('then the first real sentence, skipping menus and headings', () => {
    const text = 'Home\nNews\nDelta’s fuel bill rises\nDelta Air Lines said on Tuesday that its fuel bill rose 20% in 2023. Prices were high.';
    assert.equal(fallbackSummary({ title: 'T', text }), 'Delta Air Lines said on Tuesday that its fuel bill rose 20% in 2023.');
  });
  await test('then the title', () => {
    assert.equal(fallbackSummary({ title: 'Quarterly results', text: 'Login' }), 'Quarterly results');
    assert.equal(fallbackSummary({}), 'Untitled page');
  });
  await test('long summaries are clipped at a word boundary', () => {
    const s = fallbackSummary({ description: 'word '.repeat(80) });
    assert.ok(s.length <= FALLBACK_SUMMARY_CHARS && s.endsWith('…'));
  });
  await test('AI output becomes one short line', () => {
    assert.equal(oneLineSummary('* **Delta’s fuel costs rose in 2023.** Analysts expect more.'), 'Delta’s fuel costs rose in 2023.');
    assert.ok(oneLineSummary('x '.repeat(200)).length <= AI_SUMMARY_CHARS);
  });
  await test('archive days: Today, Yesterday, This week, Older', () => {
    const base = new Date(2026, 10, 23, 15).getTime();
    assert.equal(dayGroup(new Date(2026, 10, 23, 1).getTime(), base), 'Today');
    assert.equal(dayGroup(new Date(2026, 10, 22, 23).getTime(), base), 'Yesterday');
    assert.equal(dayGroup(new Date(2026, 10, 18, 9).getTime(), base), 'This week');
    assert.equal(dayGroup(new Date(2026, 10, 10).getTime(), base), 'Older');
  });

  console.log('\nSearch');
  const docs = [
    { id: 'a', title: 'Delta’s fuel bill rises in 2023', summary: 'Article about Delta’s 2023 jet fuel costs.', domain: 'example.com', textSnippet: 'Airlines face rising costs.', archivedAt: 3 },
    { id: 'b', title: 'Pasta recipes', summary: 'Ten quick dinners.', domain: 'food.example', textSnippet: 'Boil water, add salt.', archivedAt: 2 },
    { id: 'c', title: 'Rocket engines', summary: 'How jets and rockets differ.', domain: 'space.example', textSnippet: 'Kerosene fuel burns in liquid oxygen.', archivedAt: 1 },
  ];
  const idx = buildSearchIndex(docs);
  const ids = (q) => searchIndex(idx, q).map((h) => h.record.id);
  await test('“jet fu” finds the jet fuel tab first (prefix)', () => assert.deepEqual(ids('jet fu'), ['a', 'c']));
  await test('“jetfule” finds it too (typo, words run together)', () => assert.equal(ids('jetfule')[0], 'a'));
  await test('every word must match', () => assert.deepEqual(ids('pasta fuel'), []));
  await test('title matches rank above body text matches', () => assert.deepEqual(ids('fuel'), ['a', 'c']));
  await test('accents and case are ignored', () => assert.deepEqual(ids('PÂSTA'), ['b']));
  await test('5,000 records load and search in under a second', () => {
    const words = 'airline fuel market price rocket engine pasta dinner recipe budget travel hotel flight train ticket museum history science paper study school exam course lecture notes chart stock bond fund return risk yield growth value index option'.split(' ');
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const word = () => words[Math.floor(rand() * words.length)] + Math.floor(rand() * 400);
    const many = Array.from({ length: 5000 }, (_, i) => ({
      id: String(i), archivedAt: i,
      title: Array.from({ length: 8 }, word).join(' '),
      summary: Array.from({ length: 14 }, word).join(' '),
      domain: `site${i % 300}.com`,
      textSnippet: Array.from({ length: 300 }, word).join(' '),
    }));
    const t0 = performance.now();
    const big = buildSearchIndex(many);
    for (const q of ['fuel12', 'airline price', 'rocke', 'histroy33', 'site42']) searchIndex(big, q);
    const ms = performance.now() - t0;
    console.log(`      (index + 5 searches: ${Math.round(ms)} ms)`);
    assert.ok(ms < 1000, `${Math.round(ms)} ms`);
  });

  console.log('\nSweep, with a fake Chrome');
  const realDB = { ...ArchiveDB };
  const realChrome = globalThis.chrome;
  const runWith = async (tabs, storage, fn) => {
    const db = fakeArchiveDB();
    Object.assign(ArchiveDB, db.methods);
    globalThis.chrome = fakeChrome(tabs, storage);
    try {
      return await fn(db, globalThis.chrome);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 20)); // let background work (summaries) finish
      Object.assign(ArchiveDB, realDB);
      globalThis.chrome = realChrome;
    }
  };
  const quietly = async (fn) => {
    const error = console.error;
    console.error = () => {};
    try { return await fn(); } finally { console.error = error; }
  };
  const t = Date.now();
  const store = (activity, extra = {}) => ({ settings: { ...DEFAULT_SETTINGS, notify: false }, lastSweepAt: t - 10 * MINUTE, activity, ...extra });

  await test('stale tabs are saved, then closed; fresh, pinned and active tabs stay open', () => runWith(
    [
      tab({ id: 1, url: 'https://news.example.com/jet-fuel', title: 'Delta’s fuel bill rises' }),
      tab({ id: 2, url: 'https://example.org/fresh' }),
      tab({ id: 3, url: 'https://example.org/pinned', pinned: true }),
      tab({ id: 4, url: 'https://example.org/active', active: true }),
    ],
    store({ 1: { lastUsed: t - 80 * HOUR }, 2: { lastUsed: t - HOUR }, 3: { lastUsed: t - 99 * HOUR }, 4: { lastUsed: t - 99 * HOUR } }),
    async (db, fake) => {
      const res = await runSweep({ manual: true });
      assert.equal(res.archived, 1);
      assert.deepEqual(fake.removed, [1]);
      const [record] = db.rows.values();
      assert.equal(record.url, 'https://news.example.com/jet-fuel');
      assert.equal(record.domain, 'news.example.com');
      assert.match(record.summary, /^Delta Air Lines said on Tuesday/);
      assert.equal(record.summarySource, 'pending');
      assert.ok(record.textSnippet.length <= SNIPPET_CHARS);
    }));

  await test('a tab is never closed if its record could not be saved', () => runWith(
    [tab({ id: 1 }), tab({ id: 2, active: true })],
    store({ 1: { lastUsed: t - 80 * HOUR }, 2: { lastUsed: t } }),
    async (db, fake) => {
      db.state.fail = true;
      const res = await quietly(() => runSweep({ manual: true }));
      assert.equal(res.archived, 0);
      assert.deepEqual(fake.removed, []);
    }));

  await test('a week asleep does not count as inactivity', () => runWith(
    [tab({ id: 1 }), tab({ id: 2, active: true })],
    store({ 1: { lastUsed: t - 7 * DAY - 2 * HOUR }, 2: { lastUsed: t - 7 * DAY } }, { lastSweepAt: t - 7 * DAY }),
    async (db, fake) => {
      const res = await runSweep({ manual: false });
      assert.equal(res.archived, 0);
      assert.deepEqual(fake.removed, []);
    }));

  await test('pausing stops archiving', () => runWith(
    [tab({ id: 1 }), tab({ id: 2, active: true })],
    store({ 1: { lastUsed: t - 80 * HOUR }, 2: { lastUsed: t } }, { settings: { ...DEFAULT_SETTINGS, pausedUntil: t + DAY } }),
    async (db, fake) => {
      const res = await runSweep({ manual: false });
      assert.equal(res.paused, true);
      assert.deepEqual(fake.removed, []);
    }));

  await test('the same URL open twice becomes one record', () => runWith(
    [tab({ id: 1, url: 'https://example.com/same' }), tab({ id: 2, url: 'https://example.com/same' }), tab({ id: 3, active: true })],
    store({ 1: { lastUsed: t - 80 * HOUR }, 2: { lastUsed: t - 90 * HOUR }, 3: { lastUsed: t } }),
    async (db, fake) => {
      const res = await runSweep({ manual: true });
      assert.equal(res.archived, 2);
      assert.equal(db.rows.size, 1);
      assert.deepEqual(fake.removed.sort(), [1, 2]);
    }));

  await test('with summaries off, records keep the fallback summary', () => runWith(
    [tab({ id: 1 }), tab({ id: 2, active: true })],
    store({ 1: { lastUsed: t - 80 * HOUR }, 2: { lastUsed: t } }, { settings: { ...DEFAULT_SETTINGS, notify: false, summariesEnabled: false } }),
    async (db) => {
      await runSweep({ manual: true });
      const [record] = db.rows.values();
      assert.equal(record.summarySource, 'fallback');
      assert.equal(record.pendingText, '');
    }));

  await test('without the Summarizer API, pending records settle on the fallback', () => runWith([], {}, async (db) => {
    await db.methods.upsert({ id: 'x', url: 'https://x.com', summary: 'S', summarySource: 'pending', pendingText: 'long text '.repeat(40), lang: 'en', archivedAt: Date.now() });
    assert.equal(await processSummaryQueue({ canMarkFallback: true }), 'no-api');
    assert.equal(db.rows.get('x').summarySource, 'fallback');
    assert.equal(db.rows.get('x').pendingText, '');
  }));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 12. Boot: work out where this file is running
// ---------------------------------------------------------------------------

(function boot() {
  const inExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  if (!inExtension) {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) runNode(process.argv.slice(2));
    return;
  }
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
    startServiceWorker();
    return;
  }
  const pages = { popup: initPopup, archive: initArchive, options: initOptions, onboarding: initOnboarding, offscreen: initOffscreen };
  const start = document.body && pages[document.body.dataset.page];
  if (start) start().catch((err) => console.error('[Tab Graveyard]', err));
})();
