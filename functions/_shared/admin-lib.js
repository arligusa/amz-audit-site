// Shared helpers for the /arliadmin endpoints (functions/api/admin/*.js).
//
// Auth model: these endpoints do NOT check a session or password themselves — the
// entire /arliadmin* and /api/admin* paths sit behind Cloudflare Access (Zero Trust)
// at the edge, so an unauthenticated request never reaches the Worker at all.
//
// Identity is established by verifying the signed Access JWT (Cf-Access-Jwt-Assertion
// header, or the CF_Authorization cookie as a fallback) against Access's own public
// keys — NOT by trusting the Cf-Access-Authenticated-User-Email header. That header is
// documented to work in the simple case, but proved unreliable in practice for this
// Pages project with a multi-destination Access application (page path + API path
// under one app) — verifying the token directly is also what Cloudflare recommends
// for exactly this kind of setup, and it's strictly more correct: the signature check
// means a request can't claim an identity Access didn't actually vouch for.
//
// Needs env.CF_ACCESS_AUD (the Access application's Audience/AUD tag) set as a plain
// Pages environment variable — not a secret, but not hardcoded either, so it's not
// tied to source and can be set directly in the dashboard.
//
// IMPORTANT: do not deploy anything under functions/api/admin/** until the Access
// application for arli.arligusa.com/arliadmin* actually exists — see the plan at
// /Users/kendall/.claude/plans/effervescent-beaming-fox.md. Without it these routes
// would be reachable by anyone.
import { json } from './prescan-lib.js';

// Public — this is just the team's Access login domain, visible in every login
// redirect URL, not a secret.
const ACCESS_TEAM_DOMAIN = 'arlig.cloudflareaccess.com';

function base64UrlToUint8Array(b64url) {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeJson(b64url) {
  return JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(b64url)));
}

async function fetchAccessJwks() {
  const resp = await fetch(`https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!resp.ok) throw new Error(`Access JWKS fetch failed: ${resp.status}`);
  return resp.json();
}

function accessTokenFromRequest(request) {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
}

// Verifies the Access JWT on this request. Returns { ok: true, email } on success,
// or { ok: false, reason, debug } describing exactly which check failed — reason is
// a short machine-readable code, debug carries the specific values involved (never
// the raw token or signature, just claims/lengths/booleans) so a failure can be
// diagnosed without re-deploying more debug code every time. Everything downstream
// only cares about `ok`/`email`; the reason/debug detail exists for
// functions/api/admin/whoami.js, a diagnostic endpoint (still behind Access — this
// isn't reachable by anyone who hasn't already passed Access's own login).
export async function verifyAccessJwtDetailed(request, env) {
  const debug = {};

  debug.hasAudEnvVar = !!env.CF_ACCESS_AUD;
  if (!env.CF_ACCESS_AUD) return { ok: false, reason: 'server_missing_CF_ACCESS_AUD', debug };

  const headerToken = request.headers.get('Cf-Access-Jwt-Assertion');
  const cookieToken = accessTokenFromRequest(request);
  debug.tokenSource = headerToken ? 'header' : (cookieToken ? 'cookie' : 'none');
  const token = headerToken || cookieToken;
  if (!token) return { ok: false, reason: 'no_token_on_request', debug };

  const parts = token.split('.');
  debug.tokenPartsCount = parts.length;
  if (parts.length !== 3) return { ok: false, reason: 'malformed_token', debug };
  const [headerB64, payloadB64, signatureB64] = parts;

  let header, payload;
  try {
    header = base64UrlDecodeJson(headerB64);
    payload = base64UrlDecodeJson(payloadB64);
  } catch (e) {
    return { ok: false, reason: 'undecodable_token', debug };
  }

  debug.kid = header.kid || null;
  debug.payloadAud = payload.aud ?? null;
  debug.expectedAud = env.CF_ACCESS_AUD;
  debug.payloadIss = payload.iss ?? null;
  debug.payloadExp = payload.exp ?? null;
  debug.payloadEmail = payload.email ?? null;

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.CF_ACCESS_AUD)) return { ok: false, reason: 'aud_mismatch', debug };
  if (!payload.exp || payload.exp * 1000 < Date.now()) return { ok: false, reason: 'expired', debug };
  if (payload.iss && !String(payload.iss).includes(ACCESS_TEAM_DOMAIN)) return { ok: false, reason: 'iss_mismatch', debug };
  if (!payload.email) return { ok: false, reason: 'no_email_claim', debug };

  let jwks;
  try {
    jwks = await fetchAccessJwks();
  } catch (e) {
    return { ok: false, reason: 'jwks_fetch_failed', debug: { ...debug, error: String(e) } };
  }
  debug.jwksKidsAvailable = (jwks.keys || []).map((k) => k.kid);
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'kid_not_in_jwks', debug };

  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch (e) {
    return { ok: false, reason: 'key_import_failed', debug: { ...debug, error: String(e) } };
  }

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    base64UrlToUint8Array(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  debug.signatureValid = valid;
  if (!valid) return { ok: false, reason: 'bad_signature', debug };

  return { ok: true, email: payload.email, debug };
}

export async function requireAdmin(request, env) {
  const result = await verifyAccessJwtDetailed(request, env);
  return result.ok ? result.email : null;
}

export function adminUnauthorized() {
  return json({ error: 'Not authorized.' }, 401);
}

export async function logAdminAction(env, { adminEmail, action, targetType, targetId, reason }) {
  await env.DB.prepare(
    'INSERT INTO admin_actions (id, admin_email, action, target_type, target_id, reason, created_at) VALUES (?,?,?,?,?,?,?)'
  )
    .bind(crypto.randomUUID(), adminEmail, action, targetType, targetId, reason || null, new Date().toISOString())
    .run();
}

// Shared by the "comp an audit" and "add customer" admin actions — both need to
// resolve an email (or an existing customer_id) down to a real customer row,
// creating one if it doesn't exist yet. Same find-or-create pattern used by the
// order-paid webhook and the public login flow, just admin-triggered.
export async function findOrCreateCustomer(env, { customerId, email }) {
  if (customerId) {
    const existing = await env.DB.prepare('SELECT id, email FROM customers WHERE id = ?').bind(customerId).first();
    return existing || null;
  }
  const now = new Date().toISOString();
  let customer = await env.DB.prepare('SELECT id, email FROM customers WHERE email = ?').bind(email).first();
  if (!customer) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO customers (id, email, created_at, updated_at) VALUES (?,?,?,?)')
      .bind(id, email, now, now)
      .run();
    customer = { id, email };
  }
  return customer;
}

// Grants a complimentary entitlement — the `comp:` sentinel in source_order_id (in
// place of a real Shopify order id) is what keeps comps distinguishable from paid
// orders everywhere else this table gets read (customer total-spend stays
// accurate since price_paid defaults to 0 for these).
export async function grantComplimentaryEntitlement(env, { customerId, auditType, adminEmail }) {
  const entitlementId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO entitlements (id, customer_id, audit_type, source_order_id, price_paid, status, created_at)
     VALUES (?,?,?,?,0,'unredeemed',?)`
  )
    .bind(entitlementId, customerId, auditType, `comp:${adminEmail}`, new Date().toISOString())
    .run();
  return entitlementId;
}
