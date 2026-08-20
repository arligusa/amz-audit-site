import { json } from '../../_shared/prescan-lib.js';
import { requireSession, unauthorized } from '../../_shared/auth-lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await requireSession(env, request);
  if (!auth) return unauthorized();
  return json({ email: auth.customer.email, created_at: auth.customer.created_at });
}
