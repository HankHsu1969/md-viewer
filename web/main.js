import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import mdKatexModule from '@vscode/markdown-it-katex';
import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import DOMPurify from 'dompurify';
import './style.css';

hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('dos', dos);
const mdKatex = mdKatexModule.default || mdKatexModule;

/* ---------------- 小工具 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const wv = window.chrome && window.chrome.webview;
const post = (msg) => { if (wv) wv.postMessage(msg); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('mdv:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mdv:' + k, JSON.stringify(v)); } catch { /* 無法儲存時忽略 */ } },
};
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" ${extra}>${d}</svg>`;
const ICON = {
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  wrap: svg('<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m0 0l2-2m-2 2l2 2M4 18h5"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  note: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.1"/>'),
  tip: svg('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z"/>'),
  important: svg('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v9a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4.3A2.5 2.5 0 0 1 4 14.5z"/><path d="M12 7v4.5M12 14v.1"/>'),
  warning: svg('<path d="M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 16.8v.1"/>'),
  caution: svg('<path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z"/><path d="M12 8v4.5M12 15.8v.1"/>'),
};
const ALERT_LABEL = { note: '備註', tip: '提示', important: '重要', warning: '警告', caution: '注意' };

/* ---------------- 設定 ---------------- */
const DEFAULTS = { theme: 'system', font: 'sans', size: 16, width: 'normal', breaks: true, toc: true, remote: 'ask' };
const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let effectiveDark = null;

function applySettings(first) {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && darkQuery.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.font = settings.font;
  root.dataset.width = settings.width;
  root.style.setProperty('--fs', settings.size + 'px');
  $('#fs-val').textContent = settings.size;
  $$('.seg').forEach((seg) => {
    const v = String(settings[seg.dataset.key]);
    $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  });
  if (dark !== effectiveDark) {
    effectiveDark = dark;
    post({ cmd: 'theme', dark });
    if (!first) rerenderMermaid();
  }
}
function setSetting(key, value) {
  const needRender = key === 'breaks' && settings.breaks !== value;
  settings[key] = value;
  store.set('settings', settings);
  applySettings();
  if (key === 'remote') {
    if (value === 'always') { $('#remote-bar').classList.add('hidden'); quietReload = true; }
    post({ cmd: 'remotePref', always: value === 'always' });
  }
  if (needRender && doc) { md = buildMd(); renderDoc(Object.assign({}, doc, { reload: true }), true); }
}
darkQuery.addEventListener('change', () => applySettings());

/* ---------------- Markdown 引擎 ---------------- */
function buildMd() {
  const m = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: !!settings.breaks });
  m.use(footnote);
  m.use(mdKatex, { throwOnError: false, output: 'html' });
  m.renderer.rules.fence = (tokens, idx) => {
    const t = tokens[idx];
    const info = (t.info || '').trim();
    const lang = info.split(/\s+/)[0].toLowerCase();
    const code = t.content;
    if (lang === 'mermaid') {
      return `<div class="mermaid-block" data-src="${encodeURIComponent(code)}"><pre class="mermaid-fallback">${esc(code)}</pre></div>`;
    }
    let body;
    if (lang && hljs.getLanguage(lang)) {
      try { body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { body = esc(code); }
    } else {
      body = esc(code);
    }
    return `<pre class="code" data-lang="${esc(lang)}"><code class="hljs">${body}</code></pre>`;
  };
  return m;
}
let md = buildMd();

/* ---------------- 文件狀態 ---------------- */
let doc = null; // { path, name, dir, base, text, mtime }
let renderToken = 0;
const backStack = [];
let goingBack = false;
let quietReload = false; // 因為允許網路圖片而重畫時，不顯示「檔案已更新」
let headings = [];

function splitFrontMatter(text) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fm: null, body: text.replace(/^﻿/, '') };
  return { fm: m[1], body: text.slice(m[0].length) };
}

