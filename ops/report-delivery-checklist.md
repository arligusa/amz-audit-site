# Report delivery — manual checklist

Nothing in the codebase automatically transitions a report's `status` or `rewrite_status` —
delivery is a manual step today, by design (low presale volume doesn't justify building an
ops flow yet; revisit once volume actually calls for it). This is the reference for doing
it correctly so the portal reflects reality.

Database: `arli-intake-db` (D1). Bucket: `arli-reports` (R2).

## 1. Delivering an audit report

Once the PDF is ready:

1. Upload the PDF to the `arli-reports` R2 bucket (Cloudflare dashboard drag-and-drop, or
   ask C-Code to do it directly if you hand over the file). Note the object key you gave it
   — convention so far has been `<report_id>.pdf`, but any key works as long as it matches
   what you put in `r2_key` below.
2. Run against `arli-intake-db`:
   ```sql
   UPDATE reports
   SET status = 'delivered',
       r2_key = '<the R2 object key>',
       delivered_at = '<current UTC ISO timestamp>',
       updated_at = '<current UTC ISO timestamp>'
   WHERE id = '<report id>';
   ```
3. That's it — the customer will see "Delivered" and a download link next time they load
   `/portal.html`. If the report's `audit_type` is `listing` or `both`, they'll also see the
   "Rewrite my listing — $79" offer automatically (no extra step needed for that part —
   eligibility is derived live from `status`/`audit_type`/`rewrite_status`, not a separate
   flag you have to set).

### Marking "in progress" (optional, cosmetic only)

If you want the portal to show "In progress" instead of "In queue" while you're working on
it, before delivery:
```sql
UPDATE reports SET status = 'in_progress', updated_at = '<now>' WHERE id = '<report id>';
```
Not required — nothing depends on this transition happening.

## 2. The "Rewrite my listing" upsell

The offer itself needs no manual step — it appears automatically once a Listing/Both
report is `delivered` and `rewrite_status` is still the default `not_offered`. What you do
need to update by hand, at each stage of an actual rewrite order:

**When the customer purchases** (you'll see the Shopify order — it'll have `Order Type:
Listing Rewrite` and the `Report ID` in its custom attributes/note, same traceability
pattern as audit orders):
```sql
UPDATE reports
SET rewrite_status = 'purchased',
    rewrite_order_id = '<Shopify order id or name>',
    updated_at = '<now>'
WHERE id = '<report id>';
```

**When you start the rewrite** (optional, cosmetic — shows "Rewrite in progress" pill):
```sql
UPDATE reports SET rewrite_status = 'in_progress', updated_at = '<now>' WHERE id = '<report id>';
```

**When the rewrite is done:**
1. Upload the rewrite doc/PDF to the `arli-reports` R2 bucket, same as an audit report.
2. Run:
   ```sql
   UPDATE reports
   SET rewrite_status = 'delivered',
       rewrite_r2_key = '<the R2 object key>',
       rewrite_delivered_at = '<current UTC ISO timestamp>',
       updated_at = '<current UTC ISO timestamp>'
   WHERE id = '<report id>';
   ```
3. Customer sees a "Download rewrite" link on their next portal visit.

## Not built yet (by design, revisit if volume justifies it)

- No email notification when a report or rewrite is delivered — customers only see it if
  they check the portal. Tell them separately for now, same as however you already
  communicate audit delivery today.
- No automated "mark delivered" endpoint/admin UI — everything above is by hand via D1.
