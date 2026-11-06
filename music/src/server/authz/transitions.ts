// State transitions are conditional UPDATEs (plan §3.3): the WHERE clause
// carries the expected current status (`... AND status = 'pending'`), so of
// two racing reviewers exactly one wins; the loser gets 0 rows → 409.

import { conflict } from '../http/errors'

export function oneOrConflict<T>(rows: readonly T[], code = 'state_changed'): T {
  if (rows.length !== 1) throw conflict(code)
  return rows[0]!
}
