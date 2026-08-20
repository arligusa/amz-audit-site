import { json, extractAsin, marketplaceToDomain } from '../../_shared/prescan-lib.js';
import { requireSession, unauthorized } from '../../_shared/auth-lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await requireSession(env, request);
  if (!auth) return unauthorized();

  const { results } = await env.DB.prepare(
    `SELECT a.*,
       r.id as latest_report_id, r.status as latest_report_status,
       r.audit_type as latest_report_audit_type, r.delivered_at as latest_report_delivered_at
     FROM asins a
     LEFT JOIN reports r ON r.id = (
       SELECT id FROM reports WHERE asin_id = a.id ORDER BY created_at DESC LIMIT 1
     )
     WHERE a.customer_id = ? AND a.active = 1
     ORDER BY a.created_at DESC`
  )
    .bind(auth.customer.id)
    .all();

  const asins = results.map((row) => ({
    id: row.id,
    asin: row.asin,
    marketplace: row.marketplace,
    label: row.label,
    created_at: row.created_at,
    latest_report: row.latest_report_id
      ? {
          id: row.latest_report_id,
          status: row.latest_report_status,
          audit_type: row.latest_report_audit_type,
          delivered_at: row.latest_report_delivered_at,
        }
      : null,
  }));

  return json({ asins });
}

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

  const rawInput = (body.asin_or_url || '').toString().trim();
  const marketplace = marketplaceToDomain((body.marketplace || 'amazon.com').toString());
  const label = body.label ? String(body.label).trim().slice(0, 100) : null;

  const asin = extractAsin(rawInput);
  if (!asin) {
    return json(
      { error: "We couldn't find a valid Amazon ASIN in that — paste the product URL or the 10-character ASIN (e.g. B0XXXXXXXX)." },
      400
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO asins (id, customer_id, asin, marketplace, label, active, subscription_status, created_at, updated_at)
     VALUES (?,?,?,?,?,1,'not_subscribed',?,?)`
  )
    .bind(id, auth.customer.id, asin, marketplace, label, now, now)
    .run();

  return json({ asin: { id, asin, marketplace, label, created_at: now, latest_report: null } });
}
