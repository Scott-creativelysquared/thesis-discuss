/* Creatively Squared thesis: discussion, sharing and attribution. No dependencies. */
import { I } from './icons.js';

const CFG = Object.assign({
  url: __SB_URL__,
  key: __SB_KEY__,
  article: 'thesis',
  content: null,           // CSS selector for the article body; defaults to [data-thesis-content] or the largest rich text block
  title: null,
  author: 'Scott Thomas',
  sectionTools: true,
  floatingShare: true,
}, window.CS_THESIS || {});

const VERSION = __VERSION__;
const enc = encodeURIComponent;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const DEVICE = (matchMedia('(pointer:coarse)').matches && Math.min(screen.width, screen.height) < 820) ? 'mobile' : 'desktop';
const TOKEN_RE = /^[A-Za-z0-9]{10}$/;

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;                 // only ever used with our own static icon markup
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const icon = (name) => h('span', { html: I[name], style: 'display:inline-flex' });
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function newToken(n = 10) { let s = ''; for (const x of crypto.getRandomValues(new Uint8Array(n))) s += B62[x % 62]; return s; }
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const initials = (n) => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const rtf = new Intl.RelativeTimeFormat('en-AU', { numeric: 'auto' });
function ago(iso) {
  const s = (new Date(iso) - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, sec] of units) if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), u);
  return 'just now';
}
function toast(msg, ms = 2600) {
  $$('.csd-toast').forEach((t) => t.remove());
  const t = h('div', { class: 'csd csd-toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); return ok;
  }
}

/* ---------------- Supabase auth (PKCE) and RPC ---------------- */
const AK = 'csd-auth', PK = 'csd-pkce', RK = 'csd-return';
let session = store.get(AK);
let refreshing = null;

function saveSession(s) {
  if (!s) { session = null; store.del(AK); return; }
  session = {
    access_token: s.access_token, refresh_token: s.refresh_token,
    expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
    user: s.user ? { id: s.user.id, meta: s.user.user_metadata || {} } : session?.user,
  };
  store.set(AK, session);
}
const authPost = (path, body, token) => fetch(`${CFG.url}/auth/v1/${path}`, {
  method: 'POST',
  headers: Object.assign({ apikey: CFG.key, 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body || {}),
});
async function getToken() {
  if (!session) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  refreshing ||= (async () => {
    try {
      const r = await authPost('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
      if (!r.ok) { saveSession(null); return null; }
      saveSession(await r.json()); return session.access_token;
    } catch { return session?.access_token || null; }
  })().finally(() => { refreshing = null; });
  return refreshing;
}
function cleanUrl() {
  const u = new URL(location.href);
  ['code', 'error', 'error_code', 'error_description', 'state'].forEach((k) => u.searchParams.delete(k));
  u.hash = '';
  return u.toString();
}
async function signIn(intent) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  store.set(PK, verifier);
  store.set(RK, { intent: intent || null, y: Math.round(scrollY), hash: location.hash, visit: visitId, at: Date.now() });
  location.assign(`${CFG.url}/auth/v1/authorize?provider=linkedin_oidc&redirect_to=${enc(cleanUrl())}&code_challenge=${challenge}&code_challenge_method=s256`);
}
async function signOut() {
  const t = session?.access_token;
  saveSession(null); me = null;
  if (t) authPost('logout', {}, t).catch(() => {});
}
async function handleAuthReturn() {
  const u = new URL(location.href);
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const code = u.searchParams.get('code');
  const err = u.searchParams.get('error_description') || hashParams.get('error_description');
  if (!code && !err) return null;
  const ret = store.get(RK); store.del(RK);
  const fresh = ret && Date.now() - ret.at < 30 * 60 * 1000 ? ret : null;
  ['code', 'error', 'error_code', 'error_description', 'state'].forEach((k) => u.searchParams.delete(k));
  history.replaceState(null, '', u.pathname + u.search + (fresh?.hash || ''));
  if (err) return { error: err.replace(/\+/g, ' '), ret: fresh };
  const verifier = store.get(PK); store.del(PK);
  if (!verifier) return { error: 'Sign-in expired, please try again.', ret: fresh };
  try {
    const r = await authPost('token?grant_type=pkce', { auth_code: code, code_verifier: verifier });
    if (!r.ok) return { error: 'LinkedIn sign-in did not complete. Please try again.', ret: fresh };
    saveSession(await r.json());
    return { ret: fresh };
  } catch { return { error: 'LinkedIn sign-in did not complete. Please try again.', ret: fresh }; }
}

async function rpc(fn, args, { auth = true, keepalive = false } = {}) {
  const call = async (token) => {
    const headers = { apikey: CFG.key, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(`${CFG.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args || {}), keepalive });
  };
  const token = auth ? await getToken() : null;
  let r = await call(token);
  if (r.status === 401 && token) { saveSession(null); r = await call(null); }
  if (r.status === 204) return null;
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch {}
  if (!r.ok) { const e = new Error(data?.message || 'HTTP ' + r.status); e.code = data?.code; e.status = r.status; throw e; }
  return data;
}

/* ---------------- Article indexing ---------------- */
let roots = [];
const sections = [];
const sectionById = new Map();
const TITLE = () => CFG.title || $('meta[property="og:title"]')?.content || document.title;

function slug(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
}
function findRoots() {
  if (CFG.content) return $$(CFG.content);
  const tagged = $$('[data-thesis-content]');
  if (tagged.length) return tagged;
  let best = null, n = 0;
  for (const el of $$('.w-richtext')) { const c = el.querySelectorAll('p').length; if (c > n) { n = c; best = el; } }
  return best ? [best] : $$('article').slice(0, 1);
}
function indexArticle() {
  const used = new Set();
  const uniq = (id) => { let x = id, i = 2; while (used.has(x) || (document.getElementById(x) && !document.getElementById(x).matches('h2'))) x = `${id}-${i++}`; used.add(x); return x; };
  let sec = { id: 'intro', title: 'Introduction', el: null, n: 0 };
  used.add('intro'); sections.push(sec); sectionById.set('intro', sec);
  for (const root of roots) {
    for (const el of root.querySelectorAll('h2,h3,h4,p,li,blockquote,figcaption')) {
      if (el.closest('.csd')) continue;
      if (el.tagName === 'H2') {
        const title = el.textContent.replace(/\s+/g, ' ').trim();
        if (!title) continue;
        const id = el.id && /^[A-Za-z0-9_-]{1,100}$/.test(el.id) ? (used.add(el.id), el.id) : uniq(slug(title));
        el.id = id;
        sec = { id, title: title.slice(0, 200), el, n: 0 };
        sections.push(sec); sectionById.set(id, sec);
        continue;
      }
      if ((el.tagName === 'LI' || el.tagName === 'BLOCKQUOTE') && el.querySelector('p')) continue;
      if (!el.textContent.trim()) continue;
      const pid = `${sec.id}--${++sec.n}`;
      el.dataset.csdPid = pid; el.dataset.csdSec = sec.id;
      if (!el.id) el.id = pid;
    }
  }
  if (!sections[0].n) { sections.shift(); sectionById.delete('intro'); }
  const payload = sections.map((s) => ({ id: s.id, title: s.title }));
  rpc('register_sections', { p_article: CFG.article, p_sections: payload }, { auth: false }).catch(() => {});
}
const passageEl = (pid) => pid && $(`[data-csd-pid="${CSS.escape(pid)}"]`);

/* ---------------- Visit and engagement tracking ---------------- */
const urlRef = new URL(location.href).searchParams.get('ref');
const REF = urlRef && TOKEN_RE.test(urlRef) ? urlRef : null;
let visitId = null;
let active = 0, lastAct = Date.now(), maxScroll = 0, reachedEnd = false, lastSent = '';

function referrerHost() {
  try { const r = new URL(document.referrer); return r.host === location.host ? null : r.host; } catch { return null; }
}
async function startVisit(restoredVisit) {
  if (restoredVisit) { visitId = restoredVisit; return null; }
  const landing = location.hash.replace(/^#/, '').split(':~:')[0];
  try {
    const r = await rpc('record_visit', {
      p_article: CFG.article, p_token: REF, p_referrer_host: referrerHost(), p_device: DEVICE,
      p_passage: /^[A-Za-z0-9_-]{1,120}$/.test(landing) ? landing : null,
    });
    visitId = r?.visit_id || null;
    return r?.share || null;
  } catch { return null; }
}
function sendEngagement() {
  if (!visitId) return;
  const sig = `${maxScroll}|${active}|${reachedEnd}`;
  if (sig === lastSent) return;
  lastSent = sig;
  // synchronous fetch with keepalive so it survives page unload
  fetch(`${CFG.url}/rest/v1/rpc/record_engagement`, {
    method: 'POST', keepalive: true,
    headers: { apikey: CFG.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_visit: visitId, p_scroll: maxScroll, p_seconds: active, p_end: reachedEnd }),
  }).catch(() => {});
}
function trackEngagement() {
  const mark = () => { lastAct = Date.now(); };
  ['scroll', 'pointermove', 'keydown', 'touchstart'].forEach((e) => addEventListener(e, mark, { passive: true }));
  setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - lastAct < 30000) active++; }, 1000);
  const measure = () => {
    if (!roots.length) return;
    const top = roots[0].getBoundingClientRect().top + scrollY;
    const bottom = roots[roots.length - 1].getBoundingClientRect().bottom + scrollY;
    const seen = scrollY + innerHeight;
    const pct = Math.max(0, Math.min(100, Math.round(((seen - top) / Math.max(1, bottom - top)) * 100)));
    if (pct > maxScroll) maxScroll = pct;
    if (seen >= bottom - 40) reachedEnd = true;
  };
  addEventListener('scroll', debounce(measure, 150), { passive: true });
  measure();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sendEngagement(); });
  addEventListener('pagehide', sendEngagement);
  setTimeout(sendEngagement, 15000);
  setInterval(sendEngagement, 60000);
}

/* ---------------- Highlighting a shared passage ---------------- */
function markText(el, quote) {
  const q = quote.replace(/…$/, '').replace(/\s+/g, ' ').trim();
  if (!q) return null;
  const nodes = []; let full = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) { nodes.push({ n: walker.currentNode, s: full.length }); full += walker.currentNode.data; }
  const re = new RegExp(q.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
  const m = re.exec(full);
  if (!m) return null;
  const start = m.index, end = m.index + m[0].length;
  let first = null;
  for (const { n, s } of nodes) {
    const e = s + n.data.length;
    if (e <= start || s >= end) continue;
    let node = n;
    const a = Math.max(0, start - s), b = Math.min(n.data.length, end - s);
    if (b < node.data.length) node.splitText(b);
    if (a > 0) node = node.splitText(a);
    const mk = h('mark', { class: 'csd-hl' });
    node.parentNode.insertBefore(mk, node); mk.append(node);
    first ||= mk;
  }
  return first;
}
function revealShare(share) {
  if (!share) return;
  if (share.kind === 'comment' && share.comment_id) { pendingCommentFocus = share.comment_id; return; }
  const el = passageEl(share.passage) || (share.section && document.getElementById(share.section));
  if (!el) return;
  const target = (share.quote && markText(el, share.quote)) || el;
  if (!share.quote) el.classList.add('csd-flash');
  if (scrollY < 80) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ---------------- Sharing ---------------- */
const CH = {
  teams: { label: 'Teams', icon: 'teams', color: '#5B5FC7' },
  linkedin: { label: 'LinkedIn', icon: 'linkedin', color: '#0A66C2' },
  whatsapp: { label: 'WhatsApp', icon: 'whatsapp', color: '#25D366' },
  email: { label: 'Email', icon: 'mail', color: '#210042' },
  copy: { label: 'Copy link', icon: 'link', color: '#009DA2' },
  slack: { label: 'Slack', icon: 'slack', color: '#4A154B' },
  facebook: { label: 'Facebook', icon: 'facebook', color: '#1877F2' },
  x: { label: 'X', icon: 'xlogo', color: '#000000' },
  bluesky: { label: 'Bluesky', icon: 'bluesky', color: '#0085FF' },
  telegram: { label: 'Telegram', icon: 'telegram', color: '#26A5E4' },
  native: { label: 'More apps', icon: 'apps', color: '#4a3a66' },
};
const PRIMARY = ['teams', 'linkedin', 'whatsapp', 'email', 'copy'];
const MORE = ['slack', 'facebook', 'x', 'bluesky', 'telegram'];

function textFragment(q) {
  const words = q.replace(/[“”"]/g, '').replace(/…$/, '').trim().split(/\s+/).filter(Boolean);
  const e = (s) => enc(s).replace(/-/g, '%2D').replace(/,/g, '%2C').replace(/&/g, '%26');
  if (!words.length) return '';
  if (words.length <= 8) return ':~:text=' + e(words.join(' '));
  return ':~:text=' + e(words.slice(0, 5).join(' ')) + ',' + e(words.slice(-4).join(' '));
}
function shareUrl(token, ctx) {
  let u = `${location.origin}${location.pathname}?ref=${token}`;
  let anchor = '';
  if (ctx.kind === 'comment') anchor = 'comment-' + ctx.comment_id;
  else if (ctx.passage) anchor = ctx.passage;
  else if (ctx.section && ctx.section !== 'intro') anchor = ctx.section;
  if (anchor) u += '#' + anchor + (ctx.kind === 'excerpt' && ctx.quote ? textFragment(ctx.quote) : '');
  return u;
}
function shareText(ctx) {
  const t = TITLE();
  if (ctx.kind === 'excerpt' && ctx.quote) return `“${ctx.quote}”\n\nFrom “${t}” by ${CFG.author}`;
  if (ctx.kind === 'section') return `“${sectionById.get(ctx.section)?.title || ''}”, from “${t}” by ${CFG.author}`;
  if (ctx.kind === 'comment') return `A comment in the discussion on “${t}”`;
  return `“${t}” by ${CFG.author}`;
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function teamsLauncherSupported() {
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand).join(' ');
  return DEVICE === 'desktop' && /Google Chrome|Microsoft Edge/.test(brands);
}
let teamsLoad = null;
function loadTeams() {
  if (!teamsLauncherSupported()) return Promise.resolve(false);
  teamsLoad ||= new Promise((res) => {
    const s = h('script', { src: 'https://teams.microsoft.com/share/launcher.js', async: true });
    s.onload = () => res(!!window.shareToMicrosoftTeams);
    s.onerror = () => res(false);
    document.head.append(s);
    setTimeout(() => res(!!window.shareToMicrosoftTeams), 6000);
  });
  return teamsLoad;
}
function openPopup(url) {
  const w = 640, ht = 680;
  window.open(url, '_blank', `noopener,width=${w},height=${ht},left=${Math.max(0, (screen.width - w) / 2)},top=${Math.max(0, (screen.height - ht) / 3)}`);
}
function shareTeams(url, msg) {
  const direct = `https://teams.microsoft.com/share?href=${enc(url)}&msgText=${enc(msg)}&preview=true&referrer=${enc(location.hostname)}`;
  const api = window.shareToMicrosoftTeams;
  if (api && typeof api.renderButtons === 'function') {
    // Microsoft's official Share to Teams launcher, rendered off-screen with this share's tracked link
    const host = h('div', { class: 'teams-share-button', 'data-href': url, 'data-msg-text': msg, 'data-preview': 'true', 'data-icon-px-size': '16', style: 'position:fixed;left:-9999px;top:0' });
    document.body.append(host);
    try {
      api.renderButtons({ elements: [host] });
      const target = host.querySelector('a,button,img,[role=button]') || host;
      target.click();
      setTimeout(() => host.remove(), 1500);
      return;
    } catch { host.remove(); }
  }
  openPopup(direct);
}

async function doShare(channel, ctx) {
  const token = newToken();
  const url = shareUrl(token, ctx);
  const text = shareText(ctx);
  rpc('record_share', {
    p_token: token, p_article: CFG.article, p_channel: channel, p_kind: ctx.kind,
    p_section: ctx.section || null, p_passage: ctx.passage || null, p_quote: ctx.quote || null,
    p_comment: ctx.comment_id || null, p_parent: REF, p_visit: visitId, p_device: DEVICE,
  }, { keepalive: true }).catch(() => {});

  switch (channel) {
    case 'teams': shareTeams(url, clip(text.replace(/\n+/g, ' '), 200)); break;
    case 'linkedin':
      if (ctx.kind === 'excerpt' || ctx.kind === 'comment') { await copyText(text); toast('Quote copied. Paste it into your LinkedIn post.', 3600); }
      openPopup(`https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`); break;
    case 'whatsapp': {
      const wa = `https://wa.me/?text=${enc(text + '\n\n' + url)}`;
      if (DEVICE === 'mobile') location.href = wa; else openPopup(wa);
      break;
    }
    case 'email':
      location.href = `mailto:?subject=${enc(TITLE())}&body=${enc(text + '\n\n' + url)}`; break;
    case 'copy':
      toast((await copyText(url)) ? 'Link copied' : 'Could not copy the link');
      break;
    case 'slack':
      toast((await copyText(text + '\n' + url)) ? 'Copied. Paste it into Slack.' : 'Could not copy'); break;
    case 'facebook': openPopup(`https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`); break;
    case 'x': openPopup(`https://x.com/intent/post?text=${enc(clip(text, 200))}&url=${enc(url)}`); break;
    case 'bluesky': openPopup(`https://bsky.app/intent/compose?text=${enc(clip(text, 230) + '\n' + url)}`); break;
    case 'telegram': openPopup(`https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`); break;
    case 'native':
      try { await navigator.share({ title: TITLE(), text, url }); } catch {}
      break;
  }
}

function closeSheet() { $('.csd-scrim')?.remove(); document.removeEventListener('keydown', escClose); }
function escClose(e) { if (e.key === 'Escape') closeSheet(); }
function openShareSheet(ctx) {
  closeSheet();
  loadTeams();
  const titles = { article: 'Share this article', section: 'Share this section', excerpt: 'Share this passage', comment: 'Share this comment' };
  const sub = ctx.kind === 'section' ? sectionById.get(ctx.section)?.title
    : ctx.kind === 'comment' ? 'People who open it land on this comment.'
      : ctx.kind === 'excerpt' ? 'People who open it land on this passage, highlighted.' : TITLE();
  const tile = (ch) => h('button', { class: 'csd-tile', type: 'button', 'data-ch': ch, onclick: () => { doShare(ch, ctx); if (ch !== 'copy' && ch !== 'slack') closeSheet(); } },
    h('span', { class: 'csd-ico', style: `background:${CH[ch].color}` }, icon(CH[ch].icon)), CH[ch].label);
  const more = h('div', { class: 'csd-grid csd-more' }, MORE.map(tile), DEVICE !== 'mobile' && navigator.share ? tile('native') : null);
  const sheet = h('div', { class: 'csd-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': titles[ctx.kind] },
    h('button', { class: 'csd-x', type: 'button', 'aria-label': 'Close', onclick: closeSheet }, icon('x')),
    h('h3', {}, titles[ctx.kind]),
    sub ? h('p', { class: 'csd-sheet-sub' }, sub) : null,
    ctx.quote ? h('blockquote', { class: 'csd-q' }, ctx.quote) : null,
    h('div', { class: 'csd-grid' }, PRIMARY.map(tile), DEVICE === 'mobile' && navigator.share ? tile('native') : null),
    h('button', { class: 'csd-more-toggle', type: 'button', 'aria-expanded': 'false', onclick: (e) => { const open = more.classList.toggle('is-open'); e.currentTarget.setAttribute('aria-expanded', open); e.currentTarget.textContent = open ? 'Fewer options' : 'More: Slack, Facebook, X and others'; } }, 'More: Slack, Facebook, X and others'),
    more,
    h('p', { class: 'csd-note' }, 'No sign-in needed to share. Each link is unique so we can see which channels people read from. We never see your messages.'));
  const scrim = h('div', { class: 'csd csd-scrim', onclick: (e) => { if (e.target === scrim) closeSheet(); } }, sheet);
  document.body.append(scrim);
  document.addEventListener('keydown', escClose);
  sheet.querySelector('.csd-tile').focus({ preventScroll: true });
}

function shareBar(label) {
  const ctx = { kind: 'article' };
  return h('div', { class: 'csd csd-bar' },
    label ? h('span', { class: 'csd-bar-label' }, label) : null,
    PRIMARY.map((ch) => h('button', { class: 'csd-chip', type: 'button', 'aria-label': `Share via ${CH[ch].label}`, onclick: () => doShare(ch, ctx) },
      icon(CH[ch].icon), h('span', { class: 'csd-chip-label' }, CH[ch].label))),
    h('button', { class: 'csd-chip', type: 'button', 'aria-label': 'More ways to share', onclick: () => openShareSheet(ctx) }, icon('dots'), h('span', { class: 'csd-chip-label' }, 'More')));
}

/* ---------------- Selection toolbar ---------------- */
let selBox = null;
function hideSel() { selBox?.remove(); selBox = null; }
function onSelection() {
  const s = getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return hideSel();
  const range = s.getRangeAt(0);
  const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const p = node?.closest?.('[data-csd-pid]');
  if (!p || p.closest('.csd')) return hideSel();
  const text = s.toString().replace(/\s+/g, ' ').trim();
  if (text.length < 8) return hideSel();
  const ctx = { kind: 'excerpt', quote: clip(text, 600), passage: p.dataset.csdPid, section: p.dataset.csdSec };
  const rect = range.getBoundingClientRect();
  hideSel();
  selBox = h('div', { class: 'csd csd-sel', role: 'toolbar', 'aria-label': 'Share or discuss this passage', onmousedown: (e) => e.preventDefault() },
    h('button', { type: 'button', onclick: () => { hideSel(); openShareSheet(ctx); } }, icon('share'), 'Share'),
    h('button', { type: 'button', onclick: () => { hideSel(); s.removeAllRanges(); discuss.openWith({ quote: ctx.quote, passage: ctx.passage, section: ctx.section }); } }, icon('chat'), 'Discuss'),
    h('button', { type: 'button', onclick: () => { hideSel(); doShare('copy', ctx); } }, icon('link'), 'Copy link'));
  document.body.append(selBox);
  const w = selBox.offsetWidth, ht = selBox.offsetHeight;
  const below = DEVICE === 'mobile' || rect.top < ht + 16;
  const top = (below ? rect.bottom + 12 : rect.top - ht - 10) + scrollY;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), document.documentElement.clientWidth - w - 8) + scrollX;
  selBox.style.top = top + 'px'; selBox.style.left = left + 'px';
}

/* ---------------- Discussion ---------------- */
let me = null;                 // { id, full_name, avatar_url, linkedin_url, is_admin }
let comments = [];
let pendingCommentFocus = null;

function avatar(name, url) {
  const fallback = () => h('span', { class: 'csd-av', 'aria-hidden': 'true' }, initials(name));
  if (!url) return fallback();
  const img = h('img', { class: 'csd-av', src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.onerror = () => img.replaceWith(fallback());
  return img;
}
async function loadMe() {
  if (!session) { me = null; return; }
  try { const r = await rpc('get_my_profile'); me = (Array.isArray(r) ? r[0] : r) || null; if (!me) await signOut(); } catch { me = null; }
}

const discuss = (() => {
  let root, listEl, compEl, filterEl, headCount, sort = 'newest', filter = null, topCtx = null;
  const state = { draft: '' };

  function mount() {
    const anchor = $('[data-thesis-comments]');
    root = h('section', { class: 'csd csd-disc', id: 'discussion', 'aria-label': 'Discussion' });
    if (anchor) anchor.append(root); else roots[roots.length - 1].after(root);
    headCount = h('span', { class: 'csd-count' });
    const sortBtns = ['newest', 'oldest'].map((s) => h('button', { type: 'button', class: s === sort ? 'is-on' : '', onclick: (e) => { sort = s; [...e.currentTarget.parentNode.children].forEach((b) => b.classList.toggle('is-on', b === e.currentTarget)); renderList(); } }, s === 'newest' ? 'Newest' : 'Oldest'));
    root.append(
      h('div', { class: 'csd-disc-h' }, h('h2', {}, 'Discussion ', headCount), h('div', { class: 'csd-sort' }, sortBtns)),
      filterEl = h('div'),
      compEl = h('div'),
      listEl = h('div', { class: 'csd-list', 'aria-live': 'polite' }));
    renderComposer();
  }

  function renderComposer(focus) {
    compEl.replaceChildren(composer({ ctx: topCtx, draft: state.draft, onDraft: (v) => { state.draft = v; }, onClearCtx: () => { topCtx = null; renderComposer(); }, focus,
      onPosted: () => { state.draft = ''; topCtx = null; renderComposer(); } }));
  }

  function openWith(ctx) {
    topCtx = ctx;
    if (ctx?.section && !ctx.quote) setFilter(ctx.section);
    renderComposer(true);
    root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setFilter(sec) {
    filter = sec;
    filterEl.replaceChildren(sec ? h('div', { class: 'csd-filter' }, 'Showing comments on ', h('b', {}, sectionById.get(sec)?.title || sec),
      h('button', { type: 'button', onclick: () => setFilter(null) }, 'Show all')) : '');
    renderList();
  }

  async function load() {
    try { comments = (await rpc('get_comments', { p_article: CFG.article })) || []; } catch { comments = []; }
    renderList();
    updateSectionCounts();
  }

  function renderList() {
    const live = comments.filter((c) => c.status === 'published');
    headCount.textContent = live.length ? `(${live.length})` : '';
    const byParent = new Map();
    for (const c of comments) { const k = c.parent_id || 'root'; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(c); }
    let top = byParent.get('root') || [];
    if (filter) top = top.filter((c) => c.section === filter);
    top = [...top].sort((a, b) => (sort === 'newest' ? -1 : 1) * (new Date(a.created_at) - new Date(b.created_at)));
    const node = (c, depth) => commentEl(c, depth, (byParent.get(c.id) || []).map((r) => node(r, Math.min(depth + 1, 3))));
    listEl.replaceChildren(...(top.length ? top.map((c) => node(c, 0)) : [h('div', { class: 'csd-empty' }, filter ? 'No comments on this section yet. Start the conversation.' : 'No comments yet. Start the conversation.')]));
    if (pendingCommentFocus) focusComment(pendingCommentFocus);
  }

  function focusComment(id) {
    const el = document.getElementById('comment-' + id);
    if (!el) return;
    pendingCommentFocus = null;
    el.classList.add('csd-flash');
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }

  function commentEl(c, depth, children) {
    const live = c.status === 'published';
    const sec = c.section && sectionById.get(c.section);
    const nameEl = c.author_linkedin
      ? h('a', { class: 'csd-name', href: c.author_linkedin, target: '_blank', rel: 'nofollow noopener ugc' }, c.author_name, icon('linkedin'))
      : h('span', { class: 'csd-name' }, c.author_name || 'Removed');
    const wrap = h('article', { class: 'csd-c', id: 'comment-' + c.id });
    const replyBox = h('div');
    const actions = h('div', { class: 'csd-c-a' });
    if (live) {
      actions.append(h('button', { type: 'button', onclick: () => {
        if (replyBox.firstChild) { replyBox.replaceChildren(); return; }
        replyBox.replaceChildren(composer({ parent: c, focus: true, onCancel: () => replyBox.replaceChildren(), onPosted: () => replyBox.replaceChildren() }));
      } }, icon('reply'), 'Reply'));
      actions.append(h('button', { type: 'button', onclick: () => openShareSheet({ kind: 'comment', comment_id: c.id, section: c.section, passage: c.passage, quote: clip(c.body, 280) }) }, icon('share'), 'Share'));
    }
    if (c.is_mine && live) actions.append(h('button', { type: 'button', class: 'is-danger', onclick: async () => {
      if (!confirmInline(actions, 'Delete your comment?')) return;
    } }, icon('trash'), 'Delete'));
    if (c.can_moderate && c.status !== 'deleted') actions.append(h('button', { type: 'button', class: 'is-danger', onclick: async () => {
      try { await rpc('moderate_comment', { p_id: c.id, p_status: live ? 'hidden' : 'published' }); toast(live ? 'Comment hidden' : 'Comment restored'); load(); } catch (e) { toast('Could not update: ' + e.message); }
    } }, icon('eye'), live ? 'Hide' : 'Restore'));

    const showBody = c.body != null;
    wrap.append(
      h('div', { class: 'csd-c-h' },
        showBody ? avatar(c.author_name, c.author_avatar) : h('span', { class: 'csd-av' }, '–'),
        showBody ? nameEl : h('span', { class: 'csd-name csd-muted' }, 'Removed'),
        h('a', { class: 'csd-time', href: '#comment-' + c.id, title: new Date(c.created_at).toLocaleString('en-AU') }, ago(c.created_at)),
        c.status === 'hidden' && showBody ? h('span', { class: 'csd-badge is-warn' }, 'Hidden') : null,
        c.is_mine && live ? h('span', { class: 'csd-badge' }, 'You') : null,
        depth === 0 && sec && !c.quote ? h('a', { class: 'csd-time', href: '#' + sec.id }, 'on ' + sec.title) : null),
      c.quote && showBody ? h('a', { class: 'csd-c-q', href: '#' + (c.passage || c.section || ''), onclick: (e) => { const el = passageEl(c.passage); if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('csd-flash'); void el.offsetWidth; el.classList.add('csd-flash'); } } },
        '“' + c.quote + '”', sec ? h('small', {}, 'From ' + sec.title) : null) : null,
      showBody
        ? h('p', { class: 'csd-c-b' + (live ? '' : ' is-dim') }, c.body)
        : h('p', { class: 'csd-c-b is-dim' }, c.status === 'deleted' ? 'Deleted by the author.' : 'Removed by a moderator.'),
      actions, replyBox, ...children);
    return wrap;
  }

  function confirmInline(actions, q) {
    // two-tap confirmation without browser dialogs
    if (actions.dataset.confirm === q) {
      delete actions.dataset.confirm;
      const id = actions.closest('.csd-c').id.replace('comment-', '');
      rpc('delete_own_comment', { p_id: id }).then(() => { toast('Comment deleted'); load(); }).catch((e) => toast('Could not delete: ' + e.message));
      return true;
    }
    actions.dataset.confirm = q;
    toast('Tap Delete again to confirm');
    setTimeout(() => { delete actions.dataset.confirm; }, 4000);
    return false;
  }

  function updateSectionCounts() {
    const counts = {};
    for (const c of comments) if (c.status === 'published' && c.section) counts[c.section] = (counts[c.section] || 0) + 1;
    for (const b of $$('[data-csd-discuss]')) {
      const n = counts[b.dataset.csdDiscuss] || 0;
      b.querySelector('.csd-n').textContent = n ? `Discuss · ${n}` : 'Discuss';
    }
  }

  return { mount, load, openWith, focusComment, renderComposer, setFilter };
})();

function composer({ parent = null, ctx = null, draft = '', onDraft, onClearCtx, onCancel, onPosted, focus }) {
  if (!session || !me) {
    return h('div', { class: 'csd-signin' },
      h('p', {}, parent ? `Sign in with LinkedIn to reply to ${parent.author_name}.` : 'Join the discussion. Sign in with LinkedIn to comment or reply.'),
      h('button', { class: 'csd-li', type: 'button', onclick: () => signIn({ parent: parent?.id || null, ctx, draft }) }, icon('linkedin'), 'Sign in with LinkedIn'),
      h('p', { class: 'csd-fine' }, 'We show your LinkedIn name and photo next to your comment. We never post to LinkedIn. Reading and sharing never need sign-in.'),
      onCancel ? h('button', { class: 'csd-link', type: 'button', onclick: onCancel }, 'Cancel') : null);
  }
  const ta = h('textarea', { 'aria-label': parent ? 'Write a reply' : 'Add a comment', placeholder: parent ? `Reply to ${parent.author_name}…` : 'What do you think? Agree, disagree, add evidence…', maxlength: '4000' });
  ta.value = draft || '';
  const err = h('p', { class: 'csd-err', role: 'alert', hidden: true });
  const post = h('button', { class: 'csd-post', type: 'button', disabled: !ta.value.trim() }, parent ? 'Reply' : 'Post');
  ta.addEventListener('input', () => { post.disabled = !ta.value.trim(); onDraft?.(ta.value); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
  async function submit() {
    const body = ta.value.trim();
    if (!body) return;
    post.disabled = true; err.hidden = true;
    try {
      const id = await rpc('post_comment', {
        p_article: CFG.article, p_body: body, p_parent: parent?.id || null,
        p_section: ctx?.section || null, p_passage: ctx?.passage || null, p_quote: ctx?.quote || null,
        p_ref: REF, p_visit: visitId,
      });
      onPosted?.();
      pendingCommentFocus = id;
      await discuss.load();
      toast(parent ? 'Reply posted' : 'Comment posted');
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message === 'rate_limited' ? 'You are posting quickly. Please wait a minute.'
        : e.status === 401 || e.code === '28000' ? 'Your sign-in expired. Please sign in again.' : 'Could not post: ' + e.message;
      if (e.status === 401 || e.code === '28000') { await signOut(); discuss.renderComposer(); }
      post.disabled = false;
    }
  }
  post.addEventListener('click', submit);
  const sec = ctx?.section && sectionById.get(ctx.section);
  const profRow = !parent && !me.linkedin_url ? profilePrompt() : null;
  const box = h('div', { class: 'csd-comp' },
    h('div', { class: 'csd-comp-who' }, avatar(me.full_name, me.avatar_url), me.full_name,
      h('button', { class: 'csd-out', type: 'button', onclick: async () => { await signOut(); discuss.renderComposer(); discuss.load(); } }, 'Sign out')),
    ctx && (ctx.quote || sec) ? h('div', { class: 'csd-comp-q' }, h('span', {}, ctx.quote ? `“${ctx.quote}”` : `On: ${sec.title}`),
      onClearCtx ? h('button', { type: 'button', 'aria-label': 'Remove quote', onclick: onClearCtx }, '×') : null) : null,
    ta,
    h('div', { class: 'csd-comp-f' },
      h('span', { class: 'csd-hint' }, 'Public, under your LinkedIn name'),
      onCancel ? h('button', { class: 'csd-cancel', type: 'button', onclick: onCancel }, 'Cancel') : null,
      post),
    err, profRow);
  if (focus) setTimeout(() => ta.focus({ preventScroll: false }), 60);
  return box;
}

function profilePrompt() {
  const row = h('div', { class: 'csd-prof' });
  const open = () => {
    const inp = h('input', { type: 'url', inputmode: 'url', placeholder: 'https://www.linkedin.com/in/your-name', 'aria-label': 'Your LinkedIn profile link' });
    const save = h('button', { type: 'button', onclick: async () => {
      try { me.linkedin_url = await rpc('set_linkedin_url', { p_url: inp.value }); toast('Profile link saved'); row.remove(); discuss.load(); }
      catch (e) { toast(e.message === 'invalid_linkedin_url' ? 'That doesn’t look like a linkedin.com/in/ profile link' : 'Could not save'); }
    } }, 'Save');
    row.replaceChildren(inp, save);
    inp.focus();
  };
  row.append(h('button', { class: 'csd-link', type: 'button', onclick: open }, 'Link your name to your LinkedIn profile (optional)'));
  return row;
}

/* ---------------- Section tools and floating share ---------------- */
function addSectionTools() {
  for (const s of sections) {
    if (!s.el) continue;
    const tools = h('div', { class: 'csd csd-sec' },
      h('button', { class: 'csd-chip', type: 'button', onclick: () => openShareSheet({ kind: 'section', section: s.id }) }, icon('share'), 'Share'),
      h('button', { class: 'csd-chip', type: 'button', 'data-csd-discuss': s.id, onclick: () => discuss.openWith({ section: s.id }) }, icon('chat'), h('span', { class: 'csd-n' }, 'Discuss')));
    s.el.after(tools);
  }
}
function addFloatingShare() {
  const fab = h('button', { class: 'csd csd-fab', type: 'button', 'aria-label': 'Share this article', onclick: () => openShareSheet({ kind: 'article' }) }, icon('share'), 'Share');
  document.body.append(fab);
  const disc = $('#discussion');
  const update = () => {
    const discTop = disc ? disc.getBoundingClientRect().top : Infinity;
    fab.classList.toggle('is-on', scrollY > 700 && discTop > innerHeight * 0.6);
  };
  addEventListener('scroll', debounce(update, 80), { passive: true });
  update();
}

/* ---------------- Dashboard ---------------- */
async function mountDashboard(el) {
  el.classList.add('csd');
  const wrap = h('div', { class: 'csd-dash' });
  el.replaceChildren(wrap);
  if (!session || !me) {
    wrap.append(h('h1', {}, 'Thesis insights'), h('p', { class: 'csd-sub' }, 'Private. Sign in with an approved LinkedIn account.'), h('div', { style: 'margin-top:16px' },
      h('button', { class: 'csd-li', type: 'button', onclick: () => signIn(null) }, icon('linkedin'), 'Sign in with LinkedIn')));
    return;
  }
  if (!me.is_admin) {
    wrap.append(h('h1', {}, 'Thesis insights'), h('p', { class: 'csd-sub' }, `Signed in as ${me.full_name}. This dashboard is private and your account is not on the list.`),
      h('button', { class: 'csd-link', type: 'button', onclick: async () => { await signOut(); mountDashboard(el); } }, 'Sign out'));
    return;
  }
  let days = 30;
  const body = h('div');
  const rangeBtns = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All time']].map(([d, l]) => h('button', { type: 'button', class: d === days ? 'is-on' : '', onclick: (e) => { days = d; [...e.currentTarget.parentNode.children].forEach((b) => b.classList.toggle('is-on', b === e.currentTarget)); load(); } }, l));
  wrap.append(h('div', { class: 'csd-dash-top' },
    h('div', {}, h('h1', {}, 'Thesis insights'), h('p', { class: 'csd-sub' }, TITLE())),
    h('div', { class: 'csd-range' }, rangeBtns)), body);

  async function load() {
    body.replaceChildren(h('p', { class: 'csd-sub' }, 'Loading…'));
    let d;
    try { d = await rpc('dashboard_data', { p_article: CFG.article, p_days: days }); } catch (e) { body.replaceChildren(h('p', { class: 'csd-err' }, 'Could not load: ' + e.message)); return; }
    render(d);
  }
  const num = (n) => Number(n || 0).toLocaleString('en-AU');
  const table = (cols, rows, empty) => rows.length
    ? h('div', { class: 'csd-tbl-w' }, h('table', { class: 'csd-tbl' },
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.n ? 'n' : '' }, c.t)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: c.n ? 'n' : '' }, c.f ? c.f(r) : num(r[c.k]))))))))
    : h('p', { class: 'csd-muted' }, empty);
  const bar = (v, max, cls) => h('div', { class: 'csd-barcell' }, h('i', { class: cls || '', style: `width:${max ? Math.max(2, (v / max) * 120) : 2}px` }), num(v));
  const person = (r) => h('div', { class: 'csd-person' }, avatar(r.full_name || r.author, r.avatar_url),
    r.linkedin_url ? h('a', { href: r.linkedin_url, target: '_blank', rel: 'noopener' }, r.full_name || r.author) : (r.full_name || r.author));
  const secName = (id) => sectionById.get(id)?.title || (d_sections.get(id)) || id || '—';
  let d_sections = new Map();

  function render(d) {
    d_sections = new Map((d.sections || []).map((s) => [s.section, s.title]));
    const t = d.totals;
    const maxShare = Math.max(1, ...d.channels.map((c) => c.share_actions));
    const maxVisit = Math.max(1, ...d.channels.map((c) => c.visits));
    const maxDay = Math.max(1, ...d.daily.map((x) => x.visits));
    body.replaceChildren(
      h('div', { class: 'csd-kpis' },
        [[t.visits, 'Page visits'], [t.referred_visits, 'Visits from shared links'], [t.share_actions, 'Share actions'], [t.identified_share_actions, 'By signed-in sharers'],
          [t.comments, 'Comments and replies'], [t.comments_from_referrals, 'Comments from shared links'], [t.reached_end, 'Read to the end'], [Math.round((t.avg_active_seconds || 0) / 60) + ' min', 'Avg active reading']]
          .map(([v, l]) => h('div', { class: 'csd-kpi' }, h('b', {}, typeof v === 'number' ? num(v) : v), h('span', {}, l)))),

      h('h2', {}, 'Daily activity'),
      h('div', { class: 'csd-legend' }, h('span', {}, h('i', { class: 'v' }), 'All visits'), h('span', {}, h('i'), 'From shared links')),
      h('div', { class: 'csd-spark', title: 'Visits per day' }, d.daily.map((x) => h('div', { style: `height:${(x.visits / maxDay) * 100}%`, title: `${x.day}: ${x.visits} visits, ${x.referred} from shares, ${x.shares} shares, ${x.comments} comments` },
        h('div', { class: 'r', style: `position:absolute;bottom:0;left:0;right:0;height:${x.visits ? (x.referred / x.visits) * 100 : 0}%` })))),

      h('h2', {}, 'Channels'),
      h('p', { class: 'csd-explain' }, 'Share actions count button taps, not confirmed sends. Visits count page loads from each tracked link, so a forwarded link counts every time it is opened, and we can’t see who received it.'),
      h('div', { class: 'csd-legend' }, h('span', {}, h('i'), 'Share actions'), h('span', {}, h('i', { class: 'v' }), 'Visits generated')),
      table([
        { t: 'Channel', f: (r) => CH[r.channel]?.label || r.channel },
        { t: 'Share actions', f: (r) => bar(r.share_actions, maxShare) },
        { t: 'Visits', f: (r) => bar(r.visits, maxVisit, 'v') },
        { t: 'Links opened', k: 'links_opened', n: 1 },
        { t: 'Read to end', k: 'read_to_end', n: 1 },
        { t: 'Comments', k: 'comments', n: 1 },
        { t: 'Reshares', k: 'reshares', n: 1 },
      ], d.channels, 'No shares yet.'),

      h('h2', {}, 'Most shared excerpts'),
      table([
        { t: 'Excerpt', f: (r) => h('span', {}, '“' + clip(r.quote, 220) + '”', h('br'), h('small', { class: 'csd-muted' }, r.section_title || secName(r.section))) },
        { t: 'Shares', k: 'share_actions', n: 1 },
        { t: 'Visits', k: 'visits', n: 1 },
        { t: 'Channels', f: (r) => (r.channels || []).map((c) => CH[c]?.label || c).join(', ') },
      ], d.excerpts, 'No excerpts shared yet.'),

      h('h2', {}, 'Most discussed arguments'),
      table([
        { t: 'Section', f: (r) => r.title },
        { t: 'Comments', k: 'comments', n: 1 },
        { t: 'Replies', k: 'replies', n: 1 },
        { t: 'People', k: 'participants', n: 1 },
        { t: 'Shares', k: 'share_actions', n: 1 },
        { t: 'Landings', k: 'landings', n: 1 },
      ], d.sections, 'No section activity yet.'),

      h('h2', {}, 'Identified sharers'),
      h('p', { class: 'csd-explain' }, 'Only people who were already signed in with LinkedIn when they shared. Anonymous shares are counted above but never linked to a person.'),
      table([
        { t: 'Person', f: person },
        { t: 'Email', f: (r) => r.email || '—' },
        { t: 'Shares', k: 'share_actions', n: 1 },
        { t: 'Channels', f: (r) => (r.channels || []).map((c) => CH[c]?.label || c).join(', ') },
        { t: 'Visits generated', k: 'visits', n: 1 },
        { t: 'Comments generated', k: 'comments', n: 1 },
        { t: 'Reshares', k: 'reshares', n: 1 },
      ], d.sharers, 'No signed-in sharers yet.'),

      h('h2', {}, 'Discussion from shared links'),
      table([
        { t: 'When', f: (r) => ago(r.created_at) },
        { t: 'Commenter', f: (r) => r.author },
        { t: 'Arrived via', f: (r) => (CH[r.channel]?.label || r.channel) + (r.sharer ? `, shared by ${r.sharer}` : '') },
        { t: 'Comment', f: (r) => clip(r.body, 160) },
        { t: 'Section', f: (r) => secName(r.section) },
      ], d.referral_comments, 'No comments from shared links yet.'),

      h('h2', {}, 'Referral chains'),
      h('p', { class: 'csd-explain' }, 'Generation 1 is a share from someone who arrived without a tracked link. Generation 2 is a share by someone who arrived on a generation 1 link, and so on.'),
      table([
        { t: 'Generation', k: 'gen' },
        { t: 'Share actions', k: 'share_actions', n: 1 },
        { t: 'Visits from those links', k: 'visits', n: 1 },
      ], d.generations, 'No shares yet.'),

      h('h2', {}, 'Other referrers'),
      table([{ t: 'Source', f: (r) => r.host }, { t: 'Visits', k: 'visits', n: 1 }], d.referrers, 'No untracked visits yet.'),

      h('h2', {}, 'Moderation'),
      table([
        { t: 'When', f: (r) => ago(r.created_at) },
        { t: 'Author', f: (r) => h('span', {}, r.author, h('br'), h('small', { class: 'csd-muted' }, r.email || '')) },
        { t: 'Comment', f: (r) => clip(r.body, 200) },
        { t: 'Status', f: (r) => h('span', { class: 'csd-badge' + (r.status === 'published' ? '' : ' is-warn') }, r.status) },
        { t: '', f: (r) => r.status === 'deleted' ? '' : h('span', { class: 'csd-mod' }, h('button', { type: 'button', onclick: async () => {
          try { await rpc('moderate_comment', { p_id: r.id, p_status: r.status === 'published' ? 'hidden' : 'published' }); load(); } catch (e) { toast(e.message); }
        } }, r.status === 'published' ? 'Hide' : 'Restore')) },
      ], d.recent_comments, 'No comments yet.'),
      h('p', { class: 'csd-sub', style: 'margin-top:32px' }, `Updated ${new Date(d.generated_at).toLocaleString('en-AU')} · v${VERSION}`));
  }
  load();
}

