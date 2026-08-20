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

// Client-credentials OAuth2 flow against Entra ID (Azure AD) — gets an app-only
// access token scoped to Graph's default permissions (Mail.Send, granted via admin
// consent on the app registration). Fetched fresh per send; volume here is low
// (magic-link requests are already rate-limited to 5/email/hour), so token caching
// isn't worth the added complexity yet.
async function getGraphAccessToken(env) {
  const resp = await fetch(`https://login.microsoftonline.com/${env.MS_GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.MS_GRAPH_CLIENT_ID,
      client_secret: env.MS_GRAPH_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });

  if (!resp.ok) {
    throw new Error(`Graph token request failed: ${resp.status}`);
  }

  const data = await resp.json();
  return data.access_token;
}

async function sendViaGraph(env, email, subject, text) {
  const accessToken = await getGraphAccessToken(env);

  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${env.MS_GRAPH_SENDER}/sendMail`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'Text', content: text },
        toRecipients: [{ emailAddress: { address: email } }],
      },
      saveToSentItems: false,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Graph sendMail failed: ${resp.status}`);
  }
}

// Sends the magic link email via Microsoft Graph (Exchange Online) once the
// MS_GRAPH_* vars/secret are configured; until then logs the link so it can be
// pulled from Cloudflare logs during development/QA. Never throws back to the
// caller — request-link.js's response is intentionally generic either way, so a
// delivery failure here shouldn't surface as a different-looking error to the visitor.
export async function sendMagicLinkEmail(env, email, verifyUrl) {
  const subject = 'Your Arli Audits login link';
  const text = `Click below to log in to your Arli Audits account. This link expires in 15 minutes and can only be used once.\n\n${verifyUrl}\n\nIf you didn't request this, you can ignore this email.`;

  if (!env.MS_GRAPH_TENANT_ID || !env.MS_GRAPH_CLIENT_ID || !env.MS_GRAPH_CLIENT_SECRET || !env.MS_GRAPH_SENDER) {
    console.log(`[stub email] magic link for ${email}: ${verifyUrl}`);
    return;
  }

  try {
    await sendViaGraph(env, email, subject, text);
  } catch (e) {
    console.log(`[email send failed, logging link instead] ${email}: ${verifyUrl} — ${e.message}`);
  }
}
