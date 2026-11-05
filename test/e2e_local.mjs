// Local end-to-end smoke test: real SQL (local Postgres) behind a mocked Supabase gateway, real browser.
import { chromium, devices } from 'playwright';
import pg from 'pg';
import { readFileSync } from 'fs';

const SB = 'https://apicdwkwiqswdqefyfjp.supabase.co';
const SITE = 'https://staging.test/thesis';
const mode = process.argv[2] || 'article';
const db = new pg.Client({ host: '/var/tmp/pgtest', port: 5499, user: 'postgres', database: 't' });
await db.connect();

const users = {
  scott: { sub: '11111111-1111-1111-1111-111111111111', email: 'scott@creativelysquared.com' },
  jane: { sub: '22222222-2222-2222-2222-222222222222', email: 'jane@example.com' },
};
let loginAs = 'jane';
const tok = (u) => Buffer.from(JSON.stringify({ ...users[u], app_metadata: { provider: 'linkedin_oidc' } })).toString('base64url');
const claimsOf = (auth) => { if (!auth) return {}; try { return JSON.parse(Buffer.from(auth.replace('Bearer ', ''), 'base64url').toString()); } catch { return {}; } };

const fill = Array.from({ length: 25 }, (_, i) => `<p>Filler paragraph ${i + 1} about mental availability and reach, repeated to make the page long enough to scroll.</p>`).join('\n');
const page = (m) => readFileSync('test/page.html', 'utf8')
  .replace('__HEAD__', '')
  .replace('__FOOTER__', '<script>' + readFileSync(`dist/${m}.staging.js`, 'utf8') + '</script>')
  .replace('__FILLER__', fill)
  .replace(/<main>[\s\S]*<\/main>/, m === 'dashboard' ? '<main><div data-thesis-dashboard></div></main>' : (x) => x);

