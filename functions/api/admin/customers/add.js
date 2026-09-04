import { json, isValidEmail, AUDIT_LABEL } from '../../../_shared/prescan-lib.js';
import { sendLoginLinkEmail } from '../../../_shared/auth-lib.js';
import { requireAdmin, adminUnauthorized, logAdminAction, findOrCreateCustomer, grantComplimentaryEntitlement } from '../../../_shared/admin-lib.js';

// Manually add a customer — no Shopify order involved. Always sends a welcome/
// login-link email so the customer can log in and fill in their profile; the
// audit_type is optional (giving away a product) and, if set, requires a reason
// note for the same customer-sat audit trail as the existing "comp an audit" flow.
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

  const email = (body.email || '').toString().trim().toLowerCase();
  if (!isValidEmail(email)) {
    return json({ error: 'A valid email is required.' }, 400);
  }

  const auditType = (body.audit_type || '').toString();
  const grantingProduct = auditType !== '';
  if (grantingProduct && !Object.keys(AUDIT_LABEL).includes(auditType)) {
    return json({ error: 'Unrecognized audit type.' }, 400);
  }
  const reason = (body.reason || '').toString().trim().slice(0, 500);
  if (grantingProduct && !reason) {
    return json({ error: 'A reason is required when granting a product.' }, 400);
  }

  const customer = await findOrCreateCustomer(env, { email });

  let entitlementId = null;
  if (grantingProduct) {
    entitlementId = await grantComplimentaryEntitlement(env, { customerId: customer.id, auditType, adminEmail });
    await logAdminAction(env, {
      adminEmail,
      action: 'grant_entitlement',
      targetType: 'entitlement',
      targetId: entitlementId,
      reason,
    });
  }

  await logAdminAction(env, {
    adminEmail,
    action: 'add_customer',
    targetType: 'customer',
    targetId: customer.id,
    reason: reason || null,
  });

  await sendLoginLinkEmail(env, request, customer.email, {
    subject: 'You have an Arli Audits account',
    intro: "We've set up an Arli Audits account for you — log in below to finish your profile.",
  });

  return json({ ok: true, customer_id: customer.id, entitlement_id: entitlementId });
}
