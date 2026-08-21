import { newToken, hashToken, sessionExpiry, sessionCookieHeader } from '../../_shared/auth-lib.js';

const CONFIRM_PAGE_STYLE = `
  :root {
    --ink: #16181d;
    --ink-soft: #4b5160;
    --line: #e6e8ec;
    --paper: #ffffff;
    --paper-soft: #f7f8fa;
    --accent: #0f6b5c;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper-soft); color: var(--ink); line-height: 1.6; }
  .wrap { max-width: 420px; margin: 0 auto; padding: 48px 20px; }
  .brand { font-weight: 700; font-size: 17px; margin-bottom: 24px; }
  .brand span { color: var(--accent); }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 24px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p.sub { color: var(--ink-soft); font-size: 14px; margin: 0 0 20px; }
  .btn-primary {
    background: var(--accent); color: #fff; border: none; padding: 13px 20px; border-radius: 8px;
    font-weight: 600; font-size: 15px; width: 100%; cursor: pointer;
  }
`;

function confirmPageHtml(token) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Confirm login — Arli Audits</title>
<meta name="robots" content="noindex">
<style>${CONFIRM_PAGE_STYLE}</style>
</head>
<body>
<div class="wrap">
  <div class="brand">Arli <span>Audits</span></div>
  <div class="card">
    <h1>Finish logging in</h1>
    <p class="sub">Click below to confirm — this extra click keeps your login link safe from email security scanners that pre-open links automatically.</p>
    <form method="POST" action="/api/auth/verify">
      <input type="hidden" name="token" value="${token.replace(/"/g, '&quot;')}">
      <button type="submit" class="btn-primary">Finish logging in</button>
    </form>
  </div>
</div>
</body>
</html>`;
}

// GET deliberately does NOT consume the token or create a session — corporate email
// gateways (Microsoft Defender Safe Links and similar) prefetch links in email bodies
// to scan them, which would silently burn a single-use magic link before the human
// ever clicks it. Only a genuine user-initiated POST (the confirm button below)
// completes login; GET just checks the token looks plausible enough to render the
// confirm page vs. an immediate "invalid or expired".
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  const fail = () => Response.redirect(new URL('/login.html?error=invalid_or_expired', url).toString(), 302);
  if (!token) return fail();

  const tokenHash = await hashToken(token);
  const link = await env.DB.prepare('SELECT * FROM magic_links WHERE token = ?').bind(tokenHash).first();
  if (!link || link.used_at || new Date(link.expires_at) < new Date()) {
    return fail();
  }

  return new Response(confirmPageHtml(token), {
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const fail = () => Response.redirect(new URL('/login.html?error=invalid_or_expired', url).toString(), 302);

  const contentType = request.headers.get('Content-Type') || '';
  let token;
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    token = form.get('token');
  } else {
    const body = await request.json().catch(() => ({}));
    token = body.token;
  }
  if (!token) return fail();

  const tokenHash = await hashToken(token);
  const link = await env.DB.prepare('SELECT * FROM magic_links WHERE token = ?').bind(tokenHash).first();
  if (!link || link.used_at || new Date(link.expires_at) < new Date()) {
    return fail();
  }

  const now = new Date();
  const nowIso = now.toISOString();

  await env.DB.prepare('UPDATE magic_links SET used_at = ? WHERE token = ?').bind(nowIso, tokenHash).run();

  let customer = await env.DB.prepare('SELECT * FROM customers WHERE email = ?').bind(link.customer_email).first();
  if (!customer) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO customers (id, email, created_at, updated_at) VALUES (?,?,?,?)')
      .bind(id, link.customer_email, nowIso, nowIso)
      .run();
    customer = { id };
  }

  const sessionToken = newToken();
  const sessionTokenHash = await hashToken(sessionToken);
  const expiresAt = sessionExpiry(now);
  await env.DB.prepare(
    'INSERT INTO sessions (token, customer_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)'
  )
    .bind(sessionTokenHash, customer.id, nowIso, expiresAt, nowIso)
    .run();

  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL('/portal.html', url).toString(),
      'Set-Cookie': sessionCookieHeader(sessionToken, expiresAt),
    },
  });
}
