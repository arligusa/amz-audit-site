// Temporary diagnostic endpoint for debugging why Access-based admin auth is
// failing — shows exactly which check in verifyAccessJwtDetailed() rejected the
// request, without needing to re-deploy for every guess. Safe to leave in place
// (it's still behind the same Access application as everything else under
// /api/admin/*, so reaching it at all already requires a passed Access login) but
// meant to be removed or at least stripped of raw debug detail once admin auth is
// confirmed working — no need to keep exposing JWKS kid lists etc. long-term.
import { json } from '../../_shared/prescan-lib.js';
import { verifyAccessJwtDetailed } from '../../_shared/admin-lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const result = await verifyAccessJwtDetailed(request, env);
  return json(result);
}
