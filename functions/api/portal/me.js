import { json } from '../../_shared/prescan-lib.js';
import { requireSession, unauthorized } from '../../_shared/auth-lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await requireSession(env, request);
  if (!auth) return unauthorized();

  const { results: entitlements } = await env.DB.prepare(
    "SELECT id, audit_type, created_at FROM entitlements WHERE customer_id = ? AND status = 'unredeemed' ORDER BY created_at ASC"
  )
    .bind(auth.customer.id)
    .all();

  return json({
    email: auth.customer.email,
    created_at: auth.customer.created_at,
    full_name: auth.customer.full_name || '',
    company_name: auth.customer.company_name || '',
    // null = never asked yet (first login) vs. 0 = asked, declined — profile-setup
    // gate in portal.html only cares whether full_name is set, but this distinction
    // matters if marketing consent is ever surfaced/audited on its own later.
    marketing_opt_in: auth.customer.marketing_opt_in === null ? null : !!auth.customer.marketing_opt_in,
    profile_complete: !!auth.customer.full_name,
    unredeemed_entitlements: entitlements,
  });
}

// Account setup, reached from the first login after a purchase (see
// functions/api/webhooks/shopify-order-paid.js and portal.html's profile gate).
// full_name is the only required field; company_name and marketing consent are
// optional. marketing_opt_in defaults to false (unchecked) per standard consent
// practice — it's never assumed true.
export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await requireSession(env, request);
  if (!auth) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid request.' }, 400);
  }

  const fullName = (body.full_name || '').toString().trim().slice(0, 200);
  if (!fullName) {
    return json({ error: 'Please enter your name.' }, 400);
  }
  const companyName = (body.company_name || '').toString().trim().slice(0, 200);
  const marketingOptIn = !!body.marketing_opt_in;

  await env.DB.prepare('UPDATE customers SET full_name = ?, company_name = ?, marketing_opt_in = ?, updated_at = ? WHERE id = ?')
    .bind(fullName, companyName, marketingOptIn ? 1 : 0, new Date().toISOString(), auth.customer.id)
    .run();

  return json({ ok: true });
}
