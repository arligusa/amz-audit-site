import { json } from '../../../../_shared/prescan-lib.js';
import { requireSession, unauthorized } from '../../../../_shared/auth-lib.js';

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

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid request.' }, 400);
  }

  const auditType = (body.audit_type || '').toString();
  if (!['listing', 'ppc', 'both'].includes(auditType)) {
    return json({ error: 'Please choose an audit type.' }, 400);
  }
  const strProvided = !!body.str_provided;
  const strNote = (body.str_note || '').toString().trim().slice(0, 500);
  const notes = (body.notes || '').toString().trim().slice(0, 1000);

  const reportId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO reports (id, asin_id, customer_id, audit_type, status, str_provided, str_note, notes, created_at, updated_at)
     VALUES (?,?,?,?,'awaiting_intake',?,?,?,?,?)`
  )
    .bind(reportId, asinRow.id, auth.customer.id, auditType, strProvided ? 1 : 0, strNote, notes, now, now)
    .run();

  const productResp = await shopifyGraphql(
    `query($id: ID!) { product(id: $id) { variants(first: 10) { edges { node { id title } } } } }`,
    { id: PRODUCT_GID }
  );

  const variants = productResp?.data?.product?.variants?.edges || [];
  const targetTitle = AUDIT_LABEL[auditType];
  const variant = variants.find((e) => e.node.title === targetTitle) || variants[0];

  if (!variant) {
    return json({ error: 'Could not start checkout — please try again, or email contact@amzaudits.arligusa.com.' }, 502);
  }

  const checkoutResp = await shopifyGraphql(
    `mutation($input: CheckoutCreateInput!) {
      checkoutCreate(input: $input) {
        checkout { webUrl }
        checkoutUserErrors { code field message }
      }
    }`,
    {
      input: {
        lineItems: [{ variantId: variant.node.id, quantity: 1 }],
        note: `Portal order — report ${reportId}, ASIN ${asinRow.asin}`,
        customAttributes: [
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

  const checkout = checkoutResp?.data?.checkoutCreate?.checkout;
  const errors = checkoutResp?.data?.checkoutCreate?.checkoutUserErrors;
  if (!checkout || (errors && errors.length)) {
    return json({ error: 'Could not start checkout — please try again, or email contact@amzaudits.arligusa.com.' }, 502);
  }

  return json({ checkoutUrl: checkout.webUrl, report_id: reportId });
}
