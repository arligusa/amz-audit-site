// Upload the finished audit PDF for a report — the piece that closes the loop.
// Before this endpoint existed, there was no mechanism anywhere in the system to
// actually mark a report delivered; it had to happen entirely out of band.
import { json } from '../../../../_shared/prescan-lib.js';
import { requireAdmin, adminUnauthorized, logAdminAction } from '../../../../_shared/admin-lib.js';
import { sendLoginLinkEmail } from '../../../../_shared/auth-lib.js';

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const adminEmail = await requireAdmin(request, env);
  if (!adminEmail) return adminUnauthorized();

  const report = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(params.id).first();
  if (!report) return json({ error: 'Report not found.' }, 404);

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: 'Invalid request.' }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) {
    return json({ error: 'No file was received.' }, 400);
  }
  if (!/\.pdf$/i.test(file.name || '')) {
    return json({ error: 'Please upload a .pdf file.' }, 400);
  }

  const r2Key = `reports/${report.id}/final.pdf`;
  await env.REPORTS_BUCKET.put(r2Key, file.stream(), { httpMetadata: { contentType: 'application/pdf' } });

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE reports SET r2_key = ?, status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?")
    .bind(r2Key, now, now, report.id)
    .run();

  await logAdminAction(env, {
    adminEmail,
    action: 'deliver_report',
    targetType: 'report',
    targetId: report.id,
    reason: null,
  });

  // The delivery itself (file + status + audit log) is already committed above — an
  // email hiccup here shouldn't turn an already-successful delivery into an error
  // response, which could prompt an admin to redundantly retry the upload.
  const customer = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(report.customer_id).first();
  if (customer) {
    try {
      await sendLoginLinkEmail(env, request, customer.email, {
        subject: 'Your Arli Audits report is ready',
        intro: 'Your audit is complete and ready to view — log in to your portal below to see it.',
      });
    } catch (e) {
      console.log(`[deliver] failed to email ${customer.email} for report ${report.id}: ${e}`);
    }
  }

  return json({ ok: true });
}
