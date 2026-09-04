// Comp an audit for a customer without a Shopify order — used for customer-sat
// issues (a botched report, a support goodwill gesture, etc), or the product a
// brand-new customer gets when added via functions/api/admin/customers/add.js.
import { json, isValidEmail } from '../../../_shared/prescan-lib.js';
import { requireAdmin, adminUnauthorized, logAdminAction, findOrCreateCustomer, grantComplimentaryEntitlement } from '../../../_shared/admin-lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const adminEmail = await requireAdmin(request, env);
  if (!adminEmail) return adminUnauthorized();

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

  const customerId = (body.customer_id || '').toString();
  const email = (body.email || '').toString().trim().toLowerCase();
  if (!customerId && !isValidEmail(email)) {
    return json({ error: 'Provide either an existing customer_id or a valid email to create one.' }, 400);
  }

  const customer = await findOrCreateCustomer(env, { customerId, email });
  if (!customer) return json({ error: 'Customer not found.' }, 404);

  const entitlementId = await grantComplimentaryEntitlement(env, { customerId: customer.id, auditType, adminEmail });

  await logAdminAction(env, {
    adminEmail,
    action: 'grant_entitlement',
    targetType: 'entitlement',
    targetId: entitlementId,
    reason,
  });

  return json({ ok: true, entitlement_id: entitlementId, customer_id: customer.id });
}
