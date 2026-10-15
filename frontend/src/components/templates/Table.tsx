import { DataTable, type Col } from '../ccTable'
import { cellSortKey, cellText, isNumericColumn, safeHref, type Cell, type TableProps } from '../../templateSpec'

type Row = Record<string, Cell>

/** A sortable table: `DataTable` with columns built from plain JSON. */
export function Table({ columns, rows, rowKey, hrefKey, initialSort, empty }: TableProps) {
  const cols: Col<Row>[] = columns.map((c) => {
    const numeric = isNumericColumn(c, rows)
    return {
      key: c.key,
      label: c.label,
      numeric,
      render: (r) => cellText(r[c.key]),
      sort: c.sortable ? (r) => cellSortKey(r[c.key], numeric) : undefined,
    }
  })
  const first = columns.find((c) => c.sortable) ?? columns[0]
  const sortKey = initialSort && columns.some((c) => c.key === initialSort.key) ? initialSort.key : first.key
  return (
    <DataTable
      rows={rows}
      cols={cols}
      initialKey={sortKey}
      initialDir={initialSort?.dir ?? 'desc'}
      empty={empty ?? 'Nothing to show.'}
      rowKey={(r) => (rowKey ? cellText(r[rowKey]) : JSON.stringify(r))}
      rowHref={hrefKey ? (r) => safeHref(r[hrefKey]) ?? '' : undefined}
    />
  )
}
