import { newToken, sessionExpiry, sessionCookieHeader } from '../../_shared/auth-lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  const fail = () => Response.redirect(new URL('/login.html?error=invalid_or_expired', url).toString(), 302);
  if (!token) return fail();

  const link = await env.DB.prepare('SELECT * FROM magic_links WHERE token = ?').bind(token).first();
  if (!link || link.used_at || new Date(link.expires_at) < new Date()) {
    return fail();
  }

  const now = new Date();
  const nowIso = now.toISOString();

  await env.DB.prepare('UPDATE magic_links SET used_at = ? WHERE token = ?').bind(nowIso, token).run();

  let customer = await env.DB.prepare('SELECT * FROM customers WHERE email = ?').bind(link.customer_email).first();
  if (!customer) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO customers (id, email, created_at, updated_at) VALUES (?,?,?,?)')
      .bind(id, link.customer_email, nowIso, nowIso)
      .run();
    customer = { id };
  }

  const sessionToken = newToken();
  const expiresAt = sessionExpiry(now);
  await env.DB.prepare(
    'INSERT INTO sessions (token, customer_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)'
  )
    .bind(sessionToken, customer.id, nowIso, expiresAt, nowIso)
    .run();

  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL('/portal.html', url).toString(),
      'Set-Cookie': sessionCookieHeader(sessionToken, expiresAt),
    },
  });
}