function frontMatterNode(fm) {
  const box = document.createElement('div');
  box.className = 'front-matter';
  const head = document.createElement('div');
  head.className = 'fm-head';
  head.textContent = '文件資訊';
  box.appendChild(head);
  const rows = [];
  let ok = true;
  for (const line of fm.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = /^([^\s:#][^:]*):\s?(.*)$/.exec(line);
    if (kv && !/^\s/.test(line)) rows.push([kv[1].trim(), kv[2]]);
    else if (rows.length && /^\s+/.test(line)) rows[rows.length - 1][1] += (rows[rows.length - 1][1] ? '\n' : '') + line.trim();
    else { ok = false; break; }
  }
  if (ok && rows.length) {
    const table = document.createElement('table');
    for (const [k, v] of rows) {
      const tr = table.insertRow();
      tr.insertCell().textContent = k;
      const td = tr.insertCell();
      td.textContent = v.replace(/^["']|["']$/g, '');
      td.style.whiteSpace = 'pre-wrap';
    }
    box.appendChild(table);
  } else {
    const pre = document.createElement('pre');
    pre.textContent = fm;
    pre.style.margin = '0';
    pre.style.borderRadius = '0';
    box.appendChild(pre);
  }
  return box;
}

function slugify(s) {
  return s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}\-_]/gu, '') || 'section';
}

function resolveSrc(src) {
  if (!src) return src;
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  if (!doc || !doc.base) return src;
  try { return new URL(src.replace(/\\/g, '/'), doc.base).href; } catch { return src; }
}

const BLOCK_TAGS = new Set(['UL', 'OL', 'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DETAILS']);

function postProcess(article) {
  // 標題 id
  const used = new Map();
  headings = [];
  $$('h1,h2,h3,h4,h5,h6', article).forEach((h) => {
    let id = h.id || slugify(h.textContent);
    if (used.has(id)) { const n = used.get(id) + 1; used.set(id, n); id = `${id}-${n}`; } else used.set(id, 0);
    h.id = id;
    if (/^H[1-4]$/.test(h.tagName)) headings.push(h);
  });

  // 程式碼區塊外框
  $$('pre', article).forEach((pre) => {
    if (pre.closest('.mermaid-block, .front-matter, .code-block')) return;
    const lang = pre.dataset.lang || '';
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-head';
    head.innerHTML = `<span class="code-lang">${esc(lang || 'text')}</span><span class="code-btns">` +
      `<button class="code-btn" data-act="wrap" title="自動換行">${ICON.wrap}</button>` +
      `<button class="code-btn" data-act="copy" title="複製程式碼">${ICON.copy}<span>複製</span></button></span>`;
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  });

  // 待辦清單
  $$('li', article).forEach((li) => {
    let host = li;
    let first = li.firstChild;
    if (first && first.nodeType === 1 && first.tagName === 'P') { host = first; first = first.firstChild; }
    if (!first || first.nodeType !== 3) return;
    const m = /^\s*\[([ xX])\](?:\s+|$)/.exec(first.data);
    if (!m) return;
    first.data = first.data.slice(m[0].length);
    const done = m[1] !== ' ';
    li.classList.add('task');
    if (done) li.classList.add('done');
    const box = document.createElement('span');
    box.className = 'task-box';
    if (done) box.innerHTML = ICON.check;
    const text = document.createElement('span');
    text.className = 'task-text';
    while (host.firstChild && !(host.firstChild.nodeType === 1 && BLOCK_TAGS.has(host.firstChild.tagName))) text.appendChild(host.firstChild);
    host.prepend(box, text);
    if (li.parentElement) li.parentElement.classList.add('task-list');
  });

  // 提示框 > [!NOTE]
  $$('blockquote', article).forEach((bq) => {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P') return;
    const first = p.firstChild;
    if (!first || first.nodeType !== 3) return;
    const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i.exec(first.data);
    if (!m) return;
    const type = m[1].toLowerCase();
    first.data = first.data.slice(m[0].length);
    if (!first.data && first.nextSibling && first.nextSibling.nodeName === 'BR') first.nextSibling.remove();
    if (!first.data) first.remove();
    const box = document.createElement('div');
    box.className = `alert ${type}`;
    box.innerHTML = `<div class="alert-title">${ICON[type]}<span>${ALERT_LABEL[type]}</span></div>`;
    while (bq.firstChild) box.appendChild(bq.firstChild);
    if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
    bq.replaceWith(box);
  });

  // 表格
  $$('table', article).forEach((t) => {
    if (t.closest('.front-matter, .table-wrap')) return;
    const w = document.createElement('div');
    w.className = 'table-wrap';
    t.replaceWith(w);
    w.appendChild(t);
  });

  // 圖片
  $$('img', article).forEach((img) => {
    const src = img.getAttribute('src') || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      const span = document.createElement('span');
      span.className = 'broken';
      span.textContent = '🖼 找不到圖片：' + (img.getAttribute('alt') || src);
      img.replaceWith(span);
      span.classList.add('img', 'broken');
    }, { once: true });
    img.src = resolveSrc(src);
  });

  // 連結
  $$('a[href]', article).forEach((a) => {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/i.test(href)) {
      a.classList.add('ext');
      a.title = href;
    }
  });
}

