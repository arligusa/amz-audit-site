import { json } from '../../../../_shared/prescan-lib.js';
import { requireAdmin, adminUnauthorized } from '../../../../_shared/admin-lib.js';

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const adminEmail = await requireAdmin(request, env);
  if (!adminEmail) return adminUnauthorized();

  const report = await env.DB.prepare('SELECT * FROM reports WHERE id = ?')
    .bind(params.id)
    .first();

  if (!report) return json({ error: 'Report not found.' }, 404);
  if (report.status !== 'delivered' || !report.r2_key) {
    return json({ error: 'This report is not ready yet.' }, 404);
  }

  const object = await env.REPORTS_BUCKET.get(report.r2_key);
  if (!object) return json({ error: 'Report file is missing — please contact support.' }, 500);

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="arli-audit-${report.id}.pdf"`,
    },
  });
}
