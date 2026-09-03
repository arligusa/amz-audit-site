// Shared helpers for the /arliadmin endpoints (functions/api/admin/*.js).
//
// Auth model: these endpoints do NOT check a session or password themselves — the
// entire /arliadmin* path sits behind Cloudflare Access (Zero Trust) at the edge,
// so an unauthenticated request never reaches the Worker at all. Access injects
// Cf-Access-Authenticated-User-Email on every request it lets through, which is
// what adminEmail() below reads for attributing audit-log entries — there's no
// separate admin login/password system to build or leak.
//
// IMPORTANT: do not deploy anything under functions/api/admin/** until the Access
// application for arli.arligusa.com/arliadmin* actually exists — see the plan at
// /Users/kendall/.claude/plans/effervescent-beaming-fox.md. Without it these routes
// would be reachable by anyone.
import { json } from './prescan-lib.js';

export function adminEmail(request) {
  return request.headers.get('Cf-Access-Authenticated-User-Email') || 'unknown-admin';
}

export function requireAdmin(request) {
  const email = adminEmail(request);
  if (email === 'unknown-admin') {
    // Access should make this unreachable in production; this is a safety net so a
    // misconfiguration fails closed (401) instead of silently logging actions
    // against an "unknown-admin" placeholder.
    return null;
  }
  return email;
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
