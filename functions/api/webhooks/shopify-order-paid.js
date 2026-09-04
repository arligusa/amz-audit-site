// Fires on Shopify's "Order payment" (orders/paid) event — the single place a
// completed payment turns into a real customer account + report, regardless of
// whether the order came from our homepage intake, a portal repeat-purchase, or
// someone buying directly from the Shopify product page with no site interaction
// at all. See /Users/kendall/.claude/plans/effervescent-beaming-fox.md for the
// full design.
import { json, auditTypeFromVariantTitle, SHOPIFY_ATTR, SHOPIFY_PRODUCT_ID } from '../../_shared/prescan-lib.js';
import { verifyShopifyWebhookHmac, sendPlainEmail, newToken, hashToken, magicLinkExpiry } from '../../_shared/auth-lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const rawBody = await request.text();
  const hmacHeader = request.headers.get('X-Shopify-Hmac-Sha256');
  const verified = await verifyShopifyWebhookHmac(env, rawBody, hmacHeader);
  if (!verified) {
    return json({ error: 'Invalid signature.' }, 401);
  }

  let order;
  try {
    order = JSON.parse(rawBody);
  } catch (e) {
    return json({ error: 'Invalid payload.' }, 400);
  }

  const orderId = order.id !== undefined && order.id !== null ? String(order.id) : '';
  if (!orderId) return json({ error: 'Missing order id.' }, 400);

  // This webhook subscription is store-wide — Shopify has no per-product filter at
  // the subscription level, and the store sells other, unrelated products too. Gate
  // on product id BEFORE touching the database at all: no customer created, no
  // email sent, nothing written for an order that isn't ours. auditLineItems is
  // reused below so this check and the actual processing can't drift apart.
  const auditLineItems = (order.line_items || []).filter(
    (li) => li && String(li.product_id) === SHOPIFY_PRODUCT_ID
  );
  if (!auditLineItems.length) {
    return json({ ok: true, ignored: 'not_our_product' });
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // Idempotency — Shopify redelivers webhooks (retries, manual resends). Insert-or-abort
  // on the order id guards against double-creating customers/entitlements/reports.
  // Shopify expects a 2xx regardless of whether this is a first or repeat delivery,
  // so it stops retrying either way.
  try {
    await env.DB.prepare('INSERT INTO processed_shopify_orders (shopify_order_id, processed_at) VALUES (?,?)')
      .bind(orderId, nowIso)
      .run();
  } catch (e) {
    return json({ ok: true, already_processed: true });
  }

  const email = (order.email || order.contact_email || '').toString().trim().toLowerCase();
  if (!email) {
    console.log(`[shopify-order-paid] order ${orderId} has no email on it, cannot proceed`);
    return json({ ok: true, error: 'no_email' });
  }

  const attrs = {};
  for (const attr of order.note_attributes || []) {
    if (attr && attr.name) attrs[attr.name] = attr.value;
  }

  let customer = await env.DB.prepare('SELECT * FROM customers WHERE email = ?').bind(email).first();
  const isNewCustomer = !customer;
  if (!customer) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO customers (id, email, created_at, updated_at) VALUES (?,?,?,?)')
      .bind(id, email, nowIso, nowIso)
      .run();
    customer = { id, email };
  }

  // One entitlement per audit purchased. Today's product always sells qty 1 of one
  // variant, so this is always exactly one entitlement — written as a loop so a
  // future multi-quantity/multi-ASIN package works without changing this logic.
  for (const lineItem of auditLineItems) {
    const auditType = auditTypeFromVariantTitle(lineItem.variant_title || lineItem.title);
    if (!auditType) continue; // our product, but a variant title we don't recognize — skip rather than guess
    const quantity = Number(lineItem.quantity) || 1;
    // line_item.price is the PRE-discount unit price. discount_allocations is where
    // Shopify puts the actual amount knocked off this line — both line-item-level
    // discounts and order-level ones (Shopify distributes those down per line item
    // specifically so this works) — so net = gross line total minus allocations,
    // split evenly across quantity to get what each entitlement actually cost.
    const grossLineTotal = (Number.parseFloat(lineItem.price) || 0) * quantity;
    const lineDiscounts = (lineItem.discount_allocations || []).reduce(
      (sum, da) => sum + (Number.parseFloat(da.amount) || 0),
      0
    );
    const netLineTotal = Math.max(0, grossLineTotal - lineDiscounts);
    const pricePaid = Math.round((netLineTotal / quantity) * 100) / 100;
    for (let i = 0; i < quantity; i++) {
      await createAndRedeemEntitlement({ env, customer, auditType, orderId, pricePaid, attrs, nowIso });
    }
  }

  await sendPurchaseConfirmationEmail({ env, request, customer, isNewCustomer });

  return json({ ok: true });
}

