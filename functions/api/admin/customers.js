import { json } from '../../_shared/prescan-lib.js';
import { requireAdmin, adminUnauthorized } from '../../_shared/admin-lib.js';

// Extra columns (total spend, subscription, last login) all use correlated
// subqueries rather than LEFT JOINs — joining entitlements and sessions directly
// would fan out (one row per entitlement × session pair), silently multiplying
// the spend total. subscription_until is returned as a raw ISO string rather than
// compared against "now" in SQL — SQLite's datetime('now') and our ISO-with-T
// timestamps don't compare correctly as strings, so "is it still active" gets
// decided client-side with a real Date comparison instead.
const CUSTOMER_COLUMNS = `
  c.id, c.email, c.full_name, c.company_name, c.created_at,
  (SELECT COALESCE(SUM(price_paid), 0) FROM entitlements WHERE customer_id = c.id) AS total_spend,
  (SELECT MAX(created_at) FROM sessions WHERE customer_id = c.id) AS last_login,
  (SELECT subscription_until FROM asins WHERE customer_id = c.id AND subscription_until IS NOT NULL
     ORDER BY subscription_until DESC LIMIT 1) AS subscription_until
`;

// Searches by email/name/company (primary), or by ASIN / Shopify order id if the
// query looks like one of those. An empty query returns the full customer list
// (capped) rather than nothing, so this doubles as the main admin customer table.
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await requireAdmin(request, env))) return adminUnauthorized();

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q) {
    const { results } = await env.DB.prepare(
      `SELECT ${CUSTOMER_COLUMNS} FROM customers c ORDER BY c.created_at DESC LIMIT 500`
    ).all();
    return json({ customers: results });
  }

  const like = `%${q}%`;
  const seen = new Map();

  const { results: byNameEmail } = await env.DB.prepare(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers c
     WHERE c.email LIKE ? OR c.full_name LIKE ? OR c.company_name LIKE ?
     ORDER BY c.created_at DESC LIMIT 500`
  )
    .bind(like, like, like)
    .all();
  for (const c of byNameEmail) seen.set(c.id, c);

  const isAsinLike = /^[A-Z0-9]{6,10}$/i.test(q);
  if (isAsinLike) {
    const { results: byAsin } = await env.DB.prepare(
      `SELECT ${CUSTOMER_COLUMNS} FROM customers c JOIN asins a ON a.customer_id = c.id
       WHERE a.asin LIKE ? LIMIT 500`
    )
      .bind(like)
      .all();
    for (const c of byAsin) seen.set(c.id, c);
  }

  const { results: byOrder } = await env.DB.prepare(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers c JOIN entitlements e ON e.customer_id = c.id
     WHERE e.source_order_id LIKE ? LIMIT 500`
  )
    .bind(like)
    .all();
  for (const c of byOrder) seen.set(c.id, c);

  return json({ customers: Array.from(seen.values()) });
}
