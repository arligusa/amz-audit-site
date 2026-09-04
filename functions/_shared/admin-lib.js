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

// Verifies the Access JWT on this request. Returns the verified email on success, or
// null if the token is missing, malformed, expired, wrong audience, or fails
// signature verification — every failure mode is treated the same (fail closed).
export async function verifyAccessJwt(request, env) {
  if (!env.CF_ACCESS_AUD) return null;

  const token = accessTokenFromRequest(request);
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header, payload;
  try {
    header = base64UrlDecodeJson(headerB64);
    payload = base64UrlDecodeJson(payloadB64);
  } catch (e) {
    return null;
  }

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.CF_ACCESS_AUD)) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (payload.iss && !String(payload.iss).includes(ACCESS_TEAM_DOMAIN)) return null;
  if (!payload.email) return null;

  let jwks;
  try {
    jwks = await fetchAccessJwks();
  } catch (e) {
    return null;
  }
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch (e) {
    return null;
  }

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    base64UrlToUint8Array(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) return null;

  return payload.email;
}

export async function requireAdmin(request, env) {
  return verifyAccessJwt(request, env);
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
