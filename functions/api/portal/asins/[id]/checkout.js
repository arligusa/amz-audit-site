import { json } from '../../../../_shared/prescan-lib.js';
import { requireSession, unauthorized } from '../../../../_shared/auth-lib.js';
import { validateUpload, uploadKey } from '../../../../_shared/upload-lib.js';

// Same store/product as the homepage checkout — see index.html's checkout script.
// Note: customAttributes only apply at checkout level, not per line item, and
// product.fetch needs the full gid:// string — both bit the homepage flow once already.
const SHOPIFY_DOMAIN = 'arlig.myshopify.com';
const STOREFRONT_TOKEN = 'a6836f04aad6ac9499f609bc9df6110d';
const PRODUCT_GID = 'gid://shopify/Product/15863583179038';
const API_VERSION = '2024-10';

const AUDIT_LABEL = { listing: 'Listing Audit', ppc: 'PPC Audit', both: 'Both (Listing + PPC)' };

async function shopifyGraphql(query, variables) {
  const resp = await fetch(`https://${SHOPIFY_DOMAIN}/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  return resp.json();
}

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const auth = await requireSession(env, request);
  if (!auth) return unauthorized();

  const asinRow = await env.DB.prepare('SELECT * FROM asins WHERE id = ? AND customer_id = ? AND active = 1')
    .bind(params.id, auth.customer.id)
    .first();
  if (!asinRow) return json({ error: 'ASIN not found.' }, 404);

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: 'Invalid request.' }, 400);
  }

  const field = (name) => (form.get(name) || '').toString();

  const auditType = field('audit_type');
  if (!['listing', 'ppc', 'both'].includes(auditType)) {
    return json({ error: 'Please choose an audit type.' }, 400);
  }
  const strNote = field('str_note').trim().slice(0, 500);
  const notes = field('notes').trim().slice(0, 1000);
  const backendTerms = field('backend_terms').trim().slice(0, 1000);
  const strReportFile = form.get('str_report_file');
  const bizReportFile = form.get('biz_report_file');

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

  const reportId = crypto.randomUUID();
  const now = new Date().toISOString();

  let strReportKey = null;
  let bizReportKey = null;
  try {
    if (strReportValidation) {
      strReportKey = uploadKey('reports', reportId, 'str_report', strReportValidation.ext);
      await env.UPLOADS_BUCKET.put(strReportKey, strReportFile.stream(), {
        httpMetadata: { contentType: strReportFile.type || 'application/octet-stream' },
      });
    }
    if (bizReportValidation) {
      bizReportKey = uploadKey('reports', reportId, 'biz_report', bizReportValidation.ext);
      await env.UPLOADS_BUCKET.put(bizReportKey, bizReportFile.stream(), {
        httpMetadata: { contentType: bizReportFile.type || 'application/octet-stream' },
      });
    }
  } catch (e) {
    return json({ error: 'Something went wrong uploading your file. Please try again in a moment.' }, 500);
  }

  await env.DB.prepare(
    `INSERT INTO reports (id, asin_id, customer_id, audit_type, status, str_provided, str_note, notes, backend_terms, biz_report_provided, str_report_r2_key, biz_report_r2_key, created_at, updated_at)
     VALUES (?,?,?,?,'awaiting_intake',?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      reportId,
      asinRow.id,
      auth.customer.id,
      auditType,
      strReportKey ? 1 : 0,
      strNote,
      notes,
      backendTerms,
      bizReportKey ? 1 : 0,
      strReportKey,
      bizReportKey,
      now,
      now
    )
    .run();

  const productResp = await shopifyGraphql(
    `query($id: ID!) { product(id: $id) { variants(first: 10) { edges { node { id title } } } } }`,
    { id: PRODUCT_GID }
  );

  const variants = productResp?.data?.product?.variants?.edges || [];
  const targetTitle = AUDIT_LABEL[auditType];
  const variant = variants.find((e) => e.node.title === targetTitle) || variants[0];

  if (!variant) {
    return json({ error: 'Could not start checkout — please try again, or email contact@arli.arligusa.com.' }, 502);
  }

  // Shopify deprecated the Checkout API (checkoutCreate) in favor of the Cart API on
  // recent Storefront API versions — cartCreate + cart.checkoutUrl is the replacement.
  // Cart-level `attributes`/`note` are the equivalent of the old checkout-level
  // customAttributes/note (still not per-line-item, same reasoning as the homepage flow).
  const cartResp = await shopifyGraphql(
    `mutation($input: CartInput!) {
      cartCreate(input: $input) {
        cart { checkoutUrl }
        userErrors { field message }
      }
    }`,
    {
      input: {
        lines: [{ merchandiseId: variant.node.id, quantity: 1 }],
        note: `Portal order — report ${reportId}, ASIN ${asinRow.asin}`,
        attributes: [
          { key: 'Customer ID', value: auth.customer.id },
          { key: 'ASIN ID', value: asinRow.id },
          { key: 'Report ID', value: reportId },
          { key: 'ASIN', value: asinRow.asin },
          { key: 'Audit Type', value: targetTitle },
          { key: 'Customer Email', value: auth.customer.email },
        ],
      },
    }
  );

  const cart = cartResp?.data?.cartCreate?.cart;
  const errors = cartResp?.data?.cartCreate?.userErrors;
  if (!cart || (errors && errors.length)) {
    return json({ error: 'Could not start checkout — please try again, or email contact@arli.arligusa.com.' }, 502);
  }

  return json({ checkoutUrl: cart.checkoutUrl, report_id: reportId });
}
