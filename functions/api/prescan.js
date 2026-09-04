import { json, isValidEmail, extractAsin, runPrescan } from '../_shared/prescan-lib.js';
import { validateUpload, uploadKey } from '../_shared/upload-lib.js';
import { sendPlainEmail } from '../_shared/auth-lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: 'Invalid request.' }, 400);
  }

  const field = (name) => (form.get(name) || '').toString();

  const email = field('email').trim().toLowerCase();
  const rawInput = field('asin_or_url').trim();
  const auditType = field('audit_type');
  const marketplace = field('marketplace') || 'amazon.com';
  const strNote = field('str_note').trim().slice(0, 500);
  const notes = field('notes').trim().slice(0, 1000);
  const backendTerms = field('backend_terms').trim().slice(0, 1000);
  const strReportFile = form.get('str_report_file');
  const bizReportFile = form.get('biz_report_file');

  if (!isValidEmail(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }
  if (!rawInput) {
    return json({ error: 'Please enter your ASIN or Amazon listing URL.' }, 400);
  }
  if (!['listing', 'ppc', 'both'].includes(auditType)) {
    return json({ error: 'Please choose an audit type.' }, 400);
  }

  let strReportValidation = null;
  if (strReportFile && strReportFile.size > 0) {
    strReportValidation = await validateUpload(strReportFile);
    if (strReportValidation.error) return json({ error: strReportValidation.error }, 400);
  } else if (['ppc', 'both'].includes(auditType)) {
    return json(
      { error: 'A PPC audit requires your Search Term Report. Upload the file below, or switch to a Listing-only audit.' },
      400
    );
  }

  let bizReportValidation = null;
  if (bizReportFile && bizReportFile.size > 0) {
    bizReportValidation = await validateUpload(bizReportFile);
    if (bizReportValidation.error) return json({ error: bizReportValidation.error }, 400);
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

  let strReportKey = null;
  let bizReportKey = null;
  try {
    if (strReportValidation) {
      strReportKey = uploadKey('submissions', id, 'str_report', strReportValidation.ext);
      await env.UPLOADS_BUCKET.put(strReportKey, strReportFile.stream(), {
        httpMetadata: { contentType: strReportFile.type || 'application/octet-stream' },
      });
    }
    if (bizReportValidation) {
      bizReportKey = uploadKey('submissions', id, 'biz_report', bizReportValidation.ext);
      await env.UPLOADS_BUCKET.put(bizReportKey, bizReportFile.stream(), {
        httpMetadata: { contentType: bizReportFile.type || 'application/octet-stream' },
      });
    }
  } catch (e) {
    return json({ error: 'Something went wrong uploading your file. Please try again in a moment.' }, 500);
  }

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
         backend_terms, biz_report_provided, str_report_r2_key, biz_report_r2_key,
         prescan_status, prescan_result, prescan_score, fulfillment_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        id,
        editToken,
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
        'not_purchased',
        now,
        now
      )
      .run();
  } catch (e) {
    return json({ error: 'Something went wrong saving your details. Please try again in a moment.' }, 500);
  }

  await sendEditLinkEmail({ env, request, email, id, editToken });

  return json({ id, edit_token: editToken, asin, prescan });
}

// Same edit-link shape as the Shopify checkout note built in index.html
// (`{origin}/edit.html?id=...&token=...`) — this is the customer-facing copy of
// that link; the checkout note stays as a secondary/staff-facing copy of it.
async function sendEditLinkEmail({ env, request, email, id, editToken }) {
  const editUrl = new URL('/edit.html', request.url);
  editUrl.searchParams.set('id', id);
  editUrl.searchParams.set('token', editToken);

  const subject = 'Edit your Arli Audits submission';
  const text =
    `We've saved your Arli Audits submission. If you spot a mistake — wrong ASIN, wrong audit type, or the wrong file uploaded — you can fix it yourself before your audit starts, no need to email us:\n\n` +
    `${editUrl.toString()}\n\n` +
    `This link doesn't expire, but it only changes what you submitted — once you complete your purchase, the details on file at that moment are what we audit, so make any corrections before then.\n\n` +
    `Questions? Reply to this email or reach us at contact@arli.arligusa.com.`;

  await sendPlainEmail(env, email, subject, text, `submission edit link (${editUrl.toString()})`);
}
