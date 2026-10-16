/* ------------------------------------------------------------------------
   DeepSeek 对话阅读器 — 把官方导出还原成 chat.deepseek 的阅读体验
   纯静态、离线可用：数据通过 <script> 注入，所以 file:// 直接打开也能跑。
   ------------------------------------------------------------------------ */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- utils */

  var d = document;
  function $(sel, root) { return (root || d).querySelector(sel); }
  function el(tag, cls, text) {
    var n = d.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDateTime(iso) {
    var t = new Date(iso);
    if (isNaN(t)) return iso || '';
    return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) +
           ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes());
  }
  function fmtDate(iso) {
    var t = new Date(iso);
    if (isNaN(t)) return '';
    return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  }
  function fmtNum(n) {
    if (n == null) return '0';
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function dayStamp(iso) {
    var t = new Date(iso);
    if (isNaN(t)) return '';
    return t.getFullYear() * 10000 + (t.getMonth() + 1) * 100 + t.getDate();
  }
  /* 官方侧栏分组：置顶 / 今天 / 昨天 / 7 天内 / 30 天内 */
  function groupLabel(iso) {
    var t = new Date(iso);
    if (isNaN(t)) return '更早';
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var diff = Math.floor((today - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
    if (diff <= 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff <= 7) return '7 天内';
    if (diff <= 30) return '30 天内';
    return t.getFullYear() + ' 年 ' + (t.getMonth() + 1) + ' 月';
  }
  function copyText(text, okMsg) {
    function done(ok) { toast(ok ? (okMsg || '已复制') : '复制失败，请手动选择'); }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
    } else { fallback(); }
    function fallback() {
      try {
        var ta = el('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
        d.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        var ok = d.execCommand('copy');
        d.body.removeChild(ta);
        done(ok);
      } catch (e) { done(false); }
    }
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 1600);
  }
  function store(key, val) {
    try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) { return null; }
  }
  function scrollStore(key, val) {
    try {
      var m = JSON.parse(sessionStorage.getItem('ds-pos') || '{}');
      if (val === undefined) return m[key] || 0;
      m[key] = val; sessionStorage.setItem('ds-pos', JSON.stringify(m));
    } catch (e) { return 0; }
  }

  /* ----------------------------------------------------------------- theme */

  /* 官方主题就是 body 上的 class 与 data-ds-dark-theme 属性 */
  function setTheme(t) {
    var dark = t === 'dark';
    d.documentElement.dataset.theme = t;              // 阅读器自己的样式也跟一下
    d.body.classList.toggle('dark', dark);
    d.body.classList.toggle('light', !dark);
    if (dark) d.body.setAttribute('data-ds-dark-theme', '');
    else d.body.removeAttribute('data-ds-dark-theme');
    var hd = $('#hljs-dark'), hl = $('#hljs-light');
    if (hd && hl) { hd.disabled = !dark; hl.disabled = dark; }
    store('ds-reader-theme-v2', t);
  }
  setTheme(window.__DS_THEME0 || 'light');

  /* ------------------------------------------------------- markdown engine */

  var SENT = '@@DS' + Math.random().toString(36).slice(2) + '@@';
  var TOKEN_RE_SRC = SENT + '(\\d+)' + SENT;

  /* language names used by the model that highlight.js spells differently,
     plus the ones it does not know at all (rendered as plain code). */
  var LANG_ALIAS = {
    cmd: 'dos', batch: 'dos', bat: 'dos', dosbox: 'dos',
    assembly: 'x86asm', asm: 'x86asm', 'c#': 'csharp', 'c++': 'cpp',
    sh: 'bash', shell: 'bash', ps1: 'powershell', pwsh: 'powershell',
    js: 'javascript', ts: 'typescript', py: 'python', md: 'markdown', yml: 'yaml',
    plaintext: '', text: '', none: '', quickbms: '', excel: '', csv: '',
    reg: '', properties: '', log: '', ini: 'ini', diff: 'diff'
  };
  var PROF = { protect: 0, marked: 0, purify: 0, restore: 0, katex: 0, hljs: 0, layout: 0, n: {} };
  function tick(k, t0) { var dt = performance.now() - t0; PROF[k] = (PROF[k] || 0) + dt; PROF.n[k] = (PROF.n[k] || 0) + 1; }

  var AUTO_CACHE = {};
  var AUTO_KEYS = [];
  var autoBudget = 0;

  /* highlight.js with a hard cap: guessing the language is expensive, so only
     small un-tagged snippets get auto-detected, and never more than a few
     hundred times per conversation. */
  function hljsHtml(code, lang) {
    var l = String(lang || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LANG_ALIAS, l)) l = LANG_ALIAS[l];
    try {
      if (l && window.hljs && window.hljs.getLanguage(l)) {
        return window.hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
      }
      if (!l && window.hljs && autoBudget > 0 && code.length <= 800) {
        var key = code.length + ':' + code.slice(0, 160);
        if (AUTO_CACHE[key]) return AUTO_CACHE[key];
        autoBudget--;
        var v = window.hljs.highlightAuto(code).value;
        AUTO_CACHE[key] = v;
        AUTO_KEYS.push(key);
        if (AUTO_KEYS.length > 400) delete AUTO_CACHE[AUTO_KEYS.shift()];
        return v;
      }
    } catch (e) {}
    return esc(code);
  }

  function token(i) { return SENT + i + SENT; }

  /* Single-dollar maths is ambiguous with money and with byte dumps, so only
     accept short, maths-looking spans. */
  function isInlineMath(body) {
    if (!body || body.length > 60) return false;
    if (/\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}/.test(body)) return false;   // \xNN byte dumps
    if (/[\u0000-\u001f\ufffd]/.test(body)) return false;                 // control chars
    if (body.indexOf('$') >= 0 || body.indexOf('<') >= 0 || body.indexOf('>') >= 0) return false;
    var simple = /^[A-Za-z0-9_^\\{}=+\-*/. ]{1,60}$/.test(body) && /[A-Za-z\\^_{}=]/.test(body);
    return /[\\^_{}]/.test(body) || simple;
  }

  /* Raw HTML that DeepSeek's renderer would actually show, kept as HTML.        */
  var HTML_KEEP = { br: 1, kbd: 1, sub: 1, sup: 1, mark: 1, u: 1, b: 1, i: 1, small: 1, abbr: 1 };
  var RAW_TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

  /* Everything else is escaped, so stray <Compile .../> style output stays readable
     instead of being swallowed by the sanitiser. */
  function escapeRawHtml(s) {
    if (s.indexOf('<') < 0) return s;
    return s.replace(RAW_TAG, function (all, name, attrs) {
      var ln = name.toLowerCase();
      if (HTML_KEEP[ln] && !/[=\s]/.test(attrs.replace(/\s+$/, ''))) return all;
      return esc(all);
    });
  }

  /* Split markdown into: literal text / fenced code / inline code / maths / citation.
     Code and maths become opaque tokens so that markdown never mangles them.      */
  function protect(src) {
    var store = [];
    var out = [];
    var n = src.length;
    var i;

    function add(item) { store.push(item); return token(store.length - 1); }
    function text(s) { if (s) out.push(escapeRawHtml(s)); }

    /* ---- pass 1: locate fenced code blocks (line based, so linear) ---- */
    var lineStart = [0];
    for (i = 0; i < n; i++) if (src.charAt(i) === '\n') lineStart.push(i + 1);
    var lines = src.split('\n');
    var OPEN = /^[ \t]{0,8}(`{3,}|~{3,})[ \t]*([^\n`~]*)$/;
    var regions = [];
    var li = 0;
    while (li < lines.length) {
      var m = OPEN.exec(lines[li]);
      if (!m) { li++; continue; }
      var marker = m[1].charAt(0);
      var openLen = m[1].length;
      var info = (m[2] || '').trim();
      var indent = (/^[ \t]*/.exec(lines[li])[0] || '').length;
      var closeRe = new RegExp('^[ \\t]{0,8}' + (marker === '`' ? '`' : '~') + '{' + openLen + ',}[ \\t]*$');
      var cj = -1;
      for (var j = li + 1; j < lines.length; j++) { if (closeRe.test(lines[j])) { cj = j; break; } }
      var bodyEnd = cj < 0 ? lines.length : cj;
      var body = lines.slice(li + 1, bodyEnd).map(function (l) {
        var k = 0;
        while (k < indent && (l.charAt(k) === ' ' || l.charAt(k) === '\t')) k++;
        return l.slice(k);
      });
      var endLine = cj < 0 ? lines.length : cj + 1;
      regions.push({
        s: lineStart[li],
        e: endLine < lines.length ? lineStart[endLine] : n,
        lang: (info.split(/\s+/)[0] || ''),
        code: body.join('\n')
      });
      li = endLine;
    }

    /* ---- pass 2: inline scan, hopping over the code regions ---- */
    var INLINE = /`+|\\\(|\\\[|\$\$|\[citation:(\d+)\]|\$(?!\s)(?=[^$\n]{1,200}\$)/g;
    var ri = 0, p = 0;
    while (p < n) {
      if (ri < regions.length && p >= regions[ri].s) {
        if (p === regions[ri].s) {
          var fit = { kind: 'fence', lang: regions[ri].lang, code: regions[ri].code, p0: regions[ri].s, p1: regions[ri].e };
          out.push(add(fit));
          out.push('\n\n');
          p = regions[ri].e;
        } else {
          // the previous token ran past this fence start: keep the text as-is
          text(src.slice(p, regions[ri].s));
          p = regions[ri].s;
        }
        ri++;
        continue;
      }
      var limit = (ri < regions.length) ? regions[ri].s : n;
      var seg = src.slice(p, limit);
      INLINE.lastIndex = 0;
      var mm = INLINE.exec(seg);
      if (!mm) { text(seg); p = limit; continue; }

      var tok = mm[0];
      var handled = false;
      var item = null, endPos = 0;   // endPos is absolute within seg

      if (tok.charAt(0) === '`') {
        var lineEnd = seg.indexOf('\n', mm.index);
        var zone = lineEnd < 0 ? seg.length : lineEnd;      // inline code never spans lines
        var close = seg.indexOf(tok, mm.index + tok.length);
        if (close >= 0 && close + tok.length <= zone) {
          item = { kind: 'icode', text: seg.slice(mm.index + tok.length, close) };
          endPos = close + tok.length;
        }
      } else if (tok === '\\(') {
        var c1 = seg.indexOf('\\)', mm.index + 2);
        if (c1 >= 0) { item = { kind: 'math', display: false, text: seg.slice(mm.index + 2, c1) }; endPos = c1 + 2; }
      } else if (tok === '$$') {
        var c2 = seg.indexOf('$$', mm.index + 2);
        if (c2 >= 0) { item = { kind: 'math', display: true, text: seg.slice(mm.index + 2, c2) }; endPos = c2 + 2; }
      } else if (tok === '\\[') {
        var s3 = mm.index + 2;
        while (s3 < seg.length && /\s/.test(seg.charAt(s3))) s3++;
        var c3 = seg.indexOf('\\]', s3);
        if (c3 >= 0) { item = { kind: 'math', display: true, text: seg.slice(s3, c3) }; endPos = c3 + 2; }
      } else if (tok.charAt(0) === '$') {
        var inner = seg.slice(mm.index + 1);
        var c4 = -1;
        for (var i4 = 0; i4 < inner.length; i4++) {
          if (inner.charAt(i4) === '$' && !/\s/.test(inner.charAt(i4 - 1))) { c4 = i4; break; }
        }
        if (c4 > 0) {
          var body4 = inner.slice(0, c4);
          if (isInlineMath(body4)) {
            item = { kind: 'math', display: false, text: body4 };
            endPos = mm.index + c4 + 2;
          }
        }
      } else {
        var cm = /^\[citation:(\d+)\]$/.exec(tok);
        if (cm) { item = { kind: 'cite', n: parseInt(cm[1], 10) }; endPos = mm.index + tok.length; }
      }

      if (item) {
        text(seg.slice(0, mm.index));
        item.p0 = p + mm.index;
        item.p1 = p + endPos;
        out.push(add(item));
        p += endPos;
        handled = true;
      }
      if (!handled) {                      // not a real token: keep it literal
        var adv = Math.max(1, tok.length - 1);
        text(seg.slice(0, mm.index + adv));
        p += mm.index + adv;
      }
    }
    return { text: out.join(''), store: store };
  }

  function mdToHtml(src, opts) {
    opts = opts || {};
    if (src == null) return '';
    var _t0 = performance.now();
    var pr = protect(String(src));
    tick('protect', _t0);

    var html;
    var _t1 = performance.now();
    try {
      html = window.marked.parse(pr.text);
    } catch (e) {
      html = '<p>' + esc(pr.text) + '</p>';
    }
    tick('marked', _t1);
    var _t2 = performance.now();
    if (window.DOMPurify) {
      html = window.DOMPurify.sanitize(html, {
        ADD_ATTR: ['target', 'rel', 'title'],
        FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'link', 'meta'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style'],
        ALLOW_DATA_ATTR: false
      });
    }
    tick('purify', _t2);
    var _t3 = performance.now();
    var holder = el('div', 'md');
    holder.innerHTML = html;
    restoreTokens(holder, pr.store, opts.cites, String(src));
    tick('restore', _t3);
    return holder;
  }

  function buildPiece(item, cites) {
    if (item.kind === 'fence') {
      var wrap = el('div', 'code-block');
      var head = el('div', 'code-head');
      head.appendChild(el('span', 'code-lang', item.lang || 'text'));
      var btns = el('div', 'code-btns');
      var cp = el('button', 'copy-code', '复制');
      cp.addEventListener('click', function () { copyText(item.code, '复制成功'); });
      var wb = el('button', 'wrap-code', '换行');
      wb.addEventListener('click', function () {
        var code = wrap.querySelector('code');
        var on = code.style.whiteSpace === 'pre-wrap';
        code.style.whiteSpace = on ? 'pre' : 'pre-wrap';
        wb.textContent = on ? '换行' : '不换行';
      });
      btns.appendChild(wb);
      btns.appendChild(cp);
      head.appendChild(btns);
      wrap.appendChild(head);
      var pre = el('pre');
      var code = el('code', 'language-' + (item.lang || 'plaintext'));
      var _t = performance.now();
      code.innerHTML = hljsHtml(item.code, item.lang);
      tick('hljs', _t);
      pre.appendChild(code);
      wrap.appendChild(pre);
      return wrap;
    }
    if (item.kind === 'icode') {
      var c = el('code', 'inline');
      c.textContent = item.text;
      return c;
    }
    if (item.kind === 'math') {
      var span = el('span', item.display ? 'math-display' : 'math-inline');
      if (!item.display && item.text.length > 60) span.className = 'math-inline math-wide';
      try {
        var _t = performance.now();
        window.katex.render(item.text, span, {
          displayMode: item.display, throwOnError: false, strict: false, trust: false, output: 'html'
        });
        tick('katex', _t);
      } catch (e) { span.textContent = item.text; }
      return span;
    }
    if (item.kind === 'cite') {
      var a = el('a', 'cite', String(item.n));
      a.dataset.cite = String(item.n);
      var src = cites && cites[item.n - 1];
      if (src) { a.href = src.u; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = src.t; }
      else { a.href = 'javascript:void(0)'; a.title = '来源 ' + item.n; }
      return a;
    }
    return el('span', null, '');
  }

  function restoreTokens(root, store, cites, src) {
    var re = new RegExp(TOKEN_RE_SRC, 'g');
    var walker = d.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    function insideCode(node) {
      var p = node.parentNode;
      while (p && p !== root) {
        if (p.nodeName === 'PRE' || p.nodeName === 'CODE') return true;
        p = p.parentNode;
      }
      return false;
    }
    texts.forEach(function (tn) {
      var v = tn.nodeValue;
      if (!v || v.indexOf(SENT) < 0) return;
      var asCode = insideCode(tn);
      re.lastIndex = 0;
      var frag = d.createDocumentFragment();
      var last = 0, m;
      while ((m = re.exec(v))) {
        if (m.index > last) frag.appendChild(d.createTextNode(v.slice(last, m.index)));
        var item = store[parseInt(m[1], 10)];
        if (item) {
          // a token that markdown swallowed into a code block (indented code,
          // nested code ...) must stay verbatim source, never rendered
          if (asCode && src && item.p0 != null) {
            frag.appendChild(d.createTextNode(String(src).slice(item.p0, item.p1)));
          } else {
            frag.appendChild(buildPiece(item, cites));
          }
        }
        last = re.lastIndex;
      }
      if (!frag.childNodes.length) return;
      if (last < v.length) frag.appendChild(d.createTextNode(v.slice(last)));
      tn.parentNode.replaceChild(frag, tn);
    });
    // wrap wide tables so they scroll instead of stretching the page
    Array.prototype.forEach.call(root.querySelectorAll('table'), function (tb) {
      if (tb.parentNode && tb.parentNode.classList && tb.parentNode.classList.contains('table-wrap')) return;
      var w = el('div', 'table-wrap');
      tb.parentNode.insertBefore(w, tb);
      w.appendChild(tb);
    });
    // links open in a new tab
    Array.prototype.forEach.call(root.querySelectorAll('a[href]'), function (a) {
      if (/^https?:/i.test(a.getAttribute('href'))) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    });
    // remote images: lazy, and degrade to a tidy placeholder when they cannot load
    Array.prototype.forEach.call(root.querySelectorAll('img'), function (img) {
      img.setAttribute('loading', 'lazy');
      img.setAttribute('referrerpolicy', 'no-referrer');
      if (img.getAttribute('alt') === null) img.setAttribute('alt', '');
      img.addEventListener('error', function () {
        var u = img.getAttribute('src') || '';
        var host = '';
        try { host = new URL(u, location.href).host; } catch (e) {}
        var box = el('span', 'img-fallback');
        box.appendChild(el('span', null, '图片未包含在导出中' + (host ? '（' + host + '）' : '')));
        var a = el('a', null, '打开原图');
        a.href = u;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        box.appendChild(a);
        if (img.parentNode) img.parentNode.replaceChild(box, img);
      });
    });
  }

  function mdSource(conv, path) {
    var lines = [];
    path.forEach(function (id) {
      var nd = conv.g[id];
      if (!nd) return;
      var role = nd.o === 'u' ? '用户' : 'DeepSeek';
      nd.g.forEach(function (g) {
        if (g.k === 't') lines.push('> **思考过程**\n>\n> ' + g.x.replace(/\n/g, '\n> ').trim());
        else if (g.k === 'r' || g.k === 'q') lines.push('**' + role + '：**\n\n' + g.x.trim());
        else if (g.k === 's') lines.push('**参考来源：**\n' + g.u.map(function (s, i) { return (i + 1) + '. [' + s.t + '](' + s.u + ')'; }).join('\n'));
        else if (g.k === 'f') lines.push('**附件：** ' + g.f.map(function (f) { return f.n; }).join('、'));
      });
      lines.push('');
    });
    return lines.join('\n');
  }

  /* -------------------------------------------------------------- personas */

  var WHALE = '<svg viewBox="0 0 50 50" aria-hidden="true"><path fill="currentColor" d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z"/></svg>';

  /* ---------------------------------------------------------------- state */

  var M = window.__DS_MANIFEST || { convs: [], user: {} };
  var state = {
    convs: M.convs || [],
    me: M.user || {},
    byId: {},
    current: null,
    choice: {},
    nodes: null,
    conv: null,
    query: '',
    results: null,
    indexLoading: false,
    indexReady: false,
    thinkDefault: store('ds-think') === '1',
    srcDefault: store('ds-src') === '1'
  };
  state.convs.forEach(function (c) { state.byId[c.i] = c; });

  /* ------------------------------------------------------- concurrency mgr */

  var chunkCache = {};
  window.__DS_CHUNK = function (id, payload) { chunkCache[id] = payload; };

  function loadConv(id) {
    if (chunkCache[id]) return Promise.resolve(chunkCache[id]);
    return new Promise(function (res, rej) {
      var s = d.createElement('script');
      s.src = 'data/c/' + id + '.js';
      s.onload = function () {
        if (chunkCache[id]) res(chunkCache[id]); else rej(new Error('empty chunk'));
      };
      s.onerror = function () { rej(new Error('无法读取 data/c/' + id + '.js')); };
      d.head.appendChild(s);
    });
  }
  function loadIndex() {
    if (state.indexReady || state.indexLoading) return;
    state.indexLoading = true;
    var s = d.createElement('script');
    s.src = 'data/search.js';
    s.onload = function () {
      state.indexReady = true; state.indexLoading = false;
      if (state.pendingSearchRows && state.pendingSearchRows.length && window.__DS_SEARCH) {
        window.__DS_SEARCH.rows = window.__DS_SEARCH.rows.concat(state.pendingSearchRows);
        state.pendingSearchRows = [];
      }
      if (state.query) renderSearch(state.query);
    };
    s.onerror = function () { state.indexLoading = false; toast('全文索引载入失败'); };
    d.head.appendChild(s);
  }

  /* --------------------------------------------------------------- sidebar */

  function renderList() {
    var list = $('#conv-list');
    list.innerHTML = '';
    var q = state.query.trim().toLowerCase();
    if (q && !state.results) {
      // title filtering while the full-text index is not in use yet
      var hits = state.convs.filter(function (c) {
        return c.t.toLowerCase().indexOf(q) >= 0 || (c.p || '').toLowerCase().indexOf(q) >= 0;
      });
      if (!hits.length) {
        list.appendChild(el('div', 'search-status', '标题中没有匹配，按回车搜索全文内容'));
        return;
      }
      hits.forEach(function (c) { list.appendChild(itemFor(c)); });
      var hint = el('div', 'search-status');
      hint.style.padding = '10px 14px';
      hint.textContent = '按回车可在全部正文里搜索';
      list.appendChild(hint);
      return;
    }
    var last = null;
    state.convs.forEach(function (c) {
      var g = groupLabel(c.u || c.a);
      if (g !== last) {
        last = g;
        var gh = el('div', 'f3d18f6a a9b29780');
        gh.appendChild(el('span', null, g));
        list.appendChild(gh);
      }
      list.appendChild(itemFor(c));
    });
  }

  /* 官方条目：<a class="_546d736" href="…/a/chat/s/<id>"> + 标题 .c08e6e93 */
  function itemFor(c) {
    var a = el('a', '_546d736');
    a.href = 'https://chat.deepseek.com/a/chat/s/' + c.i;
    a.dataset.id = c.i;
    a.setAttribute('tabindex', '0');
    if (state.current === c.i) a.classList.add('b64fb9ae');
    a.appendChild(el('div', 'ds-focus-ring'));
    a.appendChild(el('div', 'c08e6e93', c.t));
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    var models = c.m || [];
    a.title = c.t + '\n' + fmtDateTime(c.a) + (c.u !== c.a ? ' → ' + fmtDateTime(c.u) : '') +
      '\n' + fmtNum(c.n) + ' 轮' + (models.indexOf('deepseek-reasoner') >= 0 ? ' · 深度思考' : '') +
      '\n(Ctrl/⌘+点击 = 在官网打开)';
    a.addEventListener('click', function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;   // 交给浏览器在官网打开
      e.preventDefault();
      open(c.i);
    });
    return a;
  }

  function markActive() {
    Array.prototype.forEach.call(d.querySelectorAll('#conv-list ._546d736'), function (b) {
      b.classList.toggle('b64fb9ae', b.dataset.id === state.current);
    });
  }

  /* ----------------------------------------------------------- search box */

  function renderSearch(q) {
    q = q.trim();
    var list = $('#conv-list');
    var status = $('#search-status');
    if (!q) { state.results = null; status.hidden = true; renderList(); return; }

    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    var titleHits = state.convs.filter(function (c) {
      var hay = (c.t + ' ' + (c.p || '')).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });

    if (!state.indexReady) {
      loadIndex();
      status.hidden = false;
      status.textContent = '已匹配 ' + titleHits.length + ' 个标题 · 正在载入全文索引…';
      state.results = { titleHits: titleHits, bodyHits: [] };
      renderSearchResults(q, titleHits, []);
      return;
    }

    var bodyHits = [];
    var rows = (window.__DS_SEARCH && window.__DS_SEARCH.rows) || [];
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i][0], title = rows[i][1], text = rows[i][2];
      var ok = true, best = -1, score = 0;
      for (var j = 0; j < terms.length; j++) {
        var at = text.indexOf(terms[j]);
        if (at < 0) { ok = false; break; }
        var c = 0, from = 0, k;
        while ((k = text.indexOf(terms[j], from)) >= 0) { c++; from = k + terms[j].length; if (c > 60) break; }
        score += c;
        if (best < 0) best = at;
      }
      if (!ok) continue;
      if (title.indexOf(terms[0]) >= 0) score += 40;
      bodyHits.push({ id: id, score: score, at: best, text: text });
    }
    bodyHits.sort(function (a, b) { return b.score - a.score; });
    state.results = { titleHits: titleHits, bodyHits: bodyHits.slice(0, 200) };
    status.hidden = false;
    status.textContent = '标题 ' + titleHits.length + ' 条 · 正文 ' + bodyHits.length + ' 条';
    renderSearchResults(q, titleHits, state.results.bodyHits);
  }

  function renderSearchResults(q, titleHits, bodyHits) {
    var list = $('#conv-list');
    list.innerHTML = '';
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);

    if (titleHits.length) {
      list.appendChild(el('div', 'group-title', '标题匹配（' + titleHits.length + '）'));
      titleHits.slice(0, 60).forEach(function (c) { list.appendChild(itemFor(c)); });
    }
    if (bodyHits.length) {
      list.appendChild(el('div', 'group-title', '正文匹配（' + bodyHits.length + '）'));
      bodyHits.forEach(function (h) {
        var c = state.byId[h.id];
        if (!c) return;
        var row = el('div', 'sr');
        row.appendChild(el('div', 'sr-t', c.t));
        row.appendChild(snippetNode(c, h.text, terms));
        row.appendChild(el('div', 'sr-m', fmtDate(c.u || c.a) + ' · ' + fmtNum(c.n) + ' 轮'));
        row.addEventListener('click', function () { open(h.id); });
        list.appendChild(row);
      });
    } else if (state.indexReady && !titleHits.length) {
      list.appendChild(el('div', 'search-status', '没有匹配的对话'));
    }
  }

  function snippetNode(conv, text, terms) {
    var box = el('div', 'sr-s');
    var at = -1;
    for (var i = 0; i < terms.length && at < 0; i++) at = text.indexOf(terms[i]);
    if (at < 0) at = 0;
    var start = Math.max(0, at - 40);
    var end = Math.min(text.length, at + 150);
    var raw = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    // highlight term occurrences safely through DOM nodes
    var lower = raw.toLowerCase();
    var marks = [];
    terms.forEach(function (t) {
      var from = 0, k;
      while ((k = lower.indexOf(t, from)) >= 0) { marks.push([k, k + t.length]); from = k + t.length; }
    });
    marks.sort(function (a, b) { return a[0] - b[0]; });
    var pos = 0;
    marks.forEach(function (rg) {
      if (rg[0] < pos) return;
      if (rg[0] > pos) box.appendChild(d.createTextNode(raw.slice(pos, rg[0])));
      box.appendChild(el('mark', null, raw.slice(rg[0], rg[1])));
      pos = rg[1];
    });
    if (pos < raw.length) box.appendChild(d.createTextNode(raw.slice(pos)));
    return box;
  }

  /* -------------------------------------------------------------- rendering */

  function nodeSources(nd) {
    for (var i = 0; i < nd.g.length; i++) if (nd.g[i].k === 's') return nd.g[i].u;
    return null;
  }

  function isFailed(nd) {
    var texts = nd.g.filter(function (g) { return g.k === 'r'; }).map(function (g) { return (g.x || '').trim(); });
    if (!texts.length) return false;
    var joined = texts.join(' ');
    if (joined.length > 90) return false;
    return /(服务器繁忙|服务繁忙|网络繁忙|系统繁忙|请稍后再试|搜索服务繁忙)/.test(joined);
  }

  function pickChild(parentId, total) {
    var idx = state.choice[parentId];
    if (idx == null) idx = total - 1;              // default: newest attempt
    return Math.max(0, Math.min(total - 1, idx));
  }

  /* The active conversation path: every node to render, each carrying the
     branch it was chosen from (so the ‹ › switcher knows where it belongs). */
  function buildPath() {
    var nodes = state.nodes, path = [];
    var cur = state.conv.r;
    var start = cur ? nodes[cur] : null;
    if (!start) return path;
    if (start.o === 'x') {                          // synthetic root: alternative first turns
      var kids = start.c || [];
      if (!kids.length) return path;
      var j = pickChild(cur, kids.length);
      path.push({ id: kids[j], parent: cur, idx: j, total: kids.length });
      cur = kids[j];
    } else {
      path.push({ id: cur, parent: null, idx: 0, total: 1 });
    }
    var guard = 0;
    while (cur && nodes[cur] && guard++ < 20000) {
      var nd = nodes[cur];
      var kids2 = nd.c || [];
      if (!kids2.length) break;
      var i = pickChild(cur, kids2.length);
      var next = kids2[i];
      path.push({ id: next, parent: cur, idx: i, total: kids2.length });
      cur = next;
    }
    return path;
  }

  function branchBar(parentId, pathStep) {
    var kids = state.nodes[parentId].c;
    var bar = el('div', 'branch');
    var chip = el('span', 'chip');
    var prev = el('button', null, '‹');
    var next = el('button', null, '›');
    prev.disabled = pathStep.idx <= 0;
    next.disabled = pathStep.idx >= kids.length - 1;
    var child = state.nodes[pathStep.id];
    var label = '第 ' + (pathStep.idx + 1) + ' / ' + kids.length + ' 个版本';
    var modelTag = child && child.m === 'deepseek-reasoner' ? '深度思考' : '普通对话';
    var failed = child && isFailed(child);
    chip.appendChild(prev);
    chip.appendChild(el('span', null, label + ' · ' + modelTag + (failed ? ' · 生成失败' : '')));
    chip.appendChild(next);
    bar.appendChild(chip);
    function go(delta) {
      var i = pathStep.idx + delta;
      if (i < 0 || i >= kids.length) return;
      state.choice[parentId] = i;
      renderConv(true);
    }
    prev.addEventListener('click', function () { go(-1); });
    next.addEventListener('click', function () { go(1); });
    return bar;
  }

  /* real chat.deepseek.com shows the reasoning behind a left rule, with the
     line "已思考（用时 N 秒）" as the toggle; the export has no duration, so the
     same slot shows the length of the reasoning text instead. */
  function thinkBlock(bodyNode, chars, open) {
    var p = el('div', 'think' + (open ? ' open' : ''));
    var head = el('button', 'think-head');
    head.appendChild(el('span', 'chev', '›'));
    head.appendChild(el('span', 'ph-title', '已思考（' + fmtNum(chars) + ' 字）'));
    var body = el('div', 'think-body');
    if (bodyNode) body.appendChild(bodyNode);
    p.appendChild(head);
    p.appendChild(body);
    head.addEventListener('click', function () { p.classList.toggle('open'); });
    return p;
  }

  /* real wording: “搜索到 N 个网页” */
  function sourcesBlock(listNode, count, open) {
    var p = el('div', 'sources' + (open ? ' open' : ''));
    var head = el('button', 'sources-head');
    head.appendChild(el('span', 'chev', '›'));
    head.appendChild(el('span', 'ph-title', count === 1 ? '搜索到 1 个网页' : '搜索到 ' + count + ' 个网页'));
    var body = el('div', 'sources-body');
    if (listNode) body.appendChild(listNode);
    p.appendChild(head);
    p.appendChild(body);
    head.addEventListener('click', function () { p.classList.toggle('open'); });
    return p;
  }

  function renderTurn(nd, id, conv) {
    var role = nd.o;
    var wrap = el('div', 'turn ' + (role === 'u' ? 'u' : 'a'));
    wrap.dataset.id = id;
    var meta = nd.m === 'deepseek-reasoner' ? '深度思考' : '普通对话';
    wrap.title = (nd.d ? fmtDateTime(nd.d) + ' · ' : '') + meta;

    var body = el('div', 'body');
    var cites = null;

    if (role === 'u') {
      var bubble = el('div', 'bubble');
      var hasText = false;
      nd.g.forEach(function (g) {
        if (g.k === 'f') {
          var fw = el('div', 'files');
          g.f.forEach(function (f) {
            var chip = el('span', 'file-chip missing');
            chip.appendChild(el('span', 'fname', f.n));
            chip.appendChild(el('span', 'fsize', f.z || ''));
            chip.title = '附件原始文件不在导出包中（仅保留文件名）';
            fw.appendChild(chip);
          });
          body.appendChild(fw);
        } else if (g.k === 'q' && (g.x || '').trim()) {
          hasText = true;
          bubble.appendChild(mdToHtml(g.x, {}));
        }
      });
      if (hasText) body.appendChild(bubble);
      else body.appendChild(el('div', 'dim', '（本条消息只有附件）')).style.fontSize = '12.5px';
    } else {
      cites = nodeSources(nd);
      nd.g.forEach(function (g) {
        if (g.k === 's') {
          var ul = el('ul', 'src-list');
          g.u.forEach(function (s, i) {
            var li = el('li');
            li.dataset.cite = String(i + 1);
            li.appendChild(el('span', 'src-num', String(i + 1)));
            var a = el('a');
            a.href = s.u || '#';
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.appendChild(el('span', null, s.t));
            if (s.s) a.appendChild(el('span', 'src-site', s.s));
            li.appendChild(a);
            ul.appendChild(li);
          });
          body.appendChild(sourcesBlock(ul, g.n, state.srcDefault));
        } else if (g.k === 't') {
          var tbody = mdToHtml(g.x, { cites: cites });
          body.appendChild(thinkBlock(tbody, (g.x || '').length, state.thinkDefault));
        } else if (g.k === 'r') {
          var note = /^\s*$/.test(g.x || '') ? '（没有返回内容）' : (isFailed(nd) ? '生成失败：' + (g.x || '').trim() : null);
          if (note) {
            var nb = el('div', 'failed-note');
            nb.textContent = '⚠ ' + note;
            nb.title = g.x || '';
            body.appendChild(nb);
          } else {
            body.appendChild(mdToHtml(g.x, { cites: cites }));
          }
        } else if (g.k === 'q') {
          body.appendChild(mdToHtml(g.x, { cites: cites }));
        }
      });
      if (isFailed(nd)) wrap.classList.add('failed');
      var acts = el('div', 'actions');
      var cp = el('button', 'act', '复制');
      cp.addEventListener('click', function () {
        var txt = nd.g.filter(function (g) { return g.k === 'r' || g.k === 't'; })
          .map(function (g) { return g.x; }).join('\n\n---\n\n');
        copyText(txt, '复制成功');
      });
      acts.appendChild(cp);
      if (nd.g.some(function (g) { return g.k === 't'; })) {
        var tg = el('button', 'act', '思考过程');
        tg.addEventListener('click', function () {
          var p = wrap.querySelector('.think');
          if (p) { p.classList.toggle('open'); wrap.scrollIntoView({ block: 'nearest' }); }
        });
        acts.appendChild(tg);
      }
      if (cites) {
        var sg = el('button', 'act', '来源 (' + cites.length + ')');
        sg.addEventListener('click', function () {
          var p = wrap.querySelector('.sources');
          if (p) { p.classList.toggle('open'); }
        });
        acts.appendChild(sg);
      }
      body.appendChild(acts);
    }

    wrap.appendChild(body);
    return wrap;
  }

  var renderToken = 0;

  function renderConv(keepScroll) {
    var conv = state.conv;
    state.nodes = conv.g;
    var scroller = $('#scroller');
    var pos = keepScroll ? scroller.scrollTop : 0;

    var head = $('#chat-head');
    head.hidden = false;
    $('#head-title').textContent = conv.t;
    $('#head-title').title = '在 chat.deepseek.com 上打开：' + conv.t;
    var subBits = [];
    subBits.push('创建于 ' + fmtDateTime(conv.a));
    if (conv.u && conv.u !== conv.a) subBits.push('最后活动 ' + fmtDateTime(conv.u));
    var path = buildPath();
    var meta = state.byId[conv.i] || {};
    subBits.push(fmtNum(meta.n) + ' 轮对话');
    subBits.push(fmtNum(meta.z) + ' 字');
    if (meta.s) subBits.push(meta.s + ' 条来源');
    if (meta.f) subBits.push(meta.f + ' 个附件');
    subBits.push((meta.m || []).map(function (m) { return m === 'deepseek-reasoner' ? 'DeepSeek-R1（深度思考）' : 'DeepSeek-V3'; }).join(' / '));
    var headMeta = subBits.join(' · ');
    var hs = $('#head-sub');
    if (hs) hs.textContent = headMeta;
    $('#head-title').title = headMeta;      // 官方顶部只有一条居中的标题，详情放 tooltip

    var root = $('#transcript');
    root.innerHTML = '';
    d.title = conv.t + ' — DeepSeek 阅读器';

    var token = ++renderToken;
    state.rendered = null;
    autoBudget = 250;
    var i = 0;
    var branchCount = path.filter(function (p) { return p.total > 1; }).length;
    var BATCH = 6;
    var foot = $('#transcript-foot');
    foot.hidden = true;
    var progress = el('div', 'loading');
    progress.textContent = '正在排版…';

    function finish() {
      if (token !== renderToken) return;
      if (progress.parentNode) progress.parentNode.removeChild(progress);
      state.rendered = state.current;
      foot.hidden = false;
      foot.innerHTML = '';
      var note = el('div', 'foot-note', '以上是该对话的完整记录 · 共 ' + fmtNum(path.length) + ' 条消息' +
        (branchCount ? ' · 重新生成的 ' + branchCount + ' 处多版本可用上方 ‹ › 切换' : ''));
      foot.appendChild(note);
      if (Object.keys(state.choice).length) {
        var reset = el('button', 'act', '回到最新版本');
        reset.style.marginTop = '8px';
        reset.addEventListener('click', function () { state.choice = {}; renderConv(true); });
        foot.appendChild(reset);
      }
      scroller.scrollTop = keepScroll ? pos : 0;
      if (!keepScroll) restoreScrollSoon(conv.i);
      updateFloats();
    }

    function schedule(fn) {
      // rAF alone is not enough: browsers stop firing it for background tabs or
      // occluded windows, which would freeze a long transcript mid-render.
      var done = false;
      function run() { if (done) return; done = true; fn(); }
      try { requestAnimationFrame(run); } catch (e) {}
      setTimeout(run, 60);
    }

    function step() {
      if (token !== renderToken) return;
      var end = Math.min(path.length, i + BATCH);
      for (; i < end; i++) {
        var st = path[i];
        if (st.total > 1) root.appendChild(branchBar(st.parent, st));
        root.appendChild(renderTurn(state.nodes[st.id], st.id, conv));
      }
      if (i < path.length) {
        var _tl = performance.now();
        progress.textContent = '正在排版… ' + i + ' / ' + path.length;
        void root.offsetHeight;
        tick('layout', _tl);
        root.appendChild(progress);
        schedule(step);
      } else {
        finish();
      }
    }
    root.appendChild(progress);
    if (path.length) step(); else finish();
    updateFloats();
  }

  function restoreScrollSoon(id) {
    if (typeof requestAnimationFrame !== 'function') return;
    var want = scrollStore(id);
    if (!want) return;
    requestAnimationFrame(function () {
      var s = $('#scroller');
      if (s.scrollTop < 8) s.scrollTop = want;
    });
  }

  /* -------------------------------------------------------------- routing */

  function open(id, opts) {
    opts = opts || {};
    var conv = state.byId[id];
    if (!conv) return;
    if (state.current === id && state.conv) return;
    state.current = id;
    state.choice = {};
    location.hash = '#/' + id;
    markActive();
    if (window.matchMedia && window.matchMedia('(max-width: 880px)').matches) {
      $('#app').classList.remove('side-open');
    }
    $('#app').classList.remove('side-hidden');
    var scroller = $('#scroller');
    $('#welcome').hidden = true;
    $('#transcript').innerHTML = '';
    $('#transcript-foot').hidden = true;
    var loading = el('div', 'loading', '正在读取对话…');
    $('#transcript').appendChild(loading);
    scroller.scrollTop = 0;
    loadConv(id).then(function (payload) {
      if (state.current !== id) return;
      state.conv = payload;
      state.nodes = payload.g;
      renderConv(false);
    }).catch(function (e) {
      if (state.current !== id) return;
      $('#transcript').innerHTML = '';
      $('#transcript').appendChild(el('div', 'loading', '读取失败：' + e.message));
    });
  }

  function openFromHash() {
    var h = location.hash.replace(/^#\/?/, '');
    if (!h) { showWelcome(); return; }
    if (state.byId[h]) { open(h); } else { showWelcome(); }
  }

  function showWelcome() {
    state.current = null;
    /* 头部（含侧栏展开按钮）始终可见：以前在这里隐藏它，折叠侧栏后就再也点不开了 */
    $('#chat-head').hidden = false;
    $('#transcript').innerHTML = '';
    $('#transcript-foot').hidden = true;
    var w = $('#welcome');
    w.hidden = false;
    w.innerHTML = '';
    var convs = state.convs;
    var users = 0, files = 0, sources = 0, chars = 0;
    convs.forEach(function (c) {
      users += c.n || 0; files += c.f || 0; sources += c.s || 0; chars += c.z || 0;
    });
    var oldest = convs.length ? convs[convs.length - 1].a : '';
    var newest = convs.length ? convs[0].u : '';

    w.appendChild(el('h1', 'welcome-greeting', '你好，有什么我能帮你的吗？'));
    w.appendChild(el('p', 'lead', '这里是离线只读归档：共 ' + fmtNum(convs.length) + ' 个对话 · ' +
      fmtNum(users) + ' 轮问答 · ' + fmtNum(chars) + ' 字 · ' + fmtNum(sources) + ' 条联网来源 · ' +
      fmtNum(files) + ' 个附件。点击下面任意一条开始阅读。'));
    var box = el('div', 'empty-state');
    if (!convs.length) {
      box.appendChild(el('p', 'empty-title', '还没有导入任何对话'));
      box.appendChild(el('p', 'empty-hint',
        '在 DeepSeek 网页端「设置 → 数据 → 导出数据」拿到 zip，然后点下面的按钮导入；' +
        '也可以把 zip 直接拖到这个窗口里。导入的内容存在本机浏览器，下次打开还在。'));
      var ib = el('button', 'empty-import', '选择 .zip 文件导入');
      ib.addEventListener('click', pickImport);
      box.appendChild(ib);
    } else {
      box.appendChild(el('p', 'empty-hint', '从左侧选择一条对话开始阅读 · 也可以用 Ctrl+K 搜索'));
    }
    w.appendChild(box);
    var stats = el('div', 'stats');
    [['时间跨度', (oldest ? fmtDate(oldest) : '—') + ' ~ ' + fmtDate(newest)],
     ['最长对话', longestTitle()],
     ['数据来源', 'DeepSeek 官方导出'],
     ['生成时间', M.generated || '']].forEach(function (pair) {
      var s = el('div', 'stat');
      s.appendChild(el('b', null, pair[0]));
      s.appendChild(el('span', null, pair[1]));
      stats.appendChild(s);
    });
    w.appendChild(stats);


    var tips = el('div', 'tips');
    tips.innerHTML = '<kbd>Ctrl</kbd>+<kbd>K</kbd> 搜索 · <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> 切换对话 · ' +
      '<kbd>Esc</kbd> 清空搜索<br>思考过程与联网来源默认折叠，点击标题即可展开；重新生成的多个版本可用 ‹ › 切换。';
    w.appendChild(tips);
    d.title = 'DeepSeek 对话阅读器';
  }

  function longestTitle() {
    var best = null;
    state.convs.forEach(function (c) { if (!best || (c.z || 0) > (best.z || 0)) best = c; });
    return best ? best.t.slice(0, 18) + '…' : '—';
  }

  /* ------------------------------------------------------------- floats/UI */

  function updateFloats() {
    var s = $('#scroller');
    var far = s.scrollTop > 400;
    var nearBottom = s.scrollTop + s.clientHeight > s.scrollHeight - 200;
    $('#btn-top').hidden = !far;
    $('#btn-bottom').hidden = nearBottom;
  }

  function bindUI() {
    $('#btn-theme').addEventListener('click', function () {
      setTheme(d.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
    /* 收起侧栏：官方就是用 .dc04ec1d.a02af2e6（transform: translateX(-261px)）；
       窄屏时侧栏是覆盖层，用 #app.side-open 控制。两种情况下头部按钮都在，随时能展开。 */
    function toggleSide() {
      var app = $('#app');
      if (window.matchMedia('(max-width: 880px)').matches) {
        app.classList.toggle('side-open');
        return;
      }
      app.classList.toggle('side-hidden');   // 我的样式：#app.side-hidden > #sidebar { margin-left: -261px }
    }
    $('#btn-menu').addEventListener('click', toggleSide);
    $('#btn-side').addEventListener('click', toggleSide);
    $('#btn-top').addEventListener('click', function () { $('#scroller').scrollTop = 0; });
    $('#btn-bottom').addEventListener('click', function () {
      var s = $('#scroller'); s.scrollTop = s.scrollHeight;
    });
    $('#scroller').addEventListener('scroll', function () {
      updateFloats();
      if (state.current) scrollStore(state.current, $('#scroller').scrollTop);
    });

    var search = $('#search');
    var composing = false;
    search.addEventListener('compositionstart', function () { composing = true; });
    search.addEventListener('compositionend', function () { composing = false; doSearch(); });
    search.addEventListener('input', function () { if (!composing) doSearch(); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { if (!state.indexReady) loadIndex(); doSearch(true); }
      if (e.key === 'Escape') { search.value = ''; doSearch(); search.blur(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var items = $('#conv-list').querySelectorAll('._546d736, .sr');
        if (!items.length) return;
        var cur = -1;
        for (var i = 0; i < items.length; i++) if (items[i].classList.contains('sel')) cur = i;
        var nxt = Math.max(0, Math.min(items.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
        items.forEach(function (x) { x.classList.remove('sel'); });
        items[nxt].classList.add('sel');
        items[nxt].scrollIntoView({ block: 'nearest' });
      }
    });
    $('#search-clear').addEventListener('click', function () {
      search.value = ''; doSearch(); search.focus();
    });

    function doSearch(force) {
      var v = search.value;
      $('#search-clear').hidden = !v;
      state.query = v;
      if (!v) { state.results = null; $('#search-status').hidden = true; renderList(); return; }
      if (state.indexReady || force === true) renderSearch(v);
      else { state.results = null; renderList(); }
    }

    var newBtn = $('#btn-new');
    if (newBtn) {
      newBtn.addEventListener('click', function () {
        state.current = null;
        state.conv = null;
        state.choice = {};
        location.hash = '';
        markActive();
        showWelcome();
      });
    }

    $('#btn-import').addEventListener('click', pickImport);
    $('#import-file').addEventListener('change', function (e) {
      importFromFile(e.target.files && e.target.files[0]);
    });
    // drag & drop a zip anywhere on the page also works
    ['dragover', 'drop'].forEach(function (ev) {
      d.addEventListener(ev, function (e) {
        if (ev === 'dragover') { e.preventDefault(); return; }
        e.preventDefault();
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f && /\.zip$/i.test(f.name)) importFromFile(f);
      });
    });

    // header buttons
    $('#btn-think').addEventListener('click', function () {
      state.thinkDefault = !state.thinkDefault;
      store('ds-think', state.thinkDefault ? '1' : '0');
      Array.prototype.forEach.call(d.querySelectorAll('.think'), function (p) {
        p.classList.toggle('open', state.thinkDefault);
      });
      this.textContent = state.thinkDefault ? '折叠思考' : '展开思考';
    });
    $('#btn-sources').addEventListener('click', function () {
      state.srcDefault = !state.srcDefault;
      store('ds-src', state.srcDefault ? '1' : '0');
      Array.prototype.forEach.call(d.querySelectorAll('.sources'), function (p) {
        p.classList.toggle('open', state.srcDefault);
      });
      this.textContent = state.srcDefault ? '折叠来源' : '展开来源';
    });
    $('#btn-md').addEventListener('click', function () {
      if (!state.conv) return;
      copyText(mdSource(state.conv, buildPath().map(function (s) { return s.id; })), '整段对话已复制为 Markdown');
    });
    $('#btn-site').addEventListener('click', function () {
      if (!state.current) return;
      window.open('https://chat.deepseek.com/a/chat/s/' + state.current, '_blank', 'noopener');
    });
    $('#btn-raw').addEventListener('click', function () {
      if (!state.conv) return;
      $('#lb-body').textContent = JSON.stringify(state.conv, null, 2);
      $('#lightbox').hidden = false;
    });
    $('#lb-close').addEventListener('click', function () { $('#lightbox').hidden = true; });
    $('#lightbox').addEventListener('click', function (e) {
      if (e.target === this) this.hidden = true;
    });

    // citation click -> reveal the matching source
    d.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a.cite') : null;
      if (!a) return;
      e.preventDefault();
      var turn = a.closest('.turn');
      if (!turn) return;
      var panelEl = turn.querySelector('.sources');
      if (panelEl) {
        panelEl.classList.add('open');
        var li = panelEl.querySelector('.src-list li[data-cite="' + a.dataset.cite + '"]');
        if (li) {
          li.classList.add('hit');
          li.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setTimeout(function () { li.classList.remove('hit'); }, 1600);
        }
      }
      if (a.getAttribute('href') && a.getAttribute('href') !== 'javascript:void(0)') {
        window.open(a.getAttribute('href'), '_blank', 'noopener');
      }
    });

    // keyboard
    d.addEventListener('keydown', function (e) {
      var inField = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); $('#search').focus(); $('#search').select(); return;
      }
      if (e.key === 'Escape') {
        if (!$('#lightbox').hidden) { $('#lightbox').hidden = true; return; }
        if (inField) { $('#search').value = ''; state.query = ''; state.results = null; renderList(); $('#search').blur(); }
        return;
      }
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        var i = state.convs.findIndex(function (c) { return c.i === state.current; });
        if (i < 0) i = 0;
        var j = e.key === 'ArrowLeft' ? i + 1 : i - 1;
        if (state.convs[j]) open(state.convs[j].i);
        return;
      }
      if (inField) return;
    });

    window.addEventListener('hashchange', openFromHash);
    $('#btn-think').textContent = state.thinkDefault ? '折叠思考' : '展开思考';
    $('#btn-sources').textContent = state.srcDefault ? '折叠来源' : '展开来源';

    // lazy: conversation list is rendered from the manifest synchronously
  }


  /* ------------------------------------------------------- 导入对话记录(.zip) */
  /* DeepSeek 导出的 zip 里是 conversations.json + user.json；这里在浏览器里
     直接解压（DecompressionStream('deflate-raw')，无需任何第三方库）、转换成
     阅读器的数据结构，再合并进列表，并写进 IndexedDB 以便刷新后仍在。 */

  var IMPORT_DB = 'ds-reader-imports';
  var IMPORT_STORE_CONV = 'conv';
  var IMPORT_STORE_META = 'meta';

  function idbOpen() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error('浏览器不支持 IndexedDB'));
      var rq = indexedDB.open(IMPORT_DB, 1);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains(IMPORT_STORE_CONV)) db.createObjectStore(IMPORT_STORE_CONV);
        if (!db.objectStoreNames.contains(IMPORT_STORE_META)) db.createObjectStore(IMPORT_STORE_META);
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error || new Error('IndexedDB 打开失败')); };
    });
  }

  function idbPutMany(db, store, obj) {
    return new Promise(function (res, rej) {
      var tx = db.transaction(store, 'readwrite');
      var st = tx.objectStore(store);
      Object.keys(obj).forEach(function (k) { st.put(obj[k], k); });
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
    });
  }

  function idbGetAll(db, store) {
    return new Promise(function (res, rej) {
      var tx = db.transaction(store, 'readonly');
      var st = tx.objectStore(store);
      var out = {};
      st.openCursor().onsuccess = function (e) {
        var c = e.target.result;
        if (c) { out[c.key] = c.value; c.continue(); } else res(out);
      };
      tx.onerror = function () { rej(tx.error); };
    });
  }

  /* --- 极简 zip 读取（central directory → local header） --- */
  function zipRead(buf) {
    var dv = new DataView(buf), n = buf.byteLength, eocd = -1;
    for (var i = n - 22; i >= 0 && i >= n - 66000; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');
    var count = dv.getUint16(eocd + 10, true);
    var p = dv.getUint32(eocd + 16, true);
    var out = [];
    for (var k = 0; k < count; k++) {
      if (p + 46 > n || dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = new TextDecoder('utf-8').decode(new Uint8Array(buf, p + 46, nameLen));
      out.push({ name: name, method: method, compSize: compSize, localOff: localOff });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { dv: dv, buf: buf, entries: out };
  }

  function zipEntryData(z, ent) {
    var dv = z.dv;
    if (dv.getUint32(ent.localOff, true) !== 0x04034b50) throw new Error('zip 结构损坏');
    var nameLen = dv.getUint16(ent.localOff + 26, true);
    var extraLen = dv.getUint16(ent.localOff + 28, true);
    var start = ent.localOff + 30 + nameLen + extraLen;
    var raw = new Uint8Array(z.buf, start, ent.compSize);
    if (ent.method === 0) return Promise.resolve(raw);
    if (ent.method !== 8) return Promise.reject(new Error('不支持的压缩方式'));
    if (typeof DecompressionStream !== 'function') return Promise.reject(new Error('当前浏览器不支持解压（需要 DecompressionStream）'));
    var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  /* --- 导出数据 → 阅读器数据（与 tools/gen.py 同样的规则） --- */
  function humanSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1).replace('.0 ', ' ') + ' KB';
    return (n / 1048576).toFixed(1).replace('.0 ', ' ') + ' MB';
  }

  function cleanTitle(title, firstUser, limit) {
    limit = limit || 42;
    var t = String(title || '').replace(/\s+/g, ' ').trim().replace(/^[#>\-*\s]+/, '').trim();
    if (!t && firstUser) t = String(firstUser).replace(/\s+/g, ' ').trim();
    if (t.length > limit) t = t.slice(0, limit).replace(/\s+$/, '') + '…';
    return t || '(无标题)';
  }

  function fragOf(f) {
    var t = f && f.type;
    if (t === 'REQUEST') return { k: 'q', x: f.content || '' };
    if (t === 'THINK') return { k: 't', x: f.content || '' };
    if (t === 'RESPONSE') return { k: 'r', x: f.content || '' };
    if (t === 'SEARCH') {
      var res = (f.results || []).map(function (r) {
        var site = '';
        var m = /^[a-z]+:\/\/([^/]+)/i.exec(r.url || '');
        if (m) site = m[1];
        return { u: r.url || '', t: String(r.title || r.url || '').replace(/\s+/g, ' ').slice(0, 200), s: site };
      });
      return { k: 's', n: res.length, u: res };
    }
    if (t === 'FILE') {
      return {
        k: 'f',
        f: (f.files || []).map(function (x) {
          return { n: x.file_name || 'file', z: humanSize(x.file_size), i: x.file_id || '' };
        })
      };
    }
    return null;
  }

  function roleOf(frags) {
    for (var i = 0; i < frags.length; i++) {
      var k = frags[i].k;
      if (k === 'r' || k === 't') return 'a';
    }
    return 'u';
  }

  function convertConversation(c) {
    var raw = c.mapping || {};
    var nodes = {}, nid;
    for (nid in raw) {
      if (nid === 'root') continue;
      var nd = raw[nid], msg = nd.message, frags = [];
      if (msg) {
        (msg.fragments || []).forEach(function (f) {
          var fr = fragOf(f);
          if (fr) frags.push(fr);
        });
      }
      nodes[nid] = {
        id: nid,
        parent: nd.parent || 'root',
        children: (nd.children || []).slice(),
        msg: msg,
        frags: frags
      };
    }
    /* 丢掉没有任何内容的占位节点，把它们的子节点接到上一层 */
    var removed = {};
    Object.keys(nodes).forEach(function (k) { if (!nodes[k].frags.length) removed[k] = 1; });
    Object.keys(removed).forEach(function (k) {
      var n = nodes[k], p = n.parent;
      n.children.forEach(function (ch) { if (nodes[ch]) nodes[ch].parent = p; });
      if (nodes[p]) {
        var merged = [];
        nodes[p].children.forEach(function (x) {
          if (x === k) merged = merged.concat(n.children); else merged.push(x);
        });
        nodes[p].children = merged.filter(function (x) { return nodes[x] && !removed[x]; });
      }
    });
    Object.keys(removed).forEach(function (k) { delete nodes[k]; });

    /* 可达节点顺序 + 默认路径（每个分支取最新那个） */
    var order = [], seen = {};
    function walk(id) {
      if (seen[id] || !nodes[id]) return;
      seen[id] = 1;
      order.push(id);
      nodes[id].children.forEach(walk);
    }
    var roots = Object.keys(nodes).filter(function (k) { return nodes[k].parent === 'root'; });
    var rawOrder = Object.keys(raw);
    roots.sort(function (a, b) { return rawOrder.indexOf(a) - rawOrder.indexOf(b); });
    roots.forEach(walk);
    Object.keys(nodes).forEach(function (k) {
      nodes[k].children = nodes[k].children.filter(function (x) { return nodes[x] && seen[x]; });
    });
    var path = [];
    function descend(id) {
      var cur = id;
      while (cur && nodes[cur]) {
        path.push(cur);
        var kids = nodes[cur].children;
        if (!kids.length) break;
        cur = kids[kids.length - 1];
      }
    }
    if (roots.length) descend(roots[roots.length - 1]);

    var out = {}, models = [], chars = 0, files = 0, sources = 0;
    order.forEach(function (id) {
      var n = nodes[id], m = n.msg || {};
      var item = { p: n.parent, c: n.children, o: roleOf(n.frags), g: n.frags };
      if (m.inserted_at) item.d = m.inserted_at;
      if (m.model) {
        item.m = m.model;
        if (models.indexOf(m.model) < 0) models.push(m.model);
      }
      n.frags.forEach(function (g) {
        if (typeof g.x === 'string') chars += g.x.length;
        else if (g.k === 'f') files += g.f.length;
        else if (g.k === 's') sources += g.n;
      });
      out[id] = item;
    });

    var rid;
    if (roots.length === 1) rid = roots[0];
    else {
      rid = 'root';
      var withRoot = { root: { p: null, c: roots, o: 'x', g: [] } };
      order.forEach(function (id) { withRoot[id] = out[id]; });
      out = withRoot;
    }

    var firstUser = '';
    path.forEach(function (id) {
      if (firstUser) return;
      out[id].g.forEach(function (g) { if (!firstUser && g.k === 'q') firstUser = g.x; });
    });
    var turns = path.filter(function (id) { return out[id].o === 'u'; }).length;
    var payload = { t: cleanTitle(c.title, firstUser), a: c.inserted_at || '', u: c.updated_at || '', r: rid, g: out };
    var meta = {
      i: c.id, t: payload.t, a: payload.a, u: payload.u,
      n: turns, m: models, z: chars, f: files, s: sources,
      p: String(firstUser || '').replace(/\s+/g, ' ').slice(0, 110)
    };
    return { payload: payload, meta: meta };
  }

  function convSearchText(payload) {
    var parts = [];
    Object.keys(payload.g).forEach(function (id) {
      payload.g[id].g.forEach(function (g) {
        if (typeof g.x === 'string') parts.push(g.x);
        else if (g.k === 's') parts.push(g.u.map(function (x) { return x.t; }).join(' '));
      });
    });
    return parts.join('\n').replace(/\s+/g, ' ').toLowerCase();
  }

  /* --- 合并 / 持久化 / 搜索索引 --- */
  function mergeConvs(items) {
    var added = 0, dup = 0;
    items.forEach(function (it) {
      if (state.byId[it.meta.i]) { dup++; return; }
      state.convs.push(it.meta);
      state.byId[it.meta.i] = it.meta;
      chunkCache[it.meta.i] = it.payload;
      addSearchRow(it.meta.i, it.meta.t, convSearchText(it.payload));
      added++;
    });
    if (added) {
      state.convs.sort(function (a, b) { return (b.u || b.a || '') < (a.u || a.a || '') ? -1 : 1; });
      renderList();
    }
    return { added: added, dup: dup };
  }

  function addSearchRow(id, title, text) {
    var row = [id, String(title || '').toLowerCase(), text];
    if (window.__DS_SEARCH && window.__DS_SEARCH.rows) {
      window.__DS_SEARCH.rows.push(row);
    } else {
      state.pendingSearchRows = state.pendingSearchRows || [];
      state.pendingSearchRows.push(row);
    }
  }

  function rememberImports(items) {
    return idbOpen().then(function (db) {
      return idbPutMany(db, IMPORT_STORE_META, items.reduce(function (acc, it) {
        acc[it.meta.i] = it.meta; return acc;
      }, {})).then(function () {
        return idbPutMany(db, IMPORT_STORE_CONV, items.reduce(function (acc, it) {
          acc[it.meta.i] = it.payload; return acc;
        }, {}));
      });
    });
  }

  function loadImports() {
    return idbOpen().then(function (db) {
      return Promise.all([idbGetAll(db, IMPORT_STORE_META), idbGetAll(db, IMPORT_STORE_CONV)]).then(function (r) {
        var metas = r[0], payloads = r[1];
        var items = Object.keys(metas).map(function (id) {
          return { meta: metas[id], payload: payloads[id] };
        }).filter(function (it) { return it.payload; });
        return items;
      });
    });
  }

  function importZipFile(file) {
    if (file.size > 300 * 1024 * 1024) return Promise.reject(new Error('zip 超过 300MB，太大了'));
    return file.arrayBuffer().then(function (buf) {
      var z = zipRead(buf);
      var convEnt = null, userEnt = null;
      z.entries.forEach(function (e) {
        var n = e.name.toLowerCase();
        if (!convEnt && /conversations\.json$/.test(n)) convEnt = e;
        if (!userEnt && /user\.json$/.test(n)) userEnt = e;
      });
      if (!convEnt) throw new Error('zip 里没有 conversations.json（请选 DeepSeek 设置里导出的那个 zip）');
      return Promise.all([
        zipEntryData(z, convEnt),
        userEnt ? zipEntryData(z, userEnt) : Promise.resolve(null)
      ]).then(function (r) {
        var convs = JSON.parse(new TextDecoder('utf-8').decode(r[0]));
        if (!Array.isArray(convs)) throw new Error('conversations.json 格式不对');
        var skipped = 0;
        var items = [];
        convs.forEach(function (c) {
          try { items.push(convertConversation(c)); } catch (e) { skipped++; }
        });
        var res = mergeConvs(items);
        return rememberImports(items).catch(function () { return null; }).then(function () {
          return { total: convs.length, added: res.added, dup: res.dup, skipped: skipped };
        });
      });
    });
  }

  function pickImport() {
    var input = $('#import-file');
    if (!input) return;
    input.value = '';
    input.click();
  }

  function importFromFile(file) {
    if (!file) return;
    toast('正在解析 ' + file.name + ' …');
    importZipFile(file).then(function (r) {
      var msg = '导入完成：新增 ' + r.added + ' 个对话';
      if (r.dup) msg += '，跳过重复 ' + r.dup + ' 个';
      if (r.skipped) msg += '，' + r.skipped + ' 个解析失败';
      toast(msg);
      if (r.added && !state.current) showWelcome();
    }).catch(function (e) {
      toast('导入失败：' + (e && e.message ? e.message : e));
    });
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    bindUI();
    renderList();
    updateFloats();
    loadImports().then(function (items) {
      if (!items.length) return;
      var res = mergeConvs(items);
      if (res.added && !state.current) showWelcome();
      console.log('[reader] 已从本机恢复 ' + res.added + ' 个导入的对话');
    }).catch(function () { /* IndexedDB 不可用（某些浏览器禁止 file:// 存储）时静默降级 */ });
    if (location.hash) openFromHash();
    else {
      showWelcome();
      // treat the first entry as "already read" default? no — keep the welcome screen
    }
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* small hook for tests / manual poking from the console */
  window.__DSR = {
    protect: protect, mdToHtml: mdToHtml, buildPath: buildPath,
    state: state, open: open, renderConv: renderConv, loadConv: loadConv, prof: PROF
  };
})();
