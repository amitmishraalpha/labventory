// Canonical units used by the database (labventory_unit / labventory_factor).
export const UNIT_FACTOR: Record<string, number> = { 'µg': 1e-6, mg: 1e-3, g: 1, kg: 1e3, 'µL': 1e-3, mL: 1, L: 1e3 }
const MASS = ['µg', 'mg', 'g', 'kg'], VOLUME = ['µL', 'mL', 'L']
export const dimension = (unit: string | null | undefined) => (unit && MASS.includes(unit) ? 'mass' : unit && VOLUME.includes(unit) ? 'volume' : null)
export const unitsLike = (unit: string | null | undefined) => (dimension(unit) === 'mass' ? MASS.filter(u => u !== 'µg') : dimension(unit) === 'volume' ? VOLUME : unit ? [unit] : [])

/** amount expressed in `to`, or NaN when the units are not comparable (mass vs volume, unknown). */
export function convert(amount: number, from: string | null | undefined, to: string | null | undefined) {
  if (!from || !to || dimension(from) === null || dimension(from) !== dimension(to)) return NaN
  return amount * UNIT_FACTOR[from] / UNIT_FACTOR[to]
}