/* ---------------- Mermaid 圖表 ---------------- */
let mermaidPromise = null;
let mermaidSeq = 0;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidPromise) {
    mermaidPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'mermaid.min.js';
      s.onload = () => resolve(window.mermaid);
      s.onerror = () => { mermaidPromise = null; reject(new Error('無法載入圖表元件')); };
      document.head.appendChild(s);
    });
  }
  return mermaidPromise;
}
function mermaidConfig() {
  const font = getComputedStyle(document.documentElement).getPropertyValue('--sans');
  const vars = effectiveDark
    ? { darkMode: true, background: '#30302e', primaryColor: '#4a3a33', primaryTextColor: '#ecebe4', primaryBorderColor: '#d97757', secondaryColor: '#33402f', secondaryTextColor: '#ecebe4', tertiaryColor: '#3a3936', tertiaryTextColor: '#ecebe4', lineColor: '#a29f95', textColor: '#ecebe4', mainBkg: '#4a3a33', nodeBorder: '#d97757', clusterBkg: '#2b2a28', clusterBorder: '#4a4944', noteBkgColor: '#4a4430', noteTextColor: '#ecebe4', noteBorderColor: '#8a7a40', edgeLabelBackground: '#30302e', actorBkg: '#4a3a33', actorBorder: '#d97757', actorTextColor: '#ecebe4', signalColor: '#d3d1c8', signalTextColor: '#ecebe4', labelBoxBkgColor: '#3a3936', labelTextColor: '#ecebe4' }
    : { background: '#ffffff', primaryColor: '#f8ebe4', primaryTextColor: '#29261b', primaryBorderColor: '#c96442', secondaryColor: '#eaf2e4', secondaryTextColor: '#29261b', tertiaryColor: '#f4f2ec', tertiaryTextColor: '#29261b', lineColor: '#8a8578', textColor: '#29261b', mainBkg: '#f8ebe4', nodeBorder: '#c96442', clusterBkg: '#faf9f5', clusterBorder: '#d6d2c4', noteBkgColor: '#fff4d1', noteTextColor: '#29261b', noteBorderColor: '#e0c56b', edgeLabelBackground: '#ffffff', actorBkg: '#f8ebe4', actorBorder: '#c96442', actorTextColor: '#29261b', signalColor: '#4a473d', signalTextColor: '#29261b' };
  vars.fontFamily = font;
  vars.fontSize = '15px';
  return { startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: vars, fontFamily: font, flowchart: { htmlLabels: true, curve: 'basis' } };
}
async function renderMermaid(root, token) {
  const blocks = $$('.mermaid-block', root);
  if (!blocks.length) return;
  blocks.forEach((b) => b.classList.add('loading'));
  let mermaid;
  try { mermaid = await loadMermaid(); } catch (e) {
    blocks.forEach((b) => { b.classList.remove('loading'); b.insertAdjacentHTML('afterbegin', `<div class="m-err">${esc(e.message)}</div>`); });
    return;
  }
  if (token !== renderToken) return;
  mermaid.initialize(mermaidConfig());
  for (const b of blocks) {
    if (token !== renderToken) return;
    const src = safeDecode(b.dataset.src || '');
    const id = 'mmd-' + (++mermaidSeq);
    try {
      const { svg: out } = await mermaid.render(id, src);
      if (token !== renderToken) return;
      b.innerHTML = DOMPurify.sanitize(out, {
        USE_PROFILES: { svg: true, svgFilters: true, html: true },
        ADD_TAGS: ['foreignObject'],
        HTML_INTEGRATION_POINTS: { foreignobject: true },
      });
      fitMermaid(b);
    } catch (err) {
      const msg = (err && (err.str || err.message)) || String(err);
      b.innerHTML = `<div class="m-err">圖表語法有誤：${esc(msg.split('\n')[0])}</div><pre class="mermaid-fallback">${esc(src)}</pre>`;
      const junk = document.getElementById('d' + id);
      if (junk) junk.remove();
    }
    b.classList.remove('loading');
  }
}
// 圖太寬時最多縮到 80%，再寬就讓它左右捲動，避免字小到看不清楚
function fitMermaid(block) {
  const s = $('svg', block);
  if (!s) return;
  const natural = parseFloat((s.style.maxWidth || '').replace('px', '')) || (s.viewBox && s.viewBox.baseVal && s.viewBox.baseVal.width) || 0;
  const avail = block.clientWidth - 36;
  if (natural && avail > 0 && avail / natural < 0.8) {
    s.style.maxWidth = 'none';
    s.style.width = Math.round(natural * 0.8) + 'px';
    block.style.textAlign = 'left';
  }
}
function rerenderMermaid() {
  const art = $('#doc');
  if (!$('.mermaid-block', art)) return;
  renderMermaid(art, renderToken);
}

