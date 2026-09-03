// Shared validation for customer-submitted report files (Search Term Report,
// Business Report). These are real Amazon report exports, not arbitrary user
// uploads, but still get a size/extension/magic-byte check before landing in R2 —
// same standard applied to file uploads on the itinfusions-expenses project.

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB — plenty for a CSV/XLSX report export
const ALLOWED_EXTENSIONS = ['csv', 'xlsx', 'xls'];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04" — xlsx/xls(new) are zip containers

export const UPLOAD_KINDS = ['str_report', 'biz_report'];

export function extOf(filename) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

// Returns { ext } on success or { error } on failure. Reads only the first 4 bytes
// for the magic-byte check, so this is cheap even for a multi-MB file.
export async function validateUpload(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    return { error: 'No file was received — please choose a file and try again.' };
  }
  if (file.size === 0) {
    return { error: 'That file is empty.' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: 'That file is too large (15MB max) — double check it\'s the report export, not something else.' };
  }
  const ext = extOf(file.name);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { error: "Please upload a .csv, .xlsx, or .xls file — that's the format Amazon exports these reports in." };
  }
  if (ext === 'xlsx' || ext === 'xls') {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isZip = ZIP_MAGIC.every((b, i) => head[i] === b);
    if (!isZip) {
      return { error: "That file doesn't look like a real Excel export — please re-download it from Amazon and try again." };
    }
  }
  return { ext };
}

export function uploadKey(scope, id, kind, ext) {
  return `${scope}/${id}/${kind}-${Date.now()}.${ext}`;
}
