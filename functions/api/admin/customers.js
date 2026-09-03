import { json } from '../../_shared/prescan-lib.js';
import { requireAdmin, adminUnauthorized } from '../../_shared/admin-lib.js';

// Searches by email/name (primary), or by ASIN / Shopify order id if the query
// looks like one of those — covers "customer says they never got their report"
// (search by email) and "what happened to order #1234" (search by order id) alike.
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!requireAdmin(request)) return adminUnauthorized();

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ customers: [] });

  const like = `%${q}%`;
  const seen = new Map();

  const { results: byNameEmail } = await env.DB.prepare(
    `SELECT id, email, full_name, company_name, created_at FROM customers
     WHERE email LIKE ? OR full_name LIKE ? OR company_name LIKE ?
     ORDER BY created_at DESC LIMIT 50`
  )
    .bind(like, like, like)
    .all();
  for (const c of byNameEmail) seen.set(c.id, c);

  const isAsinLike = /^[A-Z0-9]{6,10}$/i.test(q);
  if (isAsinLike) {
    const { results: byAsin } = await env.DB.prepare(
      `SELECT c.id, c.email, c.full_name, c.company_name, c.created_at
       FROM customers c JOIN asins a ON a.customer_id = c.id
       WHERE a.asin LIKE ? LIMIT 50`
    )
      .bind(like)
      .all();
    for (const c of byAsin) seen.set(c.id, c);
  }

  const { results: byOrder } = await env.DB.prepare(
    `SELECT c.id, c.email, c.full_name, c.company_name, c.created_at
     FROM customers c JOIN entitlements e ON e.customer_id = c.id
     WHERE e.source_order_id LIKE ? LIMIT 50`
  )
    .bind(like)
    .all();
  for (const c of byOrder) seen.set(c.id, c);

  return json({ customers: Array.from(seen.values()) });
}
