// Fires once daily. Cloudflare Pages Functions have no native Cron Trigger support
// (confirmed against Cloudflare's own docs — scheduled() handlers are a Workers-only
// capability), so this tiny standalone Worker exists purely to wake up the Pages
// project's internal reminder-scan endpoint on a schedule. All the actual logic (who's
// overdue, sending email) lives there — see functions/api/internal/send-reminders.js
// in the main site — not here.
export default {
  async scheduled(controller, env, ctx) {
    const resp = await fetch('https://arli.arligusa.com/api/internal/send-reminders', {
      method: 'POST',
      headers: { 'X-Internal-Secret': env.INTERNAL_CRON_SECRET },
    });
    const body = await resp.text();
    console.log(`send-reminders: ${resp.status} ${body}`);
  },
};
