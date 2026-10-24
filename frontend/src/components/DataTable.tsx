import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type Row,
  type RowData,
  type SortingState,
} from '@tanstack/react-table'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import ReactPaginateImport from 'react-paginate'
import { Bar } from './table'

declare module '@tanstack/react-table' {
  interface ColumnMeta<TData extends RowData, TValue> {
    width?: string
    className?: string
    skeletonWidth?: number
    label?: string
  }
}

const ReactPaginate =
  (ReactPaginateImport as unknown as { default?: typeof ReactPaginateImport }).default ?? ReactPaginateImport

interface DataTableProps<T> {
  columns: ColumnDef<T>[]
  data: T[]
  sorting?: SortingState
  onSortingChange?: OnChangeFn<SortingState>
  loading?: boolean
  skeletonRows?: number
  emptyMessage?: string
  onRowClick?: (item: T) => void
  rowAriaLabel?: (item: T) => string
  rowClassName?: (item: T) => string
  getRowId?: (item: T, index: number) => string
  footer?: ReactNode
  pagination?: { pageCount: number; page: number; onPageChange: (page: number) => void }
}

function headerLabel<T>(col: ColumnDef<T>): string {
  if (col.meta?.label !== undefined) return col.meta.label
  return typeof col.header === 'string' ? col.header : ''
}

export function DataTable<T>({
  columns,
  data,
  sorting,
  onSortingChange,
  loading,
  skeletonRows = 8,
  emptyMessage,
  onRowClick,
  rowAriaLabel,
  rowClassName,
  getRowId,
  footer,
  pagination,
}: DataTableProps<T>) {
  const table = useReactTable({
    data,
    columns,
    state: { sorting: sorting ?? [] },
    onSortingChange,
    manualSorting: true,
    enableSorting: !!onSortingChange,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
  })

  const fixed = columns.some((c) => c.meta?.width)
  const tableClass = `data-table${fixed ? ' fixed' : ''}`

  const rowProps = (row: Row<T>) =>
    onRowClick
      ? {
          onClick: () => onRowClick(row.original),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') onRowClick(row.original)
          },
          tabIndex: 0,
          role: 'link',
          'aria-label': rowAriaLabel?.(row.original),
        }
      : {}

  return (
    <>
      <div className="card table-wrap">
        {loading ? (
          <table className={tableClass}>
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <th key={i} className={c.meta?.className} style={c.meta?.width ? { width: c.meta.width } : undefined}>
                    {headerLabel(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: skeletonRows }).map((_, r) => (
                <tr key={r}>
                  {columns.map((c, i) => (
                    <td key={i} className={c.meta?.className}>
                      {headerLabel(c) === '' && c.meta?.skeletonWidth === undefined ? null : (
                        <Bar w={c.meta?.skeletonWidth ?? 90} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className={tableClass}>
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className={header.column.columnDef.meta?.className}
                      style={header.column.columnDef.meta?.width ? { width: header.column.columnDef.meta.width } : undefined}
                    >
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={[onRowClick ? 'clickable' : '', rowClassName?.(row.original) ?? ''].filter(Boolean).join(' ') || undefined}
                  {...rowProps(row)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className={cell.column.columnDef.meta?.className}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
              {emptyMessage && data.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="muted">
                    {emptyMessage}
                  </td>
                </tr>
              )}
            </tbody>
            {footer && <tfoot>{footer}</tfoot>}
          </table>
        )}
      </div>
      {pagination && pagination.pageCount > 1 && (
        <ReactPaginate
          pageCount={pagination.pageCount}
          forcePage={pagination.page - 1}
          onPageChange={({ selected }) => pagination.onPageChange(selected + 1)}
          previousLabel={<ChevronLeft size={16} />}
          nextLabel={<ChevronRight size={16} />}
          breakLabel="…"
          containerClassName="pagination"
          activeClassName="active"
          disabledClassName="disabled"
          breakClassName="break"
          marginPagesDisplayed={1}
          pageRangeDisplayed={3}
        />
      )}
    </>
  )
}