const log = [];
async function setup(ctx) {
  await ctx.route(SITE + '**', (r) => r.fulfill({ contentType: 'text/html', body: page(new URL(r.request().url()).pathname.endsWith('insights') ? 'dashboard' : 'article') }));
  await ctx.route('https://staging.test/insights**', (r) => r.fulfill({ contentType: 'text/html', body: page('dashboard') }));
  await ctx.route('https://www.linkedin.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>linkedin share</p>' }));
  await ctx.route('https://wa.me/**', (r) => r.fulfill({ contentType: 'text/html', body: 'wa' }));
  await ctx.route('https://teams.microsoft.com/**', (r) => r.fulfill({ contentType: 'text/html', body: 'teams' }));
  await ctx.route(SB + '/**', async (r) => {
    const req = r.request(); const u = new URL(req.url());
    if (u.pathname === '/auth/v1/authorize') {
      const back = new URL(u.searchParams.get('redirect_to')); back.searchParams.set('code', 'code-' + loginAs);
      return r.fulfill({ contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(back.toString())})</script>` });
    }
    if (u.pathname === '/auth/v1/token') {
      const body = JSON.parse(req.postData() || '{}');
      const who = (body.auth_code || '').replace('code-', '') || loginAs;
      if (!body.code_verifier && !body.refresh_token) return r.fulfill({ status: 400, body: '{}' });
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ access_token: tok(who), refresh_token: 'r-' + who, expires_in: 3600, user: { id: users[who].sub, user_metadata: {} } }) });
    }
    if (u.pathname === '/auth/v1/logout') return r.fulfill({ status: 204 });
    const m = u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (!m) return r.fulfill({ status: 404, body: '{}' });
    const claims = claimsOf(req.headers()['authorization']);
    const args = JSON.parse(req.postData() || '{}');
    const names = Object.keys(args);
    const sql = `select to_jsonb(x) as r from public.${m[1]}(${names.map((n, i) => `${n} => $${i + 1}`).join(',')}) x`;
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]));
    try {
      await db.query('begin');
      await db.query(`set local role ${claims.sub ? 'authenticated' : 'anon'}`);
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      const res = await db.query(sql, vals);
      await db.query('commit');
      log.push(`${m[1]} ${claims.sub ? claims.email : 'anon'}`);
      let out = res.rows.map((row) => row.r);
      const setReturning = ['get_comments', 'get_my_profile'].includes(m[1]);
      if (!setReturning) { out = out[0]; if (out && typeof out === 'object' && m[1] in out) out = out[m[1]]; }
      if (out === undefined || out === null) return r.fulfill({ status: m[1] === 'record_share' || m[1] === 'record_engagement' ? 204 : 200, contentType: 'application/json', body: 'null' });
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify(out) });
    } catch (e) {
      await db.query('rollback');
      log.push(`${m[1]} ERROR ${e.message}`);
      return r.fulfill({ status: e.code === '42501' || e.code === '28000' ? 403 : 400, contentType: 'application/json', body: JSON.stringify({ code: e.code, message: e.message }) });
    }
  });
}

const browser = await chromium.launch();
const errors = [];
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ ...(opts.device ? devices[opts.device] : { viewport: { width: 1280, height: 900 } }), permissions: ['clipboard-read', 'clipboard-write'] });
  await setup(ctx);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return { ctx, p };
}

try {
// 1. Anonymous reader: share bars, copy link, excerpt share
{
  const { p, ctx } = await newPage();
  await p.goto(SITE);
  await p.waitForSelector('.csd-bar');
  ok('share bars rendered', (await p.locator('.csd-bar').count()) === 2);
  ok('section tools rendered', (await p.locator('.csd-sec').count()) === 3);
  ok('discussion rendered', await p.locator('#discussion').isVisible());
  ok('signin prompt shown', await p.locator('.csd-signin').first().isVisible());
  await p.locator('.csd-bar').first().getByRole('button', { name: 'Share via Copy link' }).click();
  await p.waitForTimeout(300);
  const copied = await p.evaluate(() => navigator.clipboard.readText());
  ok('copy link has ref token', /\?ref=[A-Za-z0-9]{10}$/.test(copied), copied);
  // select text in paragraph 1 of section 1
  await p.evaluate(() => {
    const el = document.querySelector('[data-csd-pid="1-the-biggest-lever--2"]');
    const r = document.createRange(); const t = el.firstChild; r.setStart(t, 0); r.setEnd(t, 46);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await p.waitForSelector('.csd-sel', { timeout: 2000 }).catch(() => {});
  ok('selection toolbar appears', await p.locator('.csd-sel').isVisible());
  await p.locator('.csd-sel button', { hasText: 'Share' }).click();
  ok('share sheet shows quote', await p.locator('.csd-sheet .csd-q').isVisible());
  const [popup] = await Promise.all([ctx.waitForEvent('page'), p.locator('.csd-tile[data-ch=whatsapp]').click()]);
  const waUrl = decodeURIComponent(popup.url());
  ok('whatsapp gets quote + deep link', /Second paragraph/.test(waUrl) && /#1-the-biggest-lever--2:~:text=/.test(waUrl), waUrl.slice(0, 220));
  global.excerptLink = waUrl.match(/https:\/\/staging\.test\/thesis\?ref=[^\s]+/)[0];
  await ctx.close();
}

// 2. Recipient opens the excerpt link: highlight + visit attributed; signs in as Jane, comments
{
  const { p, ctx } = await newPage({ device: 'iPhone 13' });
  await p.goto(global.excerptLink);
  await p.waitForSelector('mark.csd-hl', { timeout: 4000 }).catch(() => {});
  ok('shared passage highlighted', (await p.locator('mark.csd-hl').count()) > 0);
  // start comment flow with selection -> discuss is desktop-ish; use section Discuss
  await p.locator('[data-csd-discuss="1-the-biggest-lever"]').click();
  loginAs = 'jane';
  p.on('request', (rq) => { if (/auth\/v1|code=/.test(rq.url())) console.log('REQ', rq.method(), rq.url().slice(0, 160)); });
  await p.locator('#discussion .csd-li').click();
  await p.waitForTimeout(2500); console.log('URL after login', p.url(), await p.evaluate(() => localStorage.getItem('csd-auth')));
  await p.waitForSelector('#discussion .csd-comp textarea', { timeout: 5000 });
  ok('returned from sign-in with composer', true);
  ok('ref kept after login', /ref=/.test(p.url()) && !/code=/.test(p.url()), p.url());
  await p.fill('#discussion .csd-comp textarea', 'Mobile test comment from Jane, arriving via WhatsApp.');
  await p.locator('#discussion .csd-post').click();
  await p.waitForSelector('.csd-c', { timeout: 4000 });
  ok('comment posted', (await p.locator('.csd-c').count()) === 1);
  ok('comment tagged with section', (await p.locator('.csd-c .csd-time', { hasText: 'on 1 The biggest lever' }).count()) === 1);
  ok('discuss count updated', (await p.locator('[data-csd-discuss="1-the-biggest-lever"]').innerText()).includes('1'));
  // share the comment via native/copy
  await p.locator('.csd-c-a button', { hasText: 'Share' }).click();
  await p.locator('.csd-tile[data-ch=copy]').click();
  await p.waitForTimeout(200);
  global.commentLink = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  ok('comment link copied', /#comment-/.test(global.commentLink), global.commentLink);
  await ctx.close();
}

// 3. Scott opens comment link, replies, moderates
{
  const { p, ctx } = await newPage();
  await p.goto(global.commentLink || SITE);
  await p.waitForSelector('.csd-c');
  ok('comment deep link flashes', (await p.locator('.csd-c.csd-flash').count()) === 1);
  loginAs = 'scott';
  await p.locator('.csd-c-a button', { hasText: 'Reply' }).click();
  await p.locator('.csd-c .csd-li').click();
  await p.waitForSelector('.csd-c .csd-comp textarea', { timeout: 5000 });
  ok('reply composer reopened after login', true);
  await p.fill('.csd-c .csd-comp textarea', 'Thanks Jane, reply from Scott.');
  await p.locator('.csd-c .csd-post').click();
  await p.waitForSelector('.csd-c .csd-c', { timeout: 4000 });
  ok('threaded reply rendered', (await p.locator('.csd-c .csd-c').count()) === 1);
  // hide Jane's comment
  await p.locator('.csd-c').first().locator('> .csd-c-a button', { hasText: 'Hide' }).click();
  await p.waitForTimeout(500);
  ok('admin sees hidden badge', (await p.locator('.csd-badge', { hasText: 'Hidden' }).count()) === 1);
  await ctx.close();
}

// 4. Anonymous sees placeholder
{
  const { p, ctx } = await newPage();
  await p.goto(SITE);
  await p.waitForSelector('.csd-c');
  ok('public sees removed placeholder', (await p.locator('.csd-c-b', { hasText: 'Removed by a moderator' }).count()) === 1);
  ok('public still sees reply', (await p.locator('.csd-c-b', { hasText: 'reply from Scott' }).count()) === 1);
  // engagement beacon on hide
  await p.mouse.wheel(0, 3000); await p.waitForTimeout(400);
  await ctx.close();
}

// 5. Dashboard: Scott
{
  const { p, ctx } = await newPage();
  loginAs = 'scott';
  await p.goto('https://staging.test/insights');
  await p.locator('.csd-li').click();
  await p.waitForSelector('.csd-kpi', { timeout: 5000 });
  const kpis = await p.locator('.csd-kpi').allInnerTexts();
  ok('dashboard loads for admin', kpis.length === 8, kpis.join(' | ').replace(/\n/g, ' '));
  ok('dashboard shows whatsapp channel', (await p.locator('td', { hasText: 'WhatsApp' }).count()) >= 1);
  ok('dashboard shows excerpt', (await p.locator('td', { hasText: 'Second paragraph' }).count()) >= 1);
  await p.screenshot({ path: 'test/dashboard.png', fullPage: true });
  await ctx.close();
}
// 6. Dashboard: Jane is refused
{
  const { p, ctx } = await newPage();
  loginAs = 'jane';
  await p.goto('https://staging.test/insights');
  await p.locator('.csd-li').click();
  await p.waitForSelector('text=not on the list', { timeout: 5000 }).catch(() => {});
  ok('non-admin refused', (await p.locator('text=not on the list').count()) === 1);
  await ctx.close();
}
// 7. Mobile screenshot of article
{
  const { p, ctx } = await newPage({ device: 'iPhone 13' });
  await p.goto(SITE);
  await p.waitForSelector('.csd-c');
  await p.screenshot({ path: 'test/mobile-top.png' });
  await p.locator('.csd-bar').first().getByRole('button', { name: 'More ways to share' }).click();
  await p.waitForTimeout(500); await p.screenshot({ path: 'test/mobile-sheet.png' });
  await ctx.close();
}

} catch (e) { results.push('CRASH ' + e.message.split('\n')[0]); }
console.log(results.join('\n'));
console.log('JS errors:', errors.length ? errors : 'none');
console.log('RPC log:', process.env.V ? log : log.filter((l) => /ERROR/.test(l)));
await browser.close(); await db.end();