/* ---------------- 目錄 + 統計 ---------------- */
function buildToc() {
  const toc = $('#toc');
  toc.innerHTML = '';
  if (!headings.length) { toc.innerHTML = '<div class="empty">這份文件沒有標題</div>'; return; }
  const min = Math.min(...headings.map((h) => +h.tagName[1]));
  for (const h of headings) {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.className = 'l' + (+h.tagName[1] - min + 1);
    a.textContent = h.textContent.trim();
    a.title = a.textContent;
    a.dataset.id = h.id;
    toc.appendChild(a);
  }
}
let activeId = null;
function updateActive() {
  if (!headings.length) return;
  const line = 48 + 40;
  let cur = headings[0];
  for (const h of headings) { if (h.getBoundingClientRect().top <= line) cur = h; else break; }
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = headings[headings.length - 1];
  if (cur.id === activeId) return;
  activeId = cur.id;
  const toc = $('#toc');
  $$('#toc a').forEach((a) => {
    const on = a.dataset.id === activeId;
    a.classList.toggle('active', on);
    // 只捲動目錄本身（不能用 scrollIntoView，會連帶捲動整頁）
    if (on && document.body.classList.contains('toc-open')) {
      const top = a.offsetTop - toc.offsetTop;
      if (top < toc.scrollTop) toc.scrollTop = top - 8;
      else if (top + a.offsetHeight > toc.scrollTop + toc.clientHeight) toc.scrollTop = top + a.offsetHeight - toc.clientHeight + 8;
    }
  });
}
function updateStats(article) {
  const text = article.textContent || '';
  const cjk = (text.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g) || []).length;
  const words = (text.replace(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g, ' ').match(/[A-Za-z0-9][\w'’-]*/g) || []).length;
  const mins = Math.max(1, Math.round(cjk / 400 + words / 220));
  const total = cjk + words;
  let html = `共 ${total.toLocaleString()} 字 · 閱讀約 ${mins} 分鐘`;
  if (doc && doc.mtime) html += `<br>修改於 ${esc(doc.mtime)}`;
  $('#doc-stats').innerHTML = html;
}

/* ---------------- 主渲染 ---------------- */
function renderDoc(msg, isSettingChange) {
  const token = ++renderToken;
  const article = $('#doc');
  const reload = !!msg.reload;
  const prevPath = doc && doc.path;
  if (!reload && prevPath && prevPath !== msg.path && !goingBack) backStack.push(prevPath);
  goingBack = false;
  const keepY = reload ? window.scrollY : null;
  $('#remote-bar').classList.add('hidden');

  doc = { path: msg.path, name: msg.name, dir: msg.dir, base: msg.base, text: msg.text, mtime: msg.mtime };
  const { fm, body } = splitFrontMatter(msg.text || '');
  let html;
  try { html = md.render(body); } catch (e) { html = `<pre>${esc(String(e))}</pre>`; }
  html = DOMPurify.sanitize(html, { SANITIZE_NAMED_PROPS: true, ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base'] });
  article.innerHTML = html;
  if (fm) article.prepend(frontMatterNode(fm));
  if (!article.textContent.trim() && !$('img', article)) article.innerHTML = '<p style="color:var(--muted)">（這個檔案是空的）</p>';
  postProcess(article);

  $('#welcome').classList.add('hidden');
  article.classList.remove('hidden');
  document.body.classList.add('has-doc');
  document.body.classList.remove('booting');
  const title = $('#doc-title');
  title.textContent = msg.name || '未命名';
  title.title = msg.path || '';
  $('#btn-back').classList.toggle('hidden', !backStack.length);
  buildToc();
  updateStats(article);
  activeId = null;
  applyTocVisibility();

  if (reload) {
    window.scrollTo(0, keepY);
    if (!isSettingChange && !quietReload) toast('檔案已更新，已自動重新載入');
    quietReload = false;
  } else if (msg.hash) {
    scrollToId(safeDecode(msg.hash), false);
  } else {
    const pos = store.get('pos', {});
    const y = (msg.path && pos[msg.path]) || 0;
    window.scrollTo(0, y);
    if (y > 300) toast('已回到上次讀到的位置', { label: '從頭開始', run: () => window.scrollTo({ top: 0, behavior: 'smooth' }) });
  }
  updateActive();
  if (!$('#findbar').classList.contains('hidden') && $('#find-input').value) runFind($('#find-input').value, true);
  if (!reload && msg.path) addRecent(msg);
  renderMermaid(article, token);
}

function showHome() {
  doc = null;
  renderToken++;
  $('#doc').classList.add('hidden');
  $('#doc').innerHTML = '';
  $('#welcome').classList.remove('hidden');
  document.body.classList.remove('has-doc', 'booting', 'toc-open');
  $('#doc-title').textContent = 'MD 閱讀器';
  $('#doc-title').title = '';
  $('#btn-back').classList.add('hidden');
  $('#toast').classList.add('hidden');
  $('#remote-bar').classList.add('hidden');
  backStack.length = 0;
  closeFind();
  renderRecent();
  window.scrollTo(0, 0);
}

function scrollToId(id, smooth = true) {
  const art = $('#doc');
  const el = document.getElementById(id) || document.getElementById('user-content-' + id) ||
    art.querySelector(`[name="${CSS.escape(id)}"], [name="user-content-${CSS.escape(id)}"]`);
  if (!el) return;
  const y = el.getBoundingClientRect().top + window.scrollY - 64;
  window.scrollTo({ top: y, behavior: smooth ? 'smooth' : 'instant' });
}

/* ---------------- 目錄開關 ---------------- */
const isWide = () => window.innerWidth >= 1000;
function applyTocVisibility() {
  if (!doc) { document.body.classList.remove('toc-open'); return; }
  const want = isWide() ? settings.toc && headings.length > 1 : false;
  document.body.classList.toggle('toc-open', want);
  $('#btn-toc').classList.toggle('active', want);
}
function toggleToc() {
  if (!doc) return;
  const open = !document.body.classList.contains('toc-open');
  document.body.classList.toggle('toc-open', open);
  $('#btn-toc').classList.toggle('active', open);
  if (isWide()) { settings.toc = open; store.set('settings', settings); }
}

/* ---------------- 最近開啟 ---------------- */
function addRecent(msg) {
  let list = store.get('recent', []).filter((r) => r.path.toLowerCase() !== msg.path.toLowerCase());
  list.unshift({ path: msg.path, name: msg.name, dir: msg.dir, t: Date.now() });
  store.set('recent', list.slice(0, 12));
}
function removeRecent(path) {
  store.set('recent', store.get('recent', []).filter((r) => r.path.toLowerCase() !== path.toLowerCase()));
  renderRecent();
}
function renderRecent() {
  const list = store.get('recent', []);
  const ul = $('#recent');
  ul.innerHTML = '';
  $('#recent-wrap').classList.toggle('hidden', !list.length);
  for (const r of list) {
    const li = document.createElement('li');
    li.title = r.path;
    li.innerHTML = `<span class="r-icon">${ICON.file}</span><span class="r-text"><div class="r-name"></div><div class="r-dir"></div></span>` +
      `<button class="icon-btn sm r-del" title="從清單移除">${ICON.x}</button>`;
    $('.r-name', li).textContent = r.name;
    $('.r-dir', li).textContent = '‎' + r.dir;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.r-del')) { e.stopPropagation(); removeRecent(r.path); return; }
      post({ cmd: 'openPath', path: r.path });
    });
    ul.appendChild(li);
  }
}

/* ---------------- 搜尋 ---------------- */
let hits = [];
let hitIdx = -1;
const hasHighlight = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
function openFind() {
  if (!doc) return;
  closePopovers();
  $('#findbar').classList.remove('hidden');
  const inp = $('#find-input');
  const sel = String(window.getSelection() || '').trim();
  if (sel && sel.length < 80 && !sel.includes('\n')) inp.value = sel;
  inp.focus();
  inp.select();
  if (inp.value) runFind(inp.value);
}
function closeFind() {
  $('#findbar').classList.add('hidden');
  hits = []; hitIdx = -1;
  if (hasHighlight) CSS.highlights.clear();
}
function runFind(q, keepIdx) {
  if (hasHighlight) CSS.highlights.clear();
  const prev = hitIdx;
  hits = []; hitIdx = -1;
  const count = $('#find-count');
  if (!q) { count.textContent = ''; count.classList.remove('none'); return; }
  const ql = q.toLowerCase();
  const walker = document.createTreeWalker($('#doc'), NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('.code-head, svg, .katex-mathml, .alert-title') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let n;
  while ((n = walker.nextNode())) {
    const t = n.data.toLowerCase();
    let i = t.indexOf(ql);
    while (i !== -1) {
      const r = new Range();
      r.setStart(n, i); r.setEnd(n, i + q.length);
      hits.push(r);
      i = t.indexOf(ql, i + q.length);
    }
  }
  if (!hits.length) { count.textContent = '找不到'; count.classList.add('none'); return; }
  count.classList.remove('none');
  if (hasHighlight) CSS.highlights.set('search-hit', new Highlight(...hits));
  if (keepIdx && prev >= 0 && prev < hits.length) hitIdx = prev;
  else {
    // 從目前畫面位置往下找第一個
    hitIdx = hits.findIndex((r) => r.getBoundingClientRect().top >= 60);
    if (hitIdx < 0) hitIdx = 0;
  }
  focusHit(!keepIdx);
}
function focusHit(scroll = true) {
  if (!hits.length) return;
  const r = hits[hitIdx];
  if (hasHighlight) CSS.highlights.set('search-cur', new Highlight(r));
  $('#find-count').textContent = `${hitIdx + 1} / ${hits.length}`;
  if (scroll) {
    const det = r.startContainer.parentElement.closest('details');
    if (det && !det.open) det.open = true;
    const rect = r.getBoundingClientRect();
    if (rect.top < 70 || rect.bottom > window.innerHeight - 40) {
      window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 3, behavior: 'smooth' });
    }
  }
}
function findStep(d) {
  if (!hits.length) { const v = $('#find-input').value; if (v) runFind(v); return; }
  hitIdx = (hitIdx + d + hits.length) % hits.length;
  focusHit();
}

/* ---------------- 提示訊息 ---------------- */
let toastTimer = 0;
function toast(text, action) {
  const t = $('#toast');
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text;
  t.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); t.classList.add('hidden'); };
    t.appendChild(b);
  }
  t.classList.remove('hidden');
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), action ? 6000 : 2600);
}