/* ---------------- Boot ---------------- */
async function boot() {
  if (window.__csdBooted) return; window.__csdBooted = true;
  if (!document.getElementById('csd-css')) { const st = h('style', { id: 'csd-css' }); st.textContent = __CSS__; document.head.append(st); }
  const authResult = await handleAuthReturn();
  await loadMe();

  const dash = $('[data-thesis-dashboard]');
  if (__MODE__ === 'dashboard') {
    if (!dash) return;
    if (authResult?.error) toast(authResult.error, 5000);
    mountDashboard(dash);
    return;
  }
  if (dash) return;

  roots = findRoots();
  if (!roots.length) { console.warn('[thesis] no article content found'); return; }
  indexArticle();

  const share = await startVisit(authResult?.ret?.visit || null);
  trackEngagement();

  const shareMounts = $$('[data-thesis-share]');
  if (shareMounts.length) shareMounts.forEach((m) => m.append(shareBar(m.dataset.thesisShare || 'Share')));
  else {
    roots[0].before(shareBar('Share'));
    roots[roots.length - 1].after(shareBar('Know someone who should read this? Send it to them'));
  }
  if (CFG.sectionTools) addSectionTools();
  discuss.mount();
  if (CFG.floatingShare) addFloatingShare();
  document.addEventListener('selectionchange', debounce(onSelection, 250));
  addEventListener('resize', hideSel);

  revealShare(share);
  const hash = location.hash.replace(/^#/, '').split(':~:')[0];
  if (hash.startsWith('comment-')) pendingCommentFocus = hash.slice(8);
  await discuss.load();

  if (authResult) {
    if (authResult.error) toast(authResult.error, 5000);
    const intent = authResult.ret?.intent;
    if (intent && me) {
      if (intent.parent) {
        const pEl = document.getElementById('comment-' + intent.parent);
        pEl?.querySelector('.csd-c-a button')?.click();
        setTimeout(() => {
          const ta = pEl?.querySelector('.csd-comp textarea');
          if (ta && intent.draft) { ta.value = intent.draft; ta.dispatchEvent(new Event('input')); }
          pEl?.scrollIntoView({ block: 'center' });
        }, 100);
      } else {
        discuss.openWith(intent.ctx || null);
        if (intent.draft) { const ta = $('#discussion .csd-comp textarea'); if (ta) { ta.value = intent.draft; ta.dispatchEvent(new Event('input')); } }
      }
      toast(`Signed in as ${me.full_name}`);
    } else if (authResult.ret?.y != null && !location.hash) {
      scrollTo(0, authResult.ret.y);
    }
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
