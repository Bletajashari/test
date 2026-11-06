#!/usr/bin/env node
/*
 * Flextrack translation sweep.
 *
 * Crawls a Flextrack environment once per locale, collects the visible UI
 * strings on each page, and flags:
 *   - raw-key        : translation keys shown instead of text (e.g. "label.worker.startDate", "???key???")
 *   - placeholder    : unrendered template tokens (e.g. "{{name}}", "${x}", "%s")
 *   - untranslated   : text identical to the base-locale text on the same page
 *
 * Read-only by design: it only follows <a href> links with GET navigation, never
 * clicks buttons or submits forms, and skips links that look destructive.
 * It does not capture table cell contents, input values or free text areas, so
 * worker / customer data shown in grids is not collected.
 *
 * Usage: node sweep.js --base-url https://env.example.com --locales fr-CA,es-US [options]
 * Run with --help for the full option list.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error('Playwright is not installed. Run:  npm install playwright && npx playwright install chromium');
  process.exit(2);
}

// ---------------------------------------------------------------- options
const DEFAULTS = {
  baseUrl: null,
  baseLocale: 'en-US',
  locales: [],
  localeMode: 'browser', // browser | query | cookie | path | none
  localeParam: 'lang',   // query param or cookie name for query/cookie modes
  localeValueMap: '',    // e.g. "fr-CA=fr,es-US=es" when the app uses its own codes
  startPaths: '/',
  pathsFile: null,
  maxPages: 150,
  maxDepth: 4,
  include: '',
  exclude: '(logout|log-out|signout|sign-out|logoff|delete|remove|destroy|terminate|approve|reject|cancel|submit|purge|reset|impersonat|download|export|\\.pdf$|\\.xlsx?$|\\.csv$|\\.zip$)',
  loginUrl: null,
  userSelector: 'input[type="email"], input[name*="user" i], input[id*="user" i], input[name*="login" i]',
  passSelector: 'input[type="password"]',
  submitSelector: 'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")',
  storageState: null,
  saveStorageState: null,
  ignoreFile: null,
  excludeSelector: '',
  minLength: 3,
  waitMs: 1500,
  timeoutMs: 30000,
  headful: false,
  out: './translation-sweep-out',
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const map = {
    '--base-url': 'baseUrl', '--base-locale': 'baseLocale', '--locales': 'locales',
    '--locale-mode': 'localeMode', '--locale-param': 'localeParam', '--locale-value-map': 'localeValueMap',
    '--start-paths': 'startPaths', '--paths-file': 'pathsFile', '--max-pages': 'maxPages', '--max-depth': 'maxDepth',
    '--include': 'include', '--exclude': 'exclude', '--login-url': 'loginUrl',
    '--user-selector': 'userSelector', '--pass-selector': 'passSelector', '--submit-selector': 'submitSelector',
    '--storage-state': 'storageState', '--save-storage-state': 'saveStorageState', '--ignore-file': 'ignoreFile',
    '--exclude-selector': 'excludeSelector', '--min-length': 'minLength', '--wait-ms': 'waitMs',
    '--timeout-ms': 'timeoutMs', '--out': 'out',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    if (a === '--headful') { opts.headful = true; continue; }
    const key = map[a];
    if (!key) { console.error(`Unknown option: ${a}`); printHelp(); process.exit(2); }
    opts[key] = argv[++i];
  }
  opts.locales = String(opts.locales || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const k of ['maxPages', 'maxDepth', 'minLength', 'waitMs', 'timeoutMs']) opts[k] = Number(opts[k]);
  opts.valueMap = Object.fromEntries(String(opts.localeValueMap || '').split(',').filter(Boolean).map(p => p.split('=').map(s => s.trim())));
  if (!opts.baseUrl) { console.error('--base-url is required'); process.exit(2); }
  if (!opts.locales.length) { console.error('--locales is required (comma separated, e.g. fr-CA,es-US)'); process.exit(2); }
  opts.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  return opts;
}

function printHelp() {
  console.log(`Flextrack translation sweep

Required
  --base-url URL            Environment root, e.g. https://qa.flextrack.example.com
  --locales LIST            Target locales to check, comma separated (e.g. fr-CA,es-US,de-DE)

Locale switching
  --base-locale CODE        Reference locale (default en-US)
  --locale-mode MODE        browser | query | cookie | path | none (default browser)
                              browser: sets the browser locale + Accept-Language
                              query:   appends ?<locale-param>=<code> to every URL
                              cookie:  sets cookie <locale-param>=<code>
                              path:    prefixes every path with /<code>
  --locale-param NAME       Query param / cookie name (default lang)
  --locale-value-map MAP    App-specific codes, e.g. "fr-CA=fr_CA,es-US=es"

Crawl scope
  --start-paths LIST        Comma separated start paths (default /)
  --paths-file FILE         File with one path per line (crawl only these, no link following)
  --max-pages N             Page limit per locale (default 150)
  --max-depth N             Link depth from start paths (default 4)
  --include REGEX           Only visit URLs matching this
  --exclude REGEX           Never visit URLs matching this (default skips logout/delete/approve/export...)
  --exclude-selector CSS    Extra elements whose text must not be collected

Authentication (credentials come from env FLEXTRACK_USER / FLEXTRACK_PASSWORD)
  --login-url URL           Login page; form login is attempted when credentials are set
  --user-selector CSS / --pass-selector CSS / --submit-selector CSS
  --storage-state FILE      Reuse a saved Playwright session instead of logging in (SSO)
  --save-storage-state FILE Save the session after login for reuse
  --headful                 Show the browser (use with --save-storage-state to log in by hand)

Detection
  --ignore-file FILE        Strings / regexes (/.../) that are allowed to stay untranslated
  --min-length N            Ignore strings shorter than this (default 3)

Output
  --out DIR                 Output folder (default ./translation-sweep-out)
  --wait-ms N               Extra settle time per page (default 1500)
  --timeout-ms N            Navigation timeout (default 30000)
`);
}

// ---------------------------------------------------------------- helpers
function loadIgnore(file) {
  const exact = new Set();
  const regexes = [];
  // Strings that are commonly identical across languages.
  const builtIn = ['OK', 'Flextrack', 'FlexTrack', 'Email', 'E-mail', 'ID', 'URL', 'PDF', 'CSV', 'Excel', 'API', 'SSO', 'N/A', 'Total', 'Status', 'Date', 'Info', 'Menu', 'Version'];
  builtIn.forEach(s => exact.add(s.toLowerCase()));
  if (file) {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^\/(.*)\/([a-z]*)$/);
      if (m) regexes.push(new RegExp(m[1], m[2])); else exact.add(line.toLowerCase());
    }
  }
  return s => exact.has(s.toLowerCase()) || regexes.some(r => r.test(s));
}

const RAW_KEY_PATTERNS = [
  { re: /^\?{2,}.+\?{2,}$/, why: '???key??? marker' },
  { re: /^\[\[?.+\]\]?$/, why: '[key] marker', guard: s => /[._]/.test(s) && !/\s/.test(s.slice(1, -1)) },
  { re: /^!{1,3}[^!\s]+!{1,3}$/, why: '!key! marker' },
  { re: /^#{1,2}[A-Za-z0-9_.-]+#{1,2}$/, why: '#key# marker' },
  { re: /(missing|untranslated)[ _-]?(translation|key|resource|label)/i, why: 'missing-translation text' },
  { re: /^translation missing/i, why: 'missing-translation text' },
  { re: /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_-]+){1,}$/, why: 'dotted resource key', guard: s => !/^[\w.-]+@/.test(s) && !/\.(com|net|org|io|ca|pdf|xlsx?|csv|docx?|png|jpe?g)$/i.test(s) && !/^\d/.test(s) && !/^v?\d+(\.\d+)+$/.test(s) },
  { re: /^[A-Z][A-Z0-9]*(_[A-Z0-9]+){1,}$/, why: 'CONSTANT_CASE key' },
  { re: /^(lbl|label|msg|message|txt|text|btn|button|err|error|title|hint|tooltip|res|resource|str)[_.][A-Za-z0-9_.]+$/i, why: 'prefixed resource key' },
  { re: /^[a-z]+(_[a-z0-9]+){2,}$/, why: 'snake_case key' },
];
const PLACEHOLDER_RE = /(\{\{\s*[\w.$]+\s*\}\}|\$\{\s*[\w.]+\s*\}|\{\d+\}|%[sd]\b|%\(\w+\)s|__[A-Z_]+__)/;

function classifyRaw(text) {
  for (const p of RAW_KEY_PATTERNS) {
    if (p.re.test(text) && (!p.guard || p.guard(text))) return p.why;
  }
  return null;
}

function hasLetters(s) { return /\p{L}{2,}/u.test(s); }
function looksLikeData(s) {
  return /^[\d\s.,:/$€£%+()-]+$/.test(s) // numbers, money, dates, phone
    || /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(s) // email
    || /^https?:\/\//i.test(s)
    || /^[A-Z]{2,}-?\d+$/.test(s); // ids like REQ-1234
}

function localeCode(opts, locale) { return opts.valueMap[locale] || locale; }

function localizeUrl(opts, url, locale) {
  const u = new URL(url);
  const code = localeCode(opts, locale);
  if (opts.localeMode === 'query') u.searchParams.set(opts.localeParam, code);
  if (opts.localeMode === 'path') {
    const segs = u.pathname.split('/').filter(Boolean);
    const known = new Set([opts.baseLocale, ...opts.locales].map(l => localeCode(opts, l).toLowerCase()));
    if (segs.length && known.has(segs[0].toLowerCase())) segs.shift();
    u.pathname = '/' + [code, ...segs].join('/');
  }
  return u.toString();
}

/** Normalised key for a page, independent of locale switching params. */
function pageKey(opts, url) {
  const u = new URL(url);
  u.hash = u.hash && u.hash.startsWith('#/') ? u.hash : '';
  if (opts.localeMode === 'query') u.searchParams.delete(opts.localeParam);
  if (opts.localeMode === 'path') {
    const segs = u.pathname.split('/').filter(Boolean);
    const known = new Set([opts.baseLocale, ...opts.locales].map(l => localeCode(opts, l).toLowerCase()));
    if (segs.length && known.has(segs[0].toLowerCase())) segs.shift();
    u.pathname = '/' + segs.join('/');
  }
  // Collapse numeric / guid ids so /worker/123 and /worker/456 count as one page type.
  u.pathname = u.pathname.replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f-]{27,})(?=\/|$)/gi, '/:id');
  [...u.searchParams.keys()].forEach(k => { if (/^\d+$|^[0-9a-f-]{36}$/i.test(u.searchParams.get(k))) u.searchParams.set(k, ':id'); });
  return u.pathname + (u.search || '') + u.hash;
}