/* ---------------- 彈出選單 ---------------- */
function closePopovers() { $$('.popover').forEach((p) => p.classList.add('hidden')); }
function togglePop(id) {
  const p = $(id);
  const willOpen = p.classList.contains('hidden');
  closePopovers();
  if (willOpen) {
    $$('.need-doc', p).forEach((b) => { b.disabled = !doc; });
    p.classList.remove('hidden');
  }
}

/* ---------------- 與 C# 主程式溝通 ---------------- */
function onHostMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'load': renderDoc(msg); break;
    case 'home': showHome(); break;
    case 'notfound':
      toast('找不到這個檔案：' + msg.path);
      if (msg.path) removeRecent(msg.path);
      break;
    case 'toast':
      if (msg.reveal) toast(msg.message, { label: '顯示檔案', run: () => post({ cmd: 'revealPath', path: msg.reveal }) });
      else toast(msg.message);
      break;
    case 'hash': scrollToId(safeDecode(msg.hash)); break;
    case 'remoteBlocked':
      if (!doc || settings.remote === 'always') break;
      $('#remote-text').textContent = `已暫停載入 ${msg.count} 個網路圖片，以免寄件人知道你開了這份文件`;
      $('#remote-bar').classList.remove('hidden');
      break;
    default: break;
  }
}
if (wv) wv.addEventListener('message', (e) => onHostMessage(e.data));

