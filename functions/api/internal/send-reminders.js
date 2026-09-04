// Cron-triggered reminder scan — invoked by a separate Cloudflare Worker's Cron
// Trigger, not a logged-in human, so this endpoint sits outside Cloudflare Access
// (unlike /api/admin/**) and is instead gated on a shared secret header. This isn't
// a public-facing auth token in the same sense as the Shopify webhook HMAC (see
// verifyShopifyWebhookHmac in _shared/auth-lib.js for that defensive style), so a
// plain strict-equality check against env.INTERNAL_CRON_SECRET (a Pages secret
// set outside this repo) is sufficient here.
import { json } from '../../_shared/prescan-lib.js';
import { sendLoginLinkEmail } from '../../_shared/auth-lib.js';

const REMINDER_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

export async function onRequestPost(context) {
  const { request, env } = context;

  const secret = request.headers.get('X-Internal-Secret');
  if (!secret || secret !== env.INTERNAL_CRON_SECRET) {
    return json({ error: 'Unauthorized.' }, 401);
  }

  const cutoff = new Date(Date.now() - REMINDER_INTERVAL_MS).toISOString();

  // Delivered, never viewed, and either never reminded (checked against
  // delivered_at) or last reminded far enough back (checked against
  // reminder_last_sent_at) — a report only ever matches one branch at a time.
  const { results: due } = await env.DB.prepare(
    `SELECT r.id AS report_id, c.email AS customer_email
     FROM reports r
     JOIN customers c ON c.id = r.customer_id
     WHERE r.status = 'delivered' AND r.viewed_at IS NULL AND (
       (r.reminder_last_sent_at IS NULL AND r.delivered_at <= ?)
       OR (r.reminder_last_sent_at IS NOT NULL AND r.reminder_last_sent_at <= ?)
     )`
  )
    .bind(cutoff, cutoff)
    .all();

  // Sequential, awaited sends — this isn't expected to be high volume, and
  // parallelizing with Promise.all against a shared D1 connection risks racing
  // updates to the same table (even though each row here is distinct). Each row is
  // independent, so one failure shouldn't block the rest of the batch — an unsent
  // reminder just gets retried on tomorrow's run, since reminder_last_sent_at is
  // only updated on success.
  let remindersSent = 0;
  let failures = 0;
  for (const row of due) {
    try {
      await sendLoginLinkEmail(env, request, row.customer_email, {
        subject: 'Reminder — your Arli Audits report is waiting',
        intro: "Your audit report is ready and waiting for you in your portal — looks like you haven't viewed it yet.",
      });

      await env.DB.prepare(
        'UPDATE reports SET reminder_last_sent_at = ?, reminder_count = reminder_count + 1 WHERE id = ?'
      )
        .bind(new Date().toISOString(), row.report_id)
        .run();

      remindersSent++;
    } catch (e) {
      failures++;
      console.log(`[send-reminders] failed for report ${row.report_id} (${row.customer_email}): ${e}`);
    }
  }

  return json({ ok: true, reminders_sent: remindersSent, failures });
}
