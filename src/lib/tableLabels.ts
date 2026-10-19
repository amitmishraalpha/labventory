// On phones, tables with class "cards" are shown as stacked cards (see mobile.css). Each cell
// needs its column name as data-label; this keeps that in sync with the header for every
// such table as React renders and re-renders rows.
export function startTableLabels() {
  const apply = () => {
    document.querySelectorAll('table.cards').forEach(table => {
      const heads = [...table.querySelectorAll(':scope > thead > tr > th')].map(th => th.textContent?.trim() ?? '')
      table.querySelectorAll(':scope > tbody > tr').forEach(row => {
        ;[...row.children].forEach((cell, index) => {
          const label = (cell as HTMLTableCellElement).colSpan > 1 ? '' : heads[index] ?? ''
          if (cell.getAttribute('data-label') !== label) cell.setAttribute('data-label', label)
        })
      })
    })
  }
  let scheduled = false
  // Only childList changes are observed, so setting attributes here cannot loop.
  new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; apply() }) } }).observe(document.body, { childList: true, subtree: true })
  apply()
}