async function createAndRedeemEntitlement({ env, customer, auditType, orderId, pricePaid, attrs, nowIso }) {
  const entitlementId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO entitlements (id, customer_id, audit_type, source_order_id, price_paid, status, created_at)
     VALUES (?,?,?,?,?,'unredeemed',?)`
  )
    .bind(entitlementId, customer.id, auditType, orderId, pricePaid, nowIso)
    .run();

  // Homepage path: a Submission ID attribute points at a pending `submissions` row
  // with everything already collected (ASIN, marketplace, uploaded files, notes).
  const submissionId = attrs[SHOPIFY_ATTR.SUBMISSION_ID];
  if (submissionId) {
    const submission = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(submissionId).first();
    if (submission) {
      const asinId = await findOrCreateAsin({ env, customerId: customer.id, asin: submission.asin_or_url, marketplace: submission.marketplace, nowIso });
      const reportId = await createReport({
        env,
        customerId: customer.id,
        asinId,
        auditType,
        strProvided: !!submission.str_report_r2_key,
        strNote: submission.str_note || '',
        notes: submission.notes || '',
        backendTerms: submission.backend_terms || '',
        strReportKey: submission.str_report_r2_key || null,
        bizReportProvided: !!submission.biz_report_r2_key,
        bizReportKey: submission.biz_report_r2_key || null,
        nowIso,
      });
      await redeemEntitlement({ env, entitlementId, reportId, nowIso });
      await env.DB.prepare("UPDATE submissions SET fulfillment_status = 'purchased', updated_at = ? WHERE id = ?")
        .bind(nowIso, submission.id)
        .run();
      return;
    }
  }

  // Portal repeat-purchase path: Customer ID + ASIN ID attributes identify an ASIN
  // the customer already has tracked; the rest of the intake rides along inline.
  const attrCustomerId = attrs[SHOPIFY_ATTR.CUSTOMER_ID];
  const attrAsinId = attrs[SHOPIFY_ATTR.ASIN_ID];
  if (attrCustomerId === customer.id && attrAsinId) {
    const asin = await env.DB.prepare('SELECT id FROM asins WHERE id = ? AND customer_id = ?')
      .bind(attrAsinId, customer.id)
      .first();
    if (asin) {
      const strReportKey = attrs[SHOPIFY_ATTR.STR_REPORT_KEY] || null;
      const bizReportKey = attrs[SHOPIFY_ATTR.BIZ_REPORT_KEY] || null;
      const reportId = await createReport({
        env,
        customerId: customer.id,
        asinId: asin.id,
        auditType,
        strProvided: !!strReportKey,
        strNote: attrs[SHOPIFY_ATTR.STR_NOTE] || '',
        notes: attrs[SHOPIFY_ATTR.NOTES] || '',
        backendTerms: attrs[SHOPIFY_ATTR.BACKEND_TERMS] || '',
        strReportKey,
        bizReportProvided: !!bizReportKey,
        bizReportKey,
        nowIso,
      });
      await redeemEntitlement({ env, entitlementId, reportId, nowIso });
      return;
    }
  }

  // Neither present — a walk-in Shopify purchase with no site interaction at all.
  // The entitlement stays unredeemed; the customer redeems it from the portal once
  // they log in via functions/api/portal/entitlements/redeem.js.
}

async function findOrCreateAsin({ env, customerId, asin, marketplace, nowIso }) {
  const existing = await env.DB.prepare('SELECT id FROM asins WHERE customer_id = ? AND asin = ? AND marketplace = ? AND active = 1')
    .bind(customerId, asin, marketplace || 'amazon.com')
    .first();
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO asins (id, customer_id, asin, marketplace, active, subscription_status, created_at, updated_at)
     VALUES (?,?,?,?,1,'not_subscribed',?,?)`
  )
    .bind(id, customerId, asin, marketplace || 'amazon.com', nowIso, nowIso)
    .run();
  return id;
}

async function createReport({ env, customerId, asinId, auditType, strProvided, strNote, notes, backendTerms, strReportKey, bizReportProvided, bizReportKey, nowIso }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO reports
      (id, asin_id, customer_id, audit_type, status, str_provided, str_note, notes,
       backend_terms, biz_report_provided, str_report_r2_key, biz_report_r2_key, created_at, updated_at)
     VALUES (?,?,?,?,'awaiting_intake',?,?,?,?,?,?,?,?,?)`
  )
    .bind(id, asinId, customerId, auditType, strProvided ? 1 : 0, strNote, notes, backendTerms, bizReportProvided ? 1 : 0, strReportKey, bizReportKey, nowIso, nowIso)
    .run();
  return id;
}

async function redeemEntitlement({ env, entitlementId, reportId, nowIso }) {
  await env.DB.prepare("UPDATE entitlements SET status = 'redeemed', report_id = ?, redeemed_at = ? WHERE id = ?")
    .bind(reportId, nowIso, entitlementId)
    .run();
}

async function sendPurchaseConfirmationEmail({ env, request, customer, isNewCustomer }) {
  const token = newToken();
  const tokenHash = await hashToken(token);
  const now = new Date();
  await env.DB.prepare('INSERT INTO magic_links (token, customer_email, created_at, expires_at, used_at) VALUES (?,?,?,?,NULL)')
    .bind(tokenHash, customer.email, now.toISOString(), magicLinkExpiry(now))
    .run();

  const verifyUrl = new URL('/api/auth/verify', request.url);
  verifyUrl.searchParams.set('token', token);

  const subject = 'Your Arli Audits order is confirmed';
  const intro = isNewCustomer
    ? "Thanks for your order — let's get your account set up."
    : 'Thanks for your order — log in to see it in your portal.';
  const text = `${intro}\n\nClick below to log in. This link expires in 15 minutes and can only be used once.\n\n${verifyUrl.toString()}\n\nQuestions? Reply to this email or reach us at contact@arli.arligusa.com.`;

  await sendPlainEmail(env, customer.email, subject, text, `purchase confirmation (${verifyUrl.toString()})`);
}
