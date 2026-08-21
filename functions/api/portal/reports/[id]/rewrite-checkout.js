import { json } from '../../../../_shared/prescan-lib.js';
import { requireSession, unauthorized } from '../../../../_shared/auth-lib.js';

// Same store as the audit checkout — see asins/[id]/checkout.js. Looked up by product
// title (Shopify Storefront search syntax) rather than a hardcoded GID, so this starts
// working the moment the product exists in Shopify with this exact title — no manual
// GID handoff step needed.
const SHOPIFY_DOMAIN = 'arlig.myshopify.com';
const STOREFRONT_TOKEN = 'a6836f04aad6ac9499f609bc9df6110d';
const API_VERSION = '2024-10';
const REWRITE_PRODUCT_TITLE = 'Rewrite my listing';

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

  const report = await env.DB.prepare('SELECT * FROM reports WHERE id = ? AND customer_id = ?')
    .bind(params.id, auth.customer.id)
    .first();
  if (!report) return json({ error: 'Report not found.' }, 404);

  const eligible =
    report.status === 'delivered' &&
    ['listing', 'both'].includes(report.audit_type) &&
    report.rewrite_status === 'not_offered';
  if (!eligible) {
    return json({ error: 'This report is not eligible for a listing rewrite right now.' }, 400);
  }

  const asinRow = await env.DB.prepare('SELECT * FROM asins WHERE id = ?').bind(report.asin_id).first();

  const productResp = await shopifyGraphql(
    `query($q: String!) {
      products(first: 1, query: $q) {
        edges { node { variants(first: 1) { edges { node { id } } } } }
      }
    }`,
    { q: `title:'${REWRITE_PRODUCT_TITLE}'` }
  );

  const variant = productResp?.data?.products?.edges?.[0]?.node?.variants?.edges?.[0]?.node;
  if (!variant) {
    return json(
      { error: 'Rewrite offer is not available right now — please try again later, or email contact@arli.arligusa.com.' },
      502
    );
  }

  // Not flipping rewrite_status here, matching the existing audit checkout — payment
  // fulfillment isn't automated/webhooked yet, so status transitions stay a manual step
  // once the order's confirmed (same pattern as reports.status never leaving
  // 'awaiting_intake' automatically today).
  const cartResp = await shopifyGraphql(
    `mutation($input: CartInput!) {
      cartCreate(input: $input) {
        cart { checkoutUrl }
        userErrors { field message }
      }
    }`,
    {
      input: {
        lines: [{ merchandiseId: variant.id, quantity: 1 }],
        note: `Portal rewrite order — report ${report.id}, ASIN ${asinRow.asin}`,
        attributes: [
          { key: 'Customer ID', value: auth.customer.id },
          { key: 'Report ID', value: report.id },
          { key: 'ASIN', value: asinRow.asin },
          { key: 'Order Type', value: 'Listing Rewrite' },
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

  return json({ checkoutUrl: cart.checkoutUrl });
}
