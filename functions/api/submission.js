import { json, isValidEmail, extractAsin, runPrescan } from '../_shared/prescan-lib.js';

function sanitize(row) {
  return {
    id: row.id,
    email: row.email,
    asin_or_url: row.asin_or_url,
    audit_type: row.audit_type,
    marketplace: row.marketplace,
    str_provided: !!row.str_provided,
    str_note: row.str_note || '',
    notes: row.notes || '',
    backend_terms: row.backend_terms || '',
    biz_report_provided: !!row.biz_report_provided,
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

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid request.' }, 400);
  }

  const id = (body.id || '').toString();
  const token = (body.token || '').toString();
  if (!id || !token) {
    return json({ error: 'Missing id or token.' }, 400);
  }

  const row = await env.DB.prepare('SELECT * FROM submissions WHERE id = ? AND edit_token = ?').bind(id, token).first();
  if (!row) {
    return json({ error: "We couldn't find that submission. Double-check the link, or email contact@arli.arligusa.com." }, 404);
  }

  const email = body.email !== undefined ? String(body.email).trim().toLowerCase() : row.email;
  if (!isValidEmail(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }

  const rawAsin = body.asin_or_url !== undefined ? String(body.asin_or_url).trim() : row.asin_or_url;
  const asin = extractAsin(rawAsin) || row.asin_or_url;

  const auditType = body.audit_type !== undefined ? String(body.audit_type) : row.audit_type;
  if (!['listing', 'ppc', 'both'].includes(auditType)) {
    return json({ error: 'Please choose a valid audit type.' }, 400);
  }

  const marketplace = body.marketplace !== undefined ? String(body.marketplace) : row.marketplace;
  const strProvided = body.str_provided !== undefined ? !!body.str_provided : !!row.str_provided;
  const strNote = body.str_note !== undefined ? String(body.str_note).trim().slice(0, 500) : row.str_note;
  const notes = body.notes !== undefined ? String(body.notes).trim().slice(0, 1000) : row.notes;
  const backendTerms = body.backend_terms !== undefined ? String(body.backend_terms).trim().slice(0, 1000) : row.backend_terms;
  const bizReportProvided = body.biz_report_provided !== undefined ? !!body.biz_report_provided : !!row.biz_report_provided;

  if (['ppc', 'both'].includes(auditType) && !strProvided) {
    return json(
      { error: "A PPC audit requires your Search Term Report. Check the box to confirm you'll send it, or switch to a Listing-only audit." },
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
      backend_terms = ?, biz_report_provided = ?,
      prescan_status = ?, prescan_result = ?, prescan_score = ?, updated_at = ?
     WHERE id = ? AND edit_token = ?`
  )
    .bind(
      email,
      asin,
      auditType,
      marketplace,
      strProvided ? 1 : 0,
      strNote,
      notes,
      backendTerms,
      bizReportProvided ? 1 : 0,
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
