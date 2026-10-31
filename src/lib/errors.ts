import { getSupabaseErrorMessage } from './supabase'

// Database error codes (raised by the Labventory functions) -> readable messages.
const CODES: Array<[RegExp, string | ((detail: string) => string)]> = [
  [/^INSUFFICIENT_QUANTITY:?\s*/, detail => `Not enough left: ${detail}`],
  [/^UNIT_MISMATCH:?\s*/, detail => `Wrong unit: ${detail}`],
  [/^UNIT_NOT_SUPPORTED/, 'Use one of these units: mg, g, kg, µL, mL or L.'],
  [/^QUANTITY_NOT_VERIFIED/, 'This bottle has no checked amount yet. The Admin must enter the counted amount before usage can be recorded.'],
  [/^QUANTITY_MUST_BE_POSITIVE/, 'Enter an amount greater than zero.'],
  [/^INVALID_QUANTITY/, 'Enter a valid amount (zero or more).'],
  [/^ACCOUNT_NOT_ACTIVE/, 'Your account is not active.'],
  [/^ADMIN_ONLY:?\s*/, detail => detail ? `Only the Admin can do this: ${detail}` : 'Only the Admin can do this.'],
  [/^NOT_YOUR_ENTRY/, 'You can only correct your own usage entries.'],
  [/^CORRECTION_WINDOW_CLOSED/, 'Researchers can correct an entry within 24 hours of recording it. Ask the Admin to correct this one.'],
  [/^REASON_REQUIRED:?\s*/, detail => `A reason is required${detail ? `: ${detail}` : '.'}`],
  [/^NOTHING_TO_CORRECT/, 'Nothing changed: the new values are the same as the current ones.'],
  [/^CORRECTION_TOO_LARGE/, 'That correction would leave more in the bottle than was ever stocked.'],
  [/^DUPLICATE_BOTTLE_ID:?\s*/, detail => `Duplicate Bottle ID: ${detail}`],
  [/^BOTTLE_ID_REQUIRED/, 'Enter a Bottle ID.'],
  [/^QUANTITY_EXCEEDS_INITIAL:?\s*/, detail => `The amount is more than the bottle can hold: ${detail}`],
  [/^INITIAL_BELOW_REMAINING:?\s*/, detail => detail],
  [/^INVALID_CAS_NUMBER:?\s*/, detail => `${detail} is not a valid CAS number (check digit failed).`],
  [/^CHEMICAL_NAME_REQUIRED/, 'Enter the chemical name.'],
  [/^STATUS_NOT_SETTABLE/, 'Low Stock and Depleted are calculated from the quantity and cannot be set by hand.'],
  [/^QUANTITY_IS_CALCULATED/, 'Remaining quantities change only through usage, corrections and stock counts.'],
  [/^DUPLICATE_OPEN_REQUEST:?\s*/, detail => detail],
  [/^INVALID_STATUS_CHANGE:?\s*/, detail => `That status change is not allowed: ${detail}`],
  [/^REQUEST_LOCKED:?\s*/, detail => `This request can no longer be edited (${detail}).`],
  [/^REQUEST_CLOSED:?\s*/, detail => `This request is closed (${detail}).`],
  [/^NOT_ORDERED_YET:?\s*/, detail => detail],
  [/^IMPORT_HAS_ERRORS:?\s*/, detail => detail],
  [/^ONLY_DESIGNATED_ADMIN_CAN_IMPORT/, 'Only the main Admin can import spreadsheets.'],
  [/^VALUE_TOO_LONG:?\s*/, detail => `Too long: ${detail}`],
  [/^INVALID_NUMBER:?\s*/, detail => `Not a number: ${detail}`],
  [/^BOTTLE_NOT_FOUND/, 'This bottle no longer exists.'],
  [/^BOTTLE_NOT_USABLE:?\s*/, detail => `This bottle cannot be used: ${detail}`],
]
export function explainCode(message: string) {
  if (/Could not find the function/.test(message)) return 'This feature is not installed in Supabase yet. Ask the Admin to apply the latest migration.'
  for (const [pattern, text] of CODES) if (pattern.test(message)) return typeof text === 'string' ? text : text(message.replace(pattern, '').trim())
  return message
}
export async function explainError(error: unknown, fallback: string) { return explainCode(await getSupabaseErrorMessage(error, fallback)) }
