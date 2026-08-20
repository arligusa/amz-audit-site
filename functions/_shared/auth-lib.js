// Shared session/magic-link helpers for the customer portal auth flow.

const SESSION_COOKIE = 'arli_session';
const SESSION_DAYS = 30;
const MAGIC_LINK_MINUTES = 15;
export const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_HOURS = 1;

export function newToken() {
  // Two UUIDs stripped of dashes = 32 bytes of entropy, hex-encoded.
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

export function magicLinkExpiry(from) {
  return new Date(from.getTime() + MAGIC_LINK_MINUTES * 60 * 1000).toISOString();
}

export function sessionExpiry(from) {
  return new Date(from.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function rateLimitWindowStart(from) {
  return new Date(from.getTime() - RATE_LIMIT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
}

export function sessionCookieHeader(token, expiresAtIso) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(expiresAtIso).toUTCString()}`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function getSessionToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
  return match ? match[1] : null;
}

// Looks up the session for the current request, bumping last_seen_at on a valid hit.
// Returns { customer, session } or null if missing/expired/invalid.
export async function requireSession(env, request) {
  const token = getSessionToken(request);
  if (!token) return null;

  const session = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
  if (!session || new Date(session.expires_at) < new Date()) return null;

  const customer = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(session.customer_id).first();
  if (!customer) return null;

  await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?')
    .bind(new Date().toISOString(), token)
    .run();

  return { customer, session };
}

export function unauthorized() {
  return new Response(JSON.stringify({ error: 'Not logged in.' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Sends the magic link email via Resend once RESEND_API_KEY is configured; until then
// logs the link so it can be pulled from Cloudflare logs during development/QA.
export async function sendMagicLinkEmail(env, email, verifyUrl) {
  if (!env.RESEND_API_KEY) {
    console.log(`[stub email] magic link for ${email}: ${verifyUrl}`);
    return;
  }

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'Arli Audits <login@amzaudits.arligusa.com>',
      to: [email],
      subject: 'Your Arli Audits login link',
      text: `Click below to log in to your Arli Audits account. This link expires in 15 minutes and can only be used once.\n\n${verifyUrl}\n\nIf you didn't request this, you can ignore this email.`,
    }),
  });
}
