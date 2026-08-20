import { getSessionToken, clearSessionCookieHeader } from '../../_shared/auth-lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = getSessionToken(request);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookieHeader() },
  });
}
