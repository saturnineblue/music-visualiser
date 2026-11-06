/**
 * Vercel Routing Middleware: password-protects the whole hosted site (pages, scripts, models).
 * Runs on Vercel only; `npm run dev` doesn't use it.
 *
 * Set the password as the SITE_PASSWORD environment variable in Vercel (see README, "Password").
 * Without it the site stays locked (fail closed) instead of being open.
 *
 * Signing in sets an HttpOnly session cookie for 30 days: an expiry time plus an HMAC of it, keyed
 * by the password, so changing the password signs everyone out. /__logout signs out.
 */

export const config = {
  runtime: 'nodejs',
  // Everything, including static assets, so nothing can be fetched without signing in.
  matcher: '/:path*',
};

const COOKIE = 'vis_session';
const SESSION_DAYS = 30;
const LOGIN_PATH = '/__login';
const LOGOUT_PATH = '/__logout';

/** Let the request through to the site (what `next()` from @vercel/functions does). */
const pass = () => new Response(null, { headers: { 'x-middleware-next': '1' } });

const enc = new TextEncoder();

async function hmacKey(password: string) {
  return crypto.subtle.importKey('raw', enc.encode(`music-visualiser-session:${password}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(password: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(password), enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compare two strings in time independent of where they differ. */
function safeEqual(a: string, b: string) {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Hash both sides first so the comparison doesn't reveal the password's length. */
async function passwordMatches(given: string, password: string) {
  const h = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].join(',');
  return safeEqual(await h(given), await h(password));
}

function getCookie(req: Request, name: string) {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function validSession(req: Request, password: string) {
  const value = getCookie(req, COOKIE);
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || +exp < Date.now()) return false;
  return safeEqual(sig, await sign(password, exp));
}

/** Only same-site paths, so the login form can't be used to redirect elsewhere. */
function safeNext(raw: string | null) {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || raw.startsWith(LOGIN_PATH)) return '/';
  return raw;
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Type': 'text/html; charset=utf-8',
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(next: string, message = '', status = 401) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Music Visualiser — sign in</title>
<style>
  html, body { margin: 0; height: 100%; background: #020205; color: #e6e8ef; font: 14px ui-sans-serif, -apple-system, system-ui, sans-serif; }
  body { display: flex; align-items: center; justify-content: center; }
  form { width: min(340px, calc(100vw - 32px)); padding: 24px; border-radius: 14px; background: #12131d; border: 1px solid rgba(255,255,255,0.09); }
  h1 { margin: 0 0 4px; font-size: 18px; }
  p { margin: 0 0 16px; color: #8a8fa3; }
  input, button { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; font: inherit; }
  input { background: rgba(255,255,255,0.06); color: inherit; border: 1px solid rgba(255,255,255,0.12); }
  input:focus { outline: 2px solid #7c9cff; border-color: transparent; }
  button { margin-top: 12px; border: 0; background: #7c9cff; color: #0b0d18; font-weight: 600; cursor: pointer; }
  .err { color: #ff6b6b; margin: 10px 0 0; }
</style></head>
<body><form method="post" action="${LOGIN_PATH}">
  <h1>Music Visualiser</h1>
  <p>This site is private. Enter the password to continue.</p>
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
  ${message ? `<p class="err">${escapeHtml(message)}</p>` : ''}
</form></body></html>`;
  return new Response(html, { status, headers: SECURITY_HEADERS });
}

export default async function middleware(req: Request): Promise<Response> {
  const password = process.env.SITE_PASSWORD;
  if (!password) {
    return new Response('This site is locked: SITE_PASSWORD is not set for this deployment.', {
      status: 503, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const url = new URL(req.url);

  if (url.pathname === LOGOUT_PATH) {
    return new Response(null, {
      status: 303,
      headers: { ...SECURITY_HEADERS, Location: '/', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` },
    });
  }

  if (url.pathname === LOGIN_PATH && req.method === 'POST') {
    const form = await req.formData().catch(() => null);
    const given = String(form?.get('password') ?? '');
    const next = safeNext(String(form?.get('next') ?? '/'));
    if (!(await passwordMatches(given, password))) {
      // Slow down guessing.
      await new Promise((r) => setTimeout(r, 1500));
      return loginPage(next, 'Wrong password.');
    }
    const exp = String(Date.now() + SESSION_DAYS * 86400_000);
    const cookie = `${COOKIE}=${exp}.${await sign(password, exp)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
    return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: next, 'Set-Cookie': cookie } });
  }

  if (await validSession(req, password)) {
    return url.pathname === LOGIN_PATH ? new Response(null, { status: 303, headers: { Location: '/' } }) : pass();
  }

  // Not signed in: pages get the sign-in form; anything else (scripts, models, …) is refused.
  const wantsPage = req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html');
  if (wantsPage || url.pathname === LOGIN_PATH) return loginPage(safeNext(url.pathname === LOGIN_PATH ? '/' : url.pathname + url.search));
  return new Response('Unauthorized', { status: 401, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
}
