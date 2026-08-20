import { json, isValidEmail, extractAsin, runPrescan } from '../_shared/prescan-lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid request.' }, 400);
  }

  const email = (body.email || '').toString().trim().toLowerCase();
  const rawInput = (body.asin_or_url || '').toString().trim();
  const auditType = (body.audit_type || '').toString();
  const marketplace = (body.marketplace || 'amazon.com').toString();
  const strProvided = !!body.str_provided;
  const strNote = (body.str_note || '').toString().trim().slice(0, 500);
  const notes = (body.notes || '').toString().trim().slice(0, 1000);

  if (!isValidEmail(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }
  if (!rawInput) {
    return json({ error: 'Please enter your ASIN or Amazon listing URL.' }, 400);
  }
  if (!['listing', 'ppc', 'both'].includes(auditType)) {
    return json({ error: 'Please choose an audit type.' }, 400);
  }

  const asin = extractAsin(rawInput);
  if (!asin) {
    return json(
      { error: "We couldn't find a valid Amazon ASIN in that — paste the product URL or the 10-character ASIN (e.g. B0XXXXXXXX)." },
      400
    );
  }

  const id = crypto.randomUUID();
  const editToken = crypto.randomUUID().replace(/-/g, '');
  const now = new Date().toISOString();

  let prescan;
  try {
    prescan = await runPrescan(asin, marketplace, env);
  } catch (e) {
    prescan = { status: 'unavailable', reason: 'error' };
  }

  try {
    await env.DB.prepare(
      `INSERT INTO submissions
        (id, edit_token, email, asin_or_url, audit_type, marketplace, str_provided, str_note, notes,
         prescan_status, prescan_result, prescan_score, fulfillment_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        id,
        editToken,
        email,
        asin,
        auditType,
        marketplace,
        strProvided ? 1 : 0,
        strNote,
        notes,
        prescan.status,
        JSON.stringify(prescan),
        prescan.score ?? null,
        'not_purchased',
        now,
        now
      )
      .run();
  } catch (e) {
    return json({ error: 'Something went wrong saving your details. Please try again in a moment.' }, 500);
  }

  return json({ id, edit_token: editToken, asin, prescan });
}
