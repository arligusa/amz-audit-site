// The free scan: email + ASIN only, no account, no live results on-page — the result
// gets emailed instead. Gated to one claim per ASIN ever (system-wide, not per
// visitor — there's no account yet at this point to scope it to) via the free_scans
// table's UNIQUE(asin, marketplace), independent of prescan_cache's technical TTL
// cache in prescan-lib.js (that just avoids re-scraping Amazon; this is the actual
// business rule).
import { json, isValidEmail, extractAsin, runPrescan } from '../_shared/prescan-lib.js';
import { sendPlainEmail } from '../_shared/auth-lib.js';

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
  const marketplace = (body.marketplace || 'amazon.com').toString();

  if (!isValidEmail(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }
  if (!rawInput) {
    return json({ error: 'Please enter your ASIN or Amazon listing URL.' }, 400);
  }

  const asin = extractAsin(rawInput);
  if (!asin) {
    return json(
      { error: "We couldn't find a valid Amazon ASIN in that — paste the product URL or the 10-character ASIN (e.g. B0XXXXXXXX)." },
      400
    );
  }

  const now = new Date().toISOString();

  try {
    await env.DB.prepare('INSERT INTO free_scans (id, asin, marketplace, email, created_at) VALUES (?,?,?,?,?)')
      .bind(crypto.randomUUID(), asin, marketplace, email, now)
      .run();
  } catch (e) {
    // UNIQUE(asin, marketplace) collision — this ASIN already used its one free scan.
    return json(
      { error: 'This ASIN has already had its free scan. Want the full picture? Buy a package below.' },
      409
    );
  }

  let prescan;
  try {
    prescan = await runPrescan(asin, marketplace, env);
  } catch (e) {
    prescan = { status: 'unavailable', reason: 'error' };
  }

  await sendFreeScanEmail(env, email, asin, prescan);

  return json({ ok: true });
}

async function sendFreeScanEmail(env, email, asin, prescan) {
  const subject = `Your free Arli Audits scan — ${asin}`;
  const overall = (prescan.categories || []).find((c) => c.key === 'overall');

  let resultLine;
  if (prescan.status === 'ok' && overall) {
    resultLine =
      overall.status === 'green'
        ? "Overall Listing Health: looking good — no major red flags on the public page."
        : "Overall Listing Health: needs attention — at least one category is falling short.";
  } else if (prescan.status === 'blocked') {
    resultLine = "We couldn't complete the scan this time — Amazon blocked the request. Try again in a bit.";
  } else {
    resultLine = "We couldn't complete the scan this time — please try again in a bit.";
  }

  const text = `Here's your free scan for ${asin}:\n\n${resultLine}\n\nThis free scan only checks what's visible on the public listing page. A full audit goes deeper — specific findings for every red flag, backend search terms, a competitor comparison, and a prioritized fix list ranked by impact vs. effort, all tied to your actual data.\n\nSee packages: https://arli.arligusa.com/#pricing\n\nQuestions? Reply to this email or reach us at contact@arli.arligusa.com.`;

  await sendPlainEmail(env, email, subject, text, `free scan result (${asin})`);
}
