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
  if (report.rewrite_status !== 'delivered' || !report.rewrite_r2_key) {
    return json({ error: 'This rewrite is not ready yet.' }, 404);
  }

  const object = await env.REPORTS_BUCKET.get(report.rewrite_r2_key);
  if (!object) return json({ error: 'Rewrite file is missing — please contact support.' }, 500);

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="arli-rewrite-${report.id}.pdf"`,
    },
  });
}
