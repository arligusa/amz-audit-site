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

// D1's `token` columns (magic_links, sessions) store this hash, never the raw bearer
// value — same reasoning as password hashing. The raw token only ever exists in the
// emailed URL / session cookie, so a DB read alone can't be used to impersonate anyone.
export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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

  const tokenHash = await hashToken(token);
  const session = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(tokenHash).first();
  if (!session || new Date(session.expires_at) < new Date()) return null;

  const customer = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(session.customer_id).first();
  if (!customer) return null;

  await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?')
    .bind(new Date().toISOString(), tokenHash)
    .run();

  return { customer, session };
}

export function unauthorized() {
  return new Response(JSON.stringify({ error: 'Not logged in.' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Entra app registration uses a long-lived self-signed cert instead of a client
// secret, so token requests authenticate via a signed JWT client assertion (RFC 7523)
// rather than client_secret. Thumbprint identifies which cert to Entra — it's public
// metadata (not sensitive, unlike the private key), so it's fine as a source constant.
const MS_GRAPH_CERT_THUMBPRINT_HEX = 'B8:62:7B:3D:F0:0D:74:36:8A:5B:13:72:51:F8:9E:2D:66:D6:62:49';

function uint8ArrayToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jsonToBase64Url(obj) {
  return uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

function hexThumbprintToBase64Url(hex) {
  const cleaned = hex.replace(/:/g, '');
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  }
  return uint8ArrayToBase64Url(bytes);
}

// MS_GRAPH_CLIENT_CERT_KEY must be a PEM-encoded PKCS8 private key ("BEGIN PRIVATE
// KEY", not "BEGIN RSA PRIVATE KEY" — that's the older PKCS1 format and importKey
// here won't accept it directly; it'd need `openssl pkcs8 -topk8` first).
async function importGraphPrivateKey(pem) {
  const pemContents = pem.replace(/-----BEGIN [A-Z ]+-----|-----END [A-Z ]+-----|\s+/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function buildClientAssertionJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', x5t: hexThumbprintToBase64Url(MS_GRAPH_CERT_THUMBPRINT_HEX) };
  const payload = {
    iss: env.MS_GRAPH_CLIENT_ID,
    sub: env.MS_GRAPH_CLIENT_ID,
    aud: `https://login.microsoftonline.com/${env.MS_GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    jti: crypto.randomUUID(),
    nbf: now,
    exp: now + 5 * 60,
  };

  const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`;
  const privateKey = await importGraphPrivateKey(env.MS_GRAPH_CLIENT_CERT_KEY);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signingInput));

  return `${signingInput}.${uint8ArrayToBase64Url(new Uint8Array(signature))}`;
}

// Client-credentials OAuth2 flow against Entra ID (Azure AD), authenticated via a
// signed JWT client assertion (certificate-based) rather than a client secret — gets
// an app-only access token scoped to Graph's default permissions (Mail.Send, granted
// via admin consent). Fetched fresh per send; volume here is low (magic-link requests
// are already rate-limited to 5/email/hour), so token caching isn't worth it yet.
async function getGraphAccessToken(env) {
  const clientAssertion = await buildClientAssertionJwt(env);

  const resp = await fetch(`https://login.microsoftonline.com/${env.MS_GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.MS_GRAPH_CLIENT_ID,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });

  if (!resp.ok) {
    throw new Error(`Graph token request failed: ${resp.status} — ${await resp.text()}`);
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
    throw new Error(`Graph sendMail failed: ${resp.status} — ${await resp.text()}`);
  }
}

// Sends via Microsoft Graph (Exchange Online) once the MS_GRAPH_* vars/secret are
// configured; until then logs the content so it can be pulled from Cloudflare logs
// during development/QA. Never throws back to the caller — every caller here treats
// email delivery as best-effort, so a failure shouldn't surface as a different-looking
// error to the visitor (magic links) or block a webhook from finishing (order/free-scan
// emails). `logLabel` is just what shows up in the stub/error log line, e.g. the
// recipient-specific content a caller wants visible for debugging.
export async function sendPlainEmail(env, email, subject, text, logLabel) {
  if (!env.MS_GRAPH_TENANT_ID || !env.MS_GRAPH_CLIENT_ID || !env.MS_GRAPH_CLIENT_CERT_KEY || !env.MS_GRAPH_SENDER) {
    console.log(`[stub email] ${logLabel || subject} for ${email}`);
    return;
  }

  try {
    await sendViaGraph(env, email, subject, text);
  } catch (e) {
    console.log(`[email send failed] ${logLabel || subject} for ${email} — ${e.name}: ${e.message}`);
    // Cloudflare's dashboard doesn't surface Pages Functions console logs for this
    // project, so mirror the failure into D1 as a queryable fallback (temporary,
    // for diagnosing the Graph API rollout — not a permanent audit table).
    if (env.DB) {
      try {
        await env.DB.prepare(
          'INSERT INTO email_send_errors (email, error_name, error_message, created_at) VALUES (?,?,?,?)'
        )
          .bind(email, e.name || null, e.message || null, new Date().toISOString())
          .run();
      } catch (e2) {
        console.log(`[email_send_errors insert also failed] ${e2.message}`);
      }
    }
  }
}

// Sends the magic link email. Thin wrapper over sendPlainEmail — kept as its own
// function since every caller of the login flow wants this exact copy.
export async function sendMagicLinkEmail(env, email, verifyUrl) {
  const subject = 'Your Arli Audits login link';
  const text = `Click below to log in to your Arli Audits account. This link expires in 15 minutes and can only be used once.\n\n${verifyUrl}\n\nIf you didn't request this, you can ignore this email.`;
  await sendPlainEmail(env, email, subject, text, `magic link (${verifyUrl})`);
}

// Mints a fresh magic link and emails it with custom subject/intro copy — shared by
// the order-paid webhook (purchase confirmation) and the admin "add customer" flow
// (welcome email), both of which need a real login link, not just a generic one.
export async function sendLoginLinkEmail(env, request, email, { subject, intro }) {
  const token = newToken();
  const tokenHash = await hashToken(token);
  const now = new Date();
  await env.DB.prepare('INSERT INTO magic_links (token, customer_email, created_at, expires_at, used_at) VALUES (?,?,?,?,NULL)')
    .bind(tokenHash, email, now.toISOString(), magicLinkExpiry(now))
    .run();

  const verifyUrl = new URL('/api/auth/verify', request.url);
  verifyUrl.searchParams.set('token', token);

  const text = `${intro}\n\nClick below to log in. This link expires in 15 minutes and can only be used once.\n\n${verifyUrl.toString()}\n\nQuestions? Reply to this email or reach us at contact@arli.arligusa.com.`;
  await sendPlainEmail(env, email, subject, text, `login link (${verifyUrl.toString()})`);
}

// Verifies a Shopify webhook delivery: HMAC-SHA256 over the RAW request body,
// base64-encoded, compared against the X-Shopify-Hmac-Sha256 header. Must run on the
// untouched body text — parsing/re-serializing JSON first would change the byte
// sequence HMAC was computed over and break verification. Constant-time compare so
// timing doesn't leak how much of the signature matched.
export async function verifyShopifyWebhookHmac(env, rawBody, hmacHeader) {
  if (!env.SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SHOPIFY_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(signature)));

  if (computed.length !== hmacHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hmacHeader.charCodeAt(i);
  return diff === 0;
}
