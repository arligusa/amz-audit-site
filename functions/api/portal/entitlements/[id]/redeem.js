// Turns an unredeemed entitlement (a paid-for audit not yet tied to an ASIN — either
// because the customer bought directly from the Shopify product page with no site
// interaction, or hasn't picked an ASIN for it yet) into a real `reports` row. The
// audit_type is fixed by the entitlement itself, not re-selectable here.
import { json, extractAsin, marketplaceToDomain } from '../../../../_shared/prescan-lib.js';
import { requireSession, unauthorized } from '../../../../_shared/auth-lib.js';
import { validateUpload, uploadKey } from '../../../../_shared/upload-lib.js';

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const auth = await requireSession(env, request);
  if (!auth) return unauthorized();

  const entitlement = await env.DB.prepare(
    "SELECT * FROM entitlements WHERE id = ? AND customer_id = ? AND status = 'unredeemed'"
  )
    .bind(params.id, auth.customer.id)
    .first();
  if (!entitlement) return json({ error: 'Entitlement not found or already used.' }, 404);

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: 'Invalid request.' }, 400);
  }

  const field = (name) => (form.get(name) || '').toString();

  const rawAsin = field('asin_or_url').trim();
  const asin = extractAsin(rawAsin);
  if (!asin) {
    return json(
      { error: "We couldn't find a valid Amazon ASIN in that — paste the product URL or the 10-character ASIN (e.g. B0XXXXXXXX)." },
      400
    );
  }
  const marketplace = marketplaceToDomain(field('marketplace') || 'amazon.com');
  const label = field('label').trim().slice(0, 100) || null;
  const strNote = field('str_note').trim().slice(0, 500);
  const notes = field('notes').trim().slice(0, 1000);
  const backendTerms = field('backend_terms').trim().slice(0, 1000);
  const strReportFile = form.get('str_report_file');
  const bizReportFile = form.get('biz_report_file');

  let strReportValidation = null;
  if (strReportFile && strReportFile.size > 0) {
    strReportValidation = await validateUpload(strReportFile);
    if (strReportValidation.error) return json({ error: strReportValidation.error }, 400);
  } else if (['ppc', 'both'].includes(entitlement.audit_type)) {
    return json(
      { error: 'A PPC audit requires your Search Term Report. Upload the file below to redeem this entitlement.' },
      400
    );
  }

  let bizReportValidation = null;
  if (bizReportFile && bizReportFile.size > 0) {
    bizReportValidation = await validateUpload(bizReportFile);
    if (bizReportValidation.error) return json({ error: bizReportValidation.error }, 400);
  }

  const now = new Date().toISOString();

  let asinRow = await env.DB.prepare('SELECT id FROM asins WHERE customer_id = ? AND asin = ? AND marketplace = ? AND active = 1')
    .bind(auth.customer.id, asin, marketplace)
    .first();
  let asinId;
  if (asinRow) {
    asinId = asinRow.id;
  } else {
    asinId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO asins (id, customer_id, asin, marketplace, label, active, subscription_status, created_at, updated_at)
       VALUES (?,?,?,?,?,1,'not_subscribed',?,?)`
    )
      .bind(asinId, auth.customer.id, asin, marketplace, label, now, now)
      .run();
  }

  let strReportKey = null;
  let bizReportKey = null;
  try {
    if (strReportValidation) {
      strReportKey = uploadKey('reports', entitlement.id, 'str_report', strReportValidation.ext);
      await env.UPLOADS_BUCKET.put(strReportKey, strReportFile.stream(), {
        httpMetadata: { contentType: strReportFile.type || 'application/octet-stream' },
      });
    }
    if (bizReportValidation) {
      bizReportKey = uploadKey('reports', entitlement.id, 'biz_report', bizReportValidation.ext);
      await env.UPLOADS_BUCKET.put(bizReportKey, bizReportFile.stream(), {
        httpMetadata: { contentType: bizReportFile.type || 'application/octet-stream' },
      });
    }
  } catch (e) {
    return json({ error: 'Something went wrong uploading your file. Please try again in a moment.' }, 500);
  }

  const reportId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO reports
      (id, asin_id, customer_id, audit_type, status, str_provided, str_note, notes,
       backend_terms, biz_report_provided, str_report_r2_key, biz_report_r2_key, created_at, updated_at)
     VALUES (?,?,?,?,'awaiting_intake',?,?,?,?,?,?,?,?,?)`
  )
    .bind(reportId, asinId, auth.customer.id, entitlement.audit_type, strReportKey ? 1 : 0, strNote, notes, backendTerms, bizReportKey ? 1 : 0, strReportKey, bizReportKey, now, now)
    .run();

  await env.DB.prepare("UPDATE entitlements SET status = 'redeemed', report_id = ?, redeemed_at = ? WHERE id = ?")
    .bind(reportId, now, entitlement.id)
    .run();

  return json({ ok: true, report_id: reportId, asin_id: asinId });
}
