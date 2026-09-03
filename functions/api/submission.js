import { json, isValidEmail, extractAsin, runPrescan } from '../_shared/prescan-lib.js';
import { validateUpload, uploadKey } from '../_shared/upload-lib.js';

function sanitize(row) {
  return {
    id: row.id,
    email: row.email,
    asin_or_url: row.asin_or_url,
    audit_type: row.audit_type,
    marketplace: row.marketplace,
    str_provided: !!row.str_report_r2_key,
    str_note: row.str_note || '',
    notes: row.notes || '',
    backend_terms: row.backend_terms || '',
    biz_report_provided: !!row.biz_report_r2_key,
    prescan_status: row.prescan_status,
    prescan_result: row.prescan_result ? JSON.parse(row.prescan_result) : null,
    fulfillment_status: row.fulfillment_status,
    order_name: row.order_name || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const token = url.searchParams.get('token');

  if (!id || !token) {
    return json({ error: 'Missing id or token.' }, 400);
  }

  const row = await env.DB.prepare('SELECT * FROM submissions WHERE id = ? AND edit_token = ?').bind(id, token).first();
  if (!row) {
    return json({ error: "We couldn't find that submission. Double-check the link, or email contact@arli.arligusa.com." }, 404);
  }

  return json({ submission: sanitize(row) });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: 'Invalid request.' }, 400);
  }

  const has = (name) => form.has(name);
  const field = (name) => (form.get(name) || '').toString();

  const id = field('id');
  const token = field('token');
  if (!id || !token) {
    return json({ error: 'Missing id or token.' }, 400);
  }

  const row = await env.DB.prepare('SELECT * FROM submissions WHERE id = ? AND edit_token = ?').bind(id, token).first();
  if (!row) {
    return json({ error: "We couldn't find that submission. Double-check the link, or email contact@arli.arligusa.com." }, 404);
  }

  const email = has('email') ? field('email').trim().toLowerCase() : row.email;
  if (!isValidEmail(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }

  const rawAsin = has('asin_or_url') ? field('asin_or_url').trim() : row.asin_or_url;
  const asin = extractAsin(rawAsin) || row.asin_or_url;

  const auditType = has('audit_type') ? field('audit_type') : row.audit_type;
  if (!['listing', 'ppc', 'both'].includes(auditType)) {
    return json({ error: 'Please choose a valid audit type.' }, 400);
  }

  const marketplace = has('marketplace') ? field('marketplace') : row.marketplace;
  const strNote = has('str_note') ? field('str_note').trim().slice(0, 500) : row.str_note;
  const notes = has('notes') ? field('notes').trim().slice(0, 1000) : row.notes;
  const backendTerms = has('backend_terms') ? field('backend_terms').trim().slice(0, 1000) : row.backend_terms;

  const strReportFile = form.get('str_report_file');
  const bizReportFile = form.get('biz_report_file');

  let strReportKey = row.str_report_r2_key;
  if (strReportFile && strReportFile.size > 0) {
    const validation = await validateUpload(strReportFile);
    if (validation.error) return json({ error: validation.error }, 400);
    strReportKey = uploadKey('submissions', id, 'str_report', validation.ext);
    try {
      await env.UPLOADS_BUCKET.put(strReportKey, strReportFile.stream(), {
        httpMetadata: { contentType: strReportFile.type || 'application/octet-stream' },
      });
    } catch (e) {
      return json({ error: 'Something went wrong uploading your file. Please try again in a moment.' }, 500);
    }
  }

  let bizReportKey = row.biz_report_r2_key;
  if (bizReportFile && bizReportFile.size > 0) {
    const validation = await validateUpload(bizReportFile);
    if (validation.error) return json({ error: validation.error }, 400);
    bizReportKey = uploadKey('submissions', id, 'biz_report', validation.ext);
    try {
      await env.UPLOADS_BUCKET.put(bizReportKey, bizReportFile.stream(), {
        httpMetadata: { contentType: bizReportFile.type || 'application/octet-stream' },
      });
    } catch (e) {
      return json({ error: 'Something went wrong uploading your file. Please try again in a moment.' }, 500);
    }
  }

  if (['ppc', 'both'].includes(auditType) && !strReportKey) {
    return json(
      { error: 'A PPC audit requires your Search Term Report. Upload the file below, or switch to a Listing-only audit.' },
      400
    );
  }

  let prescan;
  try {
    prescan = await runPrescan(asin, marketplace, env);
  } catch (e) {
    prescan = { status: 'unavailable', reason: 'error' };
  }

  const now = new Date().toISOString();

  await env.DB.prepare(
    `UPDATE submissions SET
      email = ?, asin_or_url = ?, audit_type = ?, marketplace = ?, str_provided = ?, str_note = ?, notes = ?,
      backend_terms = ?, biz_report_provided = ?, str_report_r2_key = ?, biz_report_r2_key = ?,
      prescan_status = ?, prescan_result = ?, prescan_score = ?, updated_at = ?
     WHERE id = ? AND edit_token = ?`
  )
    .bind(
      email,
      asin,
      auditType,
      marketplace,
      strReportKey ? 1 : 0,
      strNote,
      notes,
      backendTerms,
      bizReportKey ? 1 : 0,
      strReportKey,
      bizReportKey,
      prescan.status,
      JSON.stringify(prescan),
      prescan.score ?? null,
      now,
      id,
      token
    )
    .run();

  const updated = await env.DB.prepare('SELECT * FROM submissions WHERE id = ? AND edit_token = ?').bind(id, token).first();
  return json({ submission: sanitize(updated) });
}