/* ---------------- 事件綁定 ---------------- */
$('#btn-open').onclick = () => post({ cmd: 'open' });
$('#btn-open-big').onclick = () => (wv ? post({ cmd: 'open' }) : devPick());
$('#btn-find').onclick = () => ($('#findbar').classList.contains('hidden') ? openFind() : closeFind());
$('#btn-theme').onclick = () => setSetting('theme', effectiveDark ? 'light' : 'dark');
$('#btn-settings').onclick = (e) => { e.stopPropagation(); togglePop('#settings-pop'); };
$('#btn-more').onclick = (e) => { e.stopPropagation(); togglePop('#more-pop'); };
$('#btn-toc').onclick = toggleToc;
$('#btn-back').onclick = goBack;
$('#remote-once').onclick = () => { $('#remote-bar').classList.add('hidden'); quietReload = true; post({ cmd: 'remote', mode: 'once' }); };
$('#remote-always').onclick = () => { setSetting('remote', 'always'); };
$('#remote-close').onclick = () => $('#remote-bar').classList.add('hidden');
$('#to-top').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });

$$('.seg').forEach((seg) => seg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  let v = b.dataset.v;
  if (v === 'true') v = true; else if (v === 'false') v = false;
  setSetting(seg.dataset.key, v);
}));
$('#fs-down').onclick = () => setSetting('size', Math.max(12, settings.size - 1));
$('#fs-up').onclick = () => setSetting('size', Math.min(26, settings.size + 1));
$$('.popover').forEach((p) => p.addEventListener('click', (e) => e.stopPropagation()));
document.addEventListener('click', () => closePopovers());

