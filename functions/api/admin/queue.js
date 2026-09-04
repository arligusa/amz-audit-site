import { json } from '../../_shared/prescan-lib.js';
import { requireAdmin, adminUnauthorized } from '../../_shared/admin-lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await requireAdmin(request, env))) return adminUnauthorized();

  const { results: reports } = await env.DB.prepare(
    `SELECT r.id as report_id, r.audit_type, r.status, r.str_provided, r.biz_report_provided,
            r.created_at, r.delivered_at,
            c.id as customer_id, c.email, c.full_name,
            a.id as asin_id, a.asin, a.marketplace, a.label
     FROM reports r
     JOIN customers c ON c.id = r.customer_id
     JOIN asins a ON a.id = r.asin_id
     ORDER BY r.created_at DESC
     LIMIT 300`
  ).all();

  const { results: unredeemed } = await env.DB.prepare(
    `SELECT e.id, e.audit_type, e.created_at, c.id as customer_id, c.email, c.full_name
     FROM entitlements e
     JOIN customers c ON c.id = e.customer_id
     WHERE e.status = 'unredeemed'
     ORDER BY e.created_at DESC`
  ).all();

  const { results: freeScans } = await env.DB.prepare(
    'SELECT id, asin, marketplace, email, created_at FROM free_scans ORDER BY created_at DESC LIMIT 100'
  ).all();

  return json({ reports, unredeemed_entitlements: unredeemed, recent_free_scans: freeScans });
}
