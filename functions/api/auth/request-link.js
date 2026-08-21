import { json, isValidEmail } from '../../_shared/prescan-lib.js';
import { newToken, hashToken, magicLinkExpiry, rateLimitWindowStart, RATE_LIMIT_MAX, sendMagicLinkEmail } from '../../_shared/auth-lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid request.' }, 400);
  }

  const email = (body.email || '').toString().trim().toLowerCase();
  if (!isValidEmail(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }

  const now = new Date();
  const nowIso = now.toISOString();

  const rateRow = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM magic_links WHERE customer_email = ? AND created_at > ?'
  )
    .bind(email, rateLimitWindowStart(now))
    .first();

  if (rateRow.count < RATE_LIMIT_MAX) {
    const token = newToken();
    const tokenHash = await hashToken(token);
    await env.DB.prepare(
      'INSERT INTO magic_links (token, customer_email, created_at, expires_at, used_at) VALUES (?,?,?,?,NULL)'
    )
      .bind(tokenHash, email, nowIso, magicLinkExpiry(now))
      .run();

    const verifyUrl = new URL('/api/auth/verify', request.url);
    verifyUrl.searchParams.set('token', token);
    await sendMagicLinkEmail(env, email, verifyUrl.toString());
  }

  // Always a generic success — never reveal whether the email matched an account or hit the rate limit.
  return json({ ok: true });
}