// Runs in the page: collect visible UI strings, never data cells or input values.
function collectStrings(excludeSelector) {
  const SKIP = 'script,style,noscript,template,svg,code,pre,textarea,td,[contenteditable="true"],[data-no-translate],[translate="no"],.notranslate' + (excludeSelector ? ',' + excludeSelector : '');
  const out = [];
  const seen = new Set();
  const visible = el => {
    if (!el || !el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
  };
  const cssPath = el => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      let p = n.tagName.toLowerCase();
      if (n.id && !/\d{3,}/.test(n.id)) { parts.unshift(p + '#' + n.id); break; }
      const cls = [...n.classList].filter(c => !/\d{3,}|^ng-|^css-|^sc-/.test(c)).slice(0, 2);
      if (cls.length) p += '.' + cls.join('.');
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const push = (text, el, kind) => {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    const where = cssPath(el);
    const k = kind + '|' + where + '|' + t;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ text: t, kind, where });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest(SKIP) || !visible(el)) continue;
    push(n.nodeValue, el, 'text');
  }
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label],img[alt],input[type=button],input[type=submit],input[type=reset]')) {
    if (el.closest(SKIP)) continue;
    if (el.hasAttribute('placeholder')) push(el.getAttribute('placeholder'), el, 'placeholder');
    if (el.hasAttribute('title')) push(el.getAttribute('title'), el, 'title');
    if (el.hasAttribute('aria-label')) push(el.getAttribute('aria-label'), el, 'aria-label');
    if (el.tagName === 'IMG' && el.alt) push(el.alt, el, 'alt');
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/.test(el.type)) push(el.value, el, 'button');
  }
  for (const opt of document.querySelectorAll('select option')) {
    if (!opt.closest(SKIP)) push(opt.textContent, opt.parentElement, 'option');
  }
  return { title: document.title, lang: document.documentElement.lang || '', strings: out };
}

