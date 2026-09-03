// Comp an audit for a customer without a Shopify order — used for customer-sat
// issues (a botched report, a support goodwill gesture, etc). Creates a real
// entitlement, just like a paid one, but with a `comp:` sentinel in place of a
// real Shopify order id so comps stay distinguishable from paid orders in reporting.
import { json, isValidEmail } from '../../../_shared/prescan-lib.js';
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

  const auditType = (body.audit_type || '').toString();
  if (!['listing', 'ppc', 'both'].includes(auditType)) {
    return json({ error: 'Please choose an audit type.' }, 400);
  }
  const reason = (body.reason || '').toString().trim().slice(0, 500);
  if (!reason) {
    return json({ error: 'A reason is required for comped audits.' }, 400);
  }

  let customerId = (body.customer_id || '').toString();
  if (!customerId) {
    const email = (body.email || '').toString().trim().toLowerCase();
    if (!isValidEmail(email)) {
      return json({ error: 'Provide either an existing customer_id or a valid email to create one.' }, 400);
    }
    const now = new Date().toISOString();
    let customer = await env.DB.prepare('SELECT id FROM customers WHERE email = ?').bind(email).first();
    if (!customer) {
      customerId = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO customers (id, email, created_at, updated_at) VALUES (?,?,?,?)')
        .bind(customerId, email, now, now)
        .run();
    } else {
      customerId = customer.id;
    }
  } else {
    const exists = await env.DB.prepare('SELECT id FROM customers WHERE id = ?').bind(customerId).first();
    if (!exists) return json({ error: 'Customer not found.' }, 404);
  }

  const entitlementId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO entitlements (id, customer_id, audit_type, source_order_id, status, created_at)
     VALUES (?,?,?,?,'unredeemed',?)`
  )
    .bind(entitlementId, customerId, auditType, `comp:${adminEmail(request)}`, now)
    .run();

  await logAdminAction(env, {
    adminEmail: adminEmail(request),
    action: 'grant_entitlement',
    targetType: 'entitlement',
    targetId: entitlementId,
    reason,
  });

  return json({ ok: true, entitlement_id: entitlementId, customer_id: customerId });
}
