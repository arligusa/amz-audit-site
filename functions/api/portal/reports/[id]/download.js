import { json } from '../../../../_shared/prescan-lib.js';
import { requireSession, unauthorized } from '../../../../_shared/auth-lib.js';

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const auth = await requireSession(env, request);
  if (!auth) return unauthorized();

  const report = await env.DB.prepare('SELECT * FROM reports WHERE id = ? AND customer_id = ?')
    .bind(params.id, auth.customer.id)
    .first();

  if (!report) return json({ error: 'Report not found.' }, 404);
  if (report.status !== 'delivered' || !report.r2_key) {
    return json({ error: 'This report is not ready yet.' }, 404);
  }

  const object = await env.REPORTS_BUCKET.get(report.r2_key);
  if (!object) return json({ error: 'Report file is missing — please contact support.' }, 500);

  // Only ever set once — first view. The WHERE clause (not a separate SELECT-then-
  // UPDATE) makes this safe against a concurrent double-request racing this same row.
  await env.DB.prepare('UPDATE reports SET viewed_at = ? WHERE id = ? AND viewed_at IS NULL')
    .bind(new Date().toISOString(), report.id)
    .run();

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="arli-audit-${report.id}.pdf"`,
    },
  });
}
