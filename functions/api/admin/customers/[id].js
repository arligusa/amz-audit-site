import { json } from '../../../_shared/prescan-lib.js';
import { requireAdmin, adminUnauthorized } from '../../../_shared/admin-lib.js';

// One customer's full timeline — everything joined together, for a support
// conversation ("customer says they never got their report").
export async function onRequestGet(context) {
  const { request, env, params } = context;
  if (!requireAdmin(request)) return adminUnauthorized();

  const customer = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(params.id).first();
  if (!customer) return json({ error: 'Customer not found.' }, 404);

  const { results: asins } = await env.DB.prepare(
    'SELECT * FROM asins WHERE customer_id = ? ORDER BY created_at DESC'
  )
    .bind(params.id)
    .all();

  const { results: reports } = await env.DB.prepare(
    `SELECT r.*, a.asin, a.marketplace FROM reports r JOIN asins a ON a.id = r.asin_id
     WHERE r.customer_id = ? ORDER BY r.created_at DESC`
  )
    .bind(params.id)
    .all();

  const { results: entitlements } = await env.DB.prepare(
    'SELECT * FROM entitlements WHERE customer_id = ? ORDER BY created_at DESC'
  )
    .bind(params.id)
    .all();

  const { results: freeScans } = await env.DB.prepare(
    'SELECT * FROM free_scans WHERE email = ? ORDER BY created_at DESC'
  )
    .bind(customer.email)
    .all();

  const { results: adminActions } = await env.DB.prepare(
    `SELECT * FROM admin_actions WHERE target_id = ? OR target_id IN (
       SELECT id FROM asins WHERE customer_id = ?
       UNION SELECT id FROM entitlements WHERE customer_id = ?
       UNION SELECT id FROM reports WHERE customer_id = ?
     ) ORDER BY created_at DESC`
  )
    .bind(customer.id, customer.id, customer.id, customer.id)
    .all();

  return json({
    customer: {
      id: customer.id,
      email: customer.email,
      full_name: customer.full_name || '',
      company_name: customer.company_name || '',
      marketing_opt_in: !!customer.marketing_opt_in,
      created_at: customer.created_at,
    },
    asins,
    reports,
    entitlements,
    free_scans: freeScans,
    admin_actions: adminActions,
  });
}
