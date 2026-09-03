// Manually extend a customer's subscription on a given ASIN. Subscriptions
// themselves aren't built yet ("down the road" per the plan) — this operates on
// asins.subscription_until, the field a real subscription feature will also use,
// so this action doesn't need to change shape once that's built.
import { json } from '../../../_shared/prescan-lib.js';
import { requireAdmin, adminUnauthorized, adminEmail, logAdminAction } from '../../../_shared/admin-lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!requireAdmin(request)) return adminUnauthorized();

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid request.' }, 400);
  }

  const asinId = (body.asin_id || '').toString();
  const untilRaw = (body.until || '').toString();
  const reason = (body.reason || '').toString().trim().slice(0, 500);

  const asin = await env.DB.prepare('SELECT * FROM asins WHERE id = ?').bind(asinId).first();
  if (!asin) return json({ error: 'ASIN not found.' }, 404);

  const until = new Date(untilRaw);
  if (isNaN(until.getTime())) {
    return json({ error: 'Please provide a valid date to extend the subscription until.' }, 400);
  }
  if (!reason) {
    return json({ error: 'A reason is required for manual subscription changes.' }, 400);
  }

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE asins SET subscription_status = 'active', subscription_until = ?, updated_at = ? WHERE id = ?")
    .bind(until.toISOString(), now, asinId)
    .run();

  await logAdminAction(env, {
    adminEmail: adminEmail(request),
    action: 'extend_subscription',
    targetType: 'asin',
    targetId: asinId,
    reason: `${reason} (until ${until.toISOString()})`,
  });

  return json({ ok: true });
}