function collectLinks() {
  return [...document.querySelectorAll('a[href]')].map(a => a.href).filter(Boolean);
}

// ---------------------------------------------------------------- browser
async function newContext(browser, opts, locale) {
  const ctx = await browser.newContext({
    locale: opts.localeMode === 'browser' ? locale : opts.baseLocale,
    extraHTTPHeaders: opts.localeMode === 'browser' ? { 'Accept-Language': `${locale},${locale.split('-')[0]};q=0.9` } : {},
    storageState: opts.storageState && fs.existsSync(opts.storageState) ? opts.storageState : undefined,
    ignoreHTTPSErrors: false,
  });
  ctx.setDefaultNavigationTimeout(opts.timeoutMs);
  ctx.setDefaultTimeout(opts.timeoutMs);
  if (opts.localeMode === 'cookie') {
    const u = new URL(opts.baseUrl);
    await ctx.addCookies([{ name: opts.localeParam, value: localeCode(opts, locale), domain: u.hostname, path: '/' }]);
  }
  return ctx;
}

async function login(ctx, opts) {
  const user = process.env.FLEXTRACK_USER;
  const pass = process.env.FLEXTRACK_PASSWORD;
  const page = await ctx.newPage();
  const url = opts.loginUrl || opts.baseUrl;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (opts.headful && !user) {
    console.log('Log in in the opened browser window. The sweep continues once a password field is no longer shown (5 min max).');
    await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 300000 });
  } else if (user && pass) {
    const passField = page.locator(opts.passSelector).first();
    const userField = page.locator(opts.userSelector).first();
    if (await userField.count()) await userField.fill(user);
    // Two-step logins: username first, then password on the next screen.
    if (!(await passField.isVisible().catch(() => false))) {
      await page.locator(opts.submitSelector).first().click();
      await passField.waitFor({ state: 'visible' });
    }
    await passField.fill(pass);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.locator(opts.submitSelector).first().click(),
    ]);
    await page.waitForTimeout(opts.waitMs);
    if (await page.locator(opts.passSelector).first().isVisible().catch(() => false)) {
      throw new Error('Login appears to have failed (password field still visible). Check credentials/selectors, or use --headful --save-storage-state for SSO.');
    }
  }
  if (opts.saveStorageState) {
    await ctx.storageState({ path: opts.saveStorageState });
    console.log(`Saved session to ${opts.saveStorageState}`);
  }
  await page.close();
}