$('#more-pop').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  closePopovers();
  switch (b.dataset.act) {
    case 'open': post({ cmd: 'open' }); break;
    case 'reload': if (doc) post({ cmd: 'reload' }); break;
    case 'reveal': if (doc) post({ cmd: 'revealPath', path: doc.path }); break;
    case 'copypath': if (doc) navigator.clipboard.writeText(doc.path).then(() => toast('已複製路徑')); break;
    case 'print': doPrint(); break;
    case 'pdf': if (doc) post({ cmd: 'pdf' }); break;
    case 'home': post({ cmd: 'close' }); showHome(); break;
    case 'keys': $('#keys-dlg').classList.remove('hidden'); break;
    case 'about': $('#about-dlg').classList.remove('hidden'); break;
    default: break;
  }
});
$$('.modal').forEach((dlg) => dlg.addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.closest('[data-close]')) dlg.classList.add('hidden');
}));
$('#lic-box').addEventListener('toggle', () => {
  const pre = $('#lic-text');
  if (!$('#lic-box').open || pre.dataset.loaded) return;
  fetch('licenses.txt').then((r) => r.text()).then((t) => { pre.textContent = t; pre.dataset.loaded = '1'; })
    .catch(() => { pre.textContent = '無法載入授權資訊，請見 https://github.com/HankHsu1969/md-viewer'; });
});

function doPrint() { if (!doc) return; if (wv) post({ cmd: 'print' }); else window.print(); }
function goBack() {
  if (!backStack.length) return;
  goingBack = true;
  post({ cmd: 'openPath', path: backStack.pop() });
}

// 文件內的點擊：連結、程式碼按鈕、圖片放大
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.code-btn');
  if (btn) {
    const block = btn.closest('.code-block');
    if (btn.dataset.act === 'wrap') { block.classList.toggle('wrap'); btn.classList.toggle('done', block.classList.contains('wrap')); return; }
    const code = $('pre', block).textContent;
    navigator.clipboard.writeText(code).then(() => {
      btn.classList.add('done');
      btn.innerHTML = `${ICON.check}<span>已複製</span>`;
      setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = `${ICON.copy}<span>複製</span>`; }, 1600);
    });
    return;
  }
  const a = e.target.closest('a[href]');
  if (a) {
    const href = a.getAttribute('href');
    e.preventDefault();
    if (a.closest('#toc')) { scrollToId(a.dataset.id); if (!isWide()) toggleToc(); return; }
    if (href.startsWith('#')) { scrollToId(safeDecode(href.slice(1))); return; }
    if (wv) post({ cmd: 'link', href });
    else window.open(href, '_blank');
    return;
  }
  const img = e.target.closest('.markdown img');
  if (img && img.naturalWidth) {
    const lb = $('#lightbox');
    lb.innerHTML = '';
    const big = document.createElement('img');
    big.src = img.currentSrc || img.src;
    lb.appendChild(big);
    lb.classList.remove('hidden');
    return;
  }
  const chart = e.target.closest('.mermaid-block svg');
  if (chart) {
    const lb = $('#lightbox');
    lb.innerHTML = '';
    const copy = chart.cloneNode(true);
    const vb = chart.viewBox && chart.viewBox.baseVal;
    copy.removeAttribute('style');
    copy.style.width = vb && vb.width ? Math.min(vb.width * 1.6, window.innerWidth * 0.94) + 'px' : '94vw';
    copy.style.maxHeight = '92vh';
    lb.appendChild(copy);
    lb.classList.remove('hidden');
  }
});
$('#lightbox').onclick = () => $('#lightbox').classList.add('hidden');
$('#toc').addEventListener('click', (e) => e.preventDefault());

