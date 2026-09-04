import { json } from '../../../../_shared/prescan-lib.js';
import { requireAdmin, adminUnauthorized } from '../../../../_shared/admin-lib.js';

// Maps the `?kind=` query param to the reports column that holds the R2 key for
// that customer-uploaded intake file. Only these two kinds exist — see
// functions/_shared/upload-lib.js UPLOAD_KINDS.
const KIND_COLUMNS = {
  str: 'str_report_r2_key',
  biz: 'biz_report_r2_key',
};

// Customer intake uploads are always real Amazon report exports — csv/xlsx/xls,
// enforced at upload time by functions/_shared/upload-lib.js ALLOWED_EXTENSIONS —
// never arbitrary files, so this is an exhaustive map, not a guess.
const EXT_CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
};

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const adminEmail = await requireAdmin(request, env);
  if (!adminEmail) return adminUnauthorized();

  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const column = KIND_COLUMNS[kind];
  if (!column) return json({ error: 'Invalid kind — must be "str" or "biz".' }, 400);

  // column is selected from the fixed KIND_COLUMNS map above (never from raw
  // user input), so interpolating it into the query text is safe.
  const report = await env.DB.prepare(`SELECT id, ${column} AS r2_key FROM reports WHERE id = ?`)
    .bind(params.id)
    .first();

  if (!report || !report.r2_key) {
    return json({ error: 'Intake file not found.' }, 404);
  }

  const object = await env.UPLOADS_BUCKET.get(report.r2_key);
  if (!object) return json({ error: 'Intake file is missing — please contact support.' }, 500);

  // The R2 key itself carries the original extension (see uploadKey() in
  // upload-lib.js: `${scope}/${id}/${kind}-${Date.now()}.${ext}`); prefer the
  // content-type captured at upload time and fall back to a guess from that
  // extension, then to a generic binary type.
  const ext = (report.r2_key.split('.').pop() || '').toLowerCase();
  const contentType = object.httpMetadata?.contentType || EXT_CONTENT_TYPES[ext] || 'application/octet-stream';
  const filename = `intake-${kind}-${report.id}${ext ? `.${ext}` : ''}`;

  return new Response(object.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${filename}"`,
    },
  });
}