async function crawl(browser, opts, locale, seedPages) {
  const ctx = await newContext(browser, opts, locale);
  if (!opts.storageState || !fs.existsSync(opts.storageState)) await login(ctx, opts);
  const page = await ctx.newPage();
  const include = opts.include ? new RegExp(opts.include, 'i') : null;
  const exclude = opts.exclude ? new RegExp(opts.exclude, 'i') : null;
  const origin = new URL(opts.baseUrl).origin;
  const results = new Map(); // pageKey -> {url, title, lang, strings}
  const errors = [];
  const queue = seedPages.map(u => ({ url: u, depth: 0 }));
  const queued = new Set(seedPages.map(u => pageKey(opts, u)));
  const followLinks = !opts.pathsFile && !seedPages.fixed;

  while (queue.length && results.size < opts.maxPages) {
    const { url, depth } = queue.shift();
    const key = pageKey(opts, url);
    try {
      const resp = await page.goto(localizeUrl(opts, url, locale), { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(opts.waitMs);
      if (resp && resp.status() >= 400) errors.push({ url, status: resp.status() });
      const data = await page.evaluate(collectStrings, opts.excludeSelector);
      results.set(key, { url, ...data });
      process.stdout.write(`[${locale}] ${results.size}/${opts.maxPages} ${key} (${data.strings.length} strings)\n`);
      if (followLinks && depth < opts.maxDepth) {
        for (const href of await page.evaluate(collectLinks)) {
          let u;
          try { u = new URL(href); } catch { continue; }
          if (u.origin !== origin || !/^https?:$/.test(u.protocol)) continue;
          const s = u.toString();
          if (exclude && exclude.test(s)) continue;
          if (include && !include.test(s)) continue;
          const k = pageKey(opts, s);
          if (queued.has(k)) continue;
          queued.add(k);
          queue.push({ url: s, depth: depth + 1 });
        }
      }
    } catch (e) {
      errors.push({ url, error: e.message.split('\n')[0] });
    }
  }
  await ctx.close();
  return { results, errors };
}

// ---------------------------------------------------------------- analysis
function analyse(opts, base, targets, ignored) {
  const findings = [];
  const baseByPage = base.results;
  // Global base-language vocabulary, for "mixed" detection on pages the base crawl reached.
  for (const [locale, { results }] of Object.entries(targets)) {
    for (const [key, tgt] of results) {
      const ref = baseByPage.get(key);
      const refTexts = new Set(ref ? ref.strings.map(s => s.text) : []);
      const refByWhere = new Map();
      if (ref) for (const s of ref.strings) refByWhere.set(s.kind + '|' + s.where, (refByWhere.get(s.kind + '|' + s.where) || new Set()).add(s.text));
      for (const s of tgt.strings) {
        const t = s.text;
        if (t.length < opts.minLength || ignored(t)) continue;
        const raw = classifyRaw(t);
        if (raw) { findings.push({ locale, page: key, url: tgt.url, type: 'raw-key', reason: raw, ...s }); continue; }
        if (PLACEHOLDER_RE.test(t)) { findings.push({ locale, page: key, url: tgt.url, type: 'placeholder', reason: 'unrendered template token', ...s }); continue; }
        if (!ref || !hasLetters(t) || looksLikeData(t)) continue;
        const sameSpot = refByWhere.get(s.kind + '|' + s.where);
        if (sameSpot && sameSpot.has(t)) {
          findings.push({ locale, page: key, url: tgt.url, type: 'untranslated', reason: 'identical to ' + opts.baseLocale + ' at same element', ...s });
        } else if (refTexts.has(t) && t.split(' ').length >= 2) {
          findings.push({ locale, page: key, url: tgt.url, type: 'untranslated', reason: 'identical to ' + opts.baseLocale + ' text on page', confidence: 'medium', ...s });
        }
      }
    }
  }
  // Raw keys can also be missing in the base locale itself.
  for (const [key, pg] of baseByPage) {
    for (const s of pg.strings) {
      if (s.text.length < opts.minLength || ignored(s.text)) continue;
      const raw = classifyRaw(s.text);
      if (raw) findings.push({ locale: opts.baseLocale, page: key, url: pg.url, type: 'raw-key', reason: raw, ...s });
      else if (PLACEHOLDER_RE.test(s.text)) findings.push({ locale: opts.baseLocale, page: key, url: pg.url, type: 'placeholder', reason: 'unrendered template token', ...s });
    }
  }
  return findings;
}

function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function mdCell(v) { return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160); }

function writeReports(opts, base, targets, findings) {
  fs.mkdirSync(opts.out, { recursive: true });
  const meta = {
    generatedAt: new Date().toISOString(), baseUrl: opts.baseUrl, baseLocale: opts.baseLocale,
    locales: opts.locales, localeMode: opts.localeMode,
    pagesCrawled: Object.fromEntries([[opts.baseLocale, base.results.size], ...Object.entries(targets).map(([l, r]) => [l, r.results.size])]),
    errors: Object.fromEntries([[opts.baseLocale, base.errors], ...Object.entries(targets).map(([l, r]) => [l, r.errors])]),
    htmlLang: Object.fromEntries(Object.entries(targets).map(([l, r]) => [l, [...new Set([...r.results.values()].map(p => p.lang))]])),
  };
  fs.writeFileSync(path.join(opts.out, 'findings.json'), JSON.stringify({ meta, findings }, null, 2));

  const cols = ['locale', 'type', 'text', 'page', 'kind', 'where', 'reason', 'confidence', 'url'];
  fs.writeFileSync(path.join(opts.out, 'findings.csv'), [cols.join(','), ...findings.map(f => cols.map(c => csvCell(f[c] || (c === 'confidence' ? 'high' : ''))).join(','))].join('\n'));

  // Group identical strings so each missing translation is listed once with its pages.
  const grouped = new Map();
  for (const f of findings) {
    const k = f.locale + '|' + f.type + '|' + f.text;
    if (!grouped.has(k)) grouped.set(k, { ...f, pages: new Set() });
    grouped.get(k).pages.add(f.page);
  }
  const rows = [...grouped.values()].sort((a, b) => a.locale.localeCompare(b.locale) || a.type.localeCompare(b.type) || b.pages.size - a.pages.size);

  const lines = [];
  lines.push(`# Translation sweep — ${opts.baseUrl}`, '');
  lines.push(`Generated ${meta.generatedAt}. Reference locale **${opts.baseLocale}**, locale mode \`${opts.localeMode}\`.`, '');
  lines.push('## Summary', '', '| Locale | Pages crawled | Raw keys | Placeholders | Untranslated | Page errors | `<html lang>` seen |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const l of [opts.baseLocale, ...opts.locales]) {
    const uniq = t => rows.filter(r => r.locale === l && r.type === t).length;
    lines.push(`| ${l} | ${meta.pagesCrawled[l] ?? 0} | ${uniq('raw-key')} | ${uniq('placeholder')} | ${l === opts.baseLocale ? '—' : uniq('untranslated')} | ${(meta.errors[l] || []).length} | ${l === opts.baseLocale ? '' : (meta.htmlLang[l] || []).join(', ')} |`);
  }
  lines.push('', 'Counts are unique strings. "Untranslated" rows marked *medium* matched base text on the page but not at the same element.', '');
  for (const l of [opts.baseLocale, ...opts.locales]) {
    const mine = rows.filter(r => r.locale === l);
    if (!mine.length) continue;
    lines.push(`## ${l}`, '', '| Type | Text | Pages | Element | Reason |', '| --- | --- | --- | --- | --- |');
    for (const r of mine) {
      const pages = [...r.pages];
      lines.push(`| ${r.type}${r.confidence ? ' *(' + r.confidence + ')*' : ''} | \`${mdCell(r.text)}\` | ${pages.length > 3 ? pages.slice(0, 3).map(mdCell).join('<br>') + `<br>+${pages.length - 3} more` : pages.map(mdCell).join('<br>')} | ${r.kind}: \`${mdCell(r.where)}\` | ${mdCell(r.reason)} |`);
    }
    lines.push('');
  }
  const errs = Object.entries(meta.errors).flatMap(([l, es]) => es.map(e => ({ l, ...e })));
  if (errs.length) {
    lines.push('## Pages that failed to load', '', '| Locale | URL | Problem |', '| --- | --- | --- |');
    errs.forEach(e => lines.push(`| ${e.l} | ${mdCell(e.url)} | ${mdCell(e.status || e.error)} |`));
    lines.push('');
  }
  fs.writeFileSync(path.join(opts.out, 'report.md'), lines.join('\n'));
  return { rows, meta };
}

// ---------------------------------------------------------------- main
(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const ignored = loadIgnore(opts.ignoreFile);
  let seeds;
  if (opts.pathsFile) {
    seeds = fs.readFileSync(opts.pathsFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  } else {
    seeds = opts.startPaths.split(',').map(s => s.trim()).filter(Boolean);
  }
  seeds = seeds.map(p => new URL(p, opts.baseUrl + '/').toString());
  if (opts.pathsFile) seeds.fixed = true;

  const browser = await chromium.launch({ headless: !opts.headful });
  try {
    const base = await crawl(browser, opts, opts.baseLocale, seeds);
    // Target locales visit the pages the base crawl reached so pages line up.
    const basePages = [...base.results.values()].map(p => p.url);
    basePages.fixed = true;
    const targets = {};
    for (const l of opts.locales) targets[l] = await crawl(browser, { ...opts, maxPages: Math.max(basePages.length, 1) }, l, basePages.length ? basePages : seeds);
    const findings = analyse(opts, base, targets, ignored);
    const { rows } = writeReports(opts, base, targets, findings);
    console.log(`\nDone. ${rows.length} unique findings. Reports in ${path.resolve(opts.out)}: report.md, findings.csv, findings.json`);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