// 搜尋列
const findInput = $('#find-input');
let findTimer = 0;
findInput.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => runFind(findInput.value), 120); });
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('#find-next').onclick = () => findStep(1);
$('#find-prev').onclick = () => findStep(-1);
$('#find-close').onclick = closeFind;

// 鍵盤快捷鍵
document.addEventListener('keydown', (e) => {
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  const lower = k.length === 1 ? k.toLowerCase() : k;
  if (ctrl && lower === 'o') { e.preventDefault(); post({ cmd: 'open' }); }
  else if (ctrl && lower === 'f') { e.preventDefault(); openFind(); }
  else if (ctrl && lower === 'b') { e.preventDefault(); toggleToc(); }
  else if (ctrl && lower === 'p') { e.preventDefault(); doPrint(); }
  else if (k === 'F5' || (ctrl && lower === 'r')) { e.preventDefault(); if (doc) post({ cmd: 'reload' }); }
  else if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); post({ cmd: 'zoom', d: 1 }); }
  else if (ctrl && k === '-') { e.preventDefault(); post({ cmd: 'zoom', d: -1 }); }
  else if (ctrl && k === '0') { e.preventDefault(); post({ cmd: 'zoom', d: 0 }); }
  else if ((e.altKey && k === 'ArrowLeft') || k === 'BrowserBack') { e.preventDefault(); goBack(); }
  else if (k === 'F3') { e.preventDefault(); if ($('#findbar').classList.contains('hidden')) openFind(); else findStep(e.shiftKey ? -1 : 1); }
  else if (k === 'Escape') {
    closePopovers();
    $('#lightbox').classList.add('hidden');
    $$('.modal').forEach((m) => m.classList.add('hidden'));
    if (document.activeElement !== findInput) closeFind();
  }
});
window.addEventListener('mouseup', (e) => { if (e.button === 3) { e.preventDefault(); goBack(); } });

// 捲動：目錄高亮、回到頂端、記住位置
let scrollRaf = 0;
let saveTimer = 0;
window.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    updateActive();
    $('#to-top').classList.toggle('hidden', !doc || window.scrollY < 700);
  });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!doc || !doc.path) return;
    const pos = store.get('pos', {});
    pos[doc.path] = Math.round(window.scrollY);
    const keys = Object.keys(pos);
    if (keys.length > 150) delete pos[keys[0]];
    store.set('pos', pos);
  }, 400);
}, { passive: true });
let wasWide = isWide();
window.addEventListener('resize', () => {
  const w = isWide();
  if (w !== wasWide) { wasWide = w; applyTocVisibility(); }
});

// 拖放檔案
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#drop-overlay').classList.remove('hidden'); });
window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').classList.add('hidden'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').classList.add('hidden');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  if (wv && wv.postMessageWithAdditionalObjects) wv.postMessageWithAdditionalObjects({ cmd: 'files' }, files);
  else devReadFile(files[0]);
});

/* ---------------- 開發模式（一般瀏覽器測試用） ---------------- */
function devReadFile(f) {
  const r = new FileReader();
  r.onload = () => renderDoc({ path: f.name, name: f.name, dir: '', base: null, text: String(r.result) });
  r.readAsText(f);
}
function devPick() {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = '.md,.markdown,.txt';
  i.onchange = () => i.files[0] && devReadFile(i.files[0]);
  i.click();
}

/* ---------------- 啟動 ---------------- */
document.body.classList.add('booting');
applySettings(true);
renderRecent();
if (wv) {
  post({ cmd: 'ready', remoteAlways: settings.remote === 'always' });
} else {
  const params = new URLSearchParams(location.search);
  const file = params.get('file');
  if (file) {
    fetch(file).then((r) => r.text()).then((text) => {
      const url = new URL(file, location.href);
      const name = decodeURIComponent(url.pathname.split('/').pop());
      renderDoc({ path: url.href, name, dir: url.pathname, base: new URL('.', url).href, text, mtime: '' });
    });
  } else showHome();
}
