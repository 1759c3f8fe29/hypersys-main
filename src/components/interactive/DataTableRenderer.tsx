// ---------------------------------------------------------------------------
// Data Table Renderer — Sortable, Filterable, Paginated Tables
// ---------------------------------------------------------------------------
//
// Renders data table components with full interactivity: sorting,
// filtering, pagination, and column visibility controls.
//
// ---------------------------------------------------------------------------

import React, { useState, useMemo, useCallback } from "react";
import { DataTableComponent, DataTableColumn } from "../../lib/interactive-types";

interface DataTableRendererProps {
  component: DataTableComponent;
  instanceId: string;
  className?: string;
}

type SortDirection = "asc" | "desc" | null;

interface SortState {
  column: string;
  direction: SortDirection;
}

export default function DataTableRenderer({ component, instanceId, className = "" }: DataTableRendererProps) {
  const { columns, rows, sortable = true, filterable = true, paginated = true, pageSize = 25, defaultSort } = component;

  const [sort, setSort] = useState<SortState>(() => ({
    column: defaultSort?.column || "",
    direction: defaultSort?.direction || null,
  }));
  const [filter, setFilter] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    () => new Set(columns.filter(c => c.visible !== false).map(c => c.key))
  );

  // Toggle column visibility
  const toggleColumn = useCallback((key: string) => {
    setVisibleColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Handle sorting
  const handleSort = useCallback((columnKey: string) => {
    if (!sortable) return;
    setSort(prev => {
      if (prev.column === columnKey) {
        if (prev.direction === "asc") return { column: columnKey, direction: "desc" };
        if (prev.direction === "desc") return { column: columnKey, direction: null };
        return { column: columnKey, direction: "asc" };
      }
      return { column: columnKey, direction: "asc" };
    });
  }, [sortable]);

  // Filter rows
  const filteredRows = useMemo(() => {
    if (!filter.trim()) return rows;
    const lowerFilter = filter.toLowerCase();
    return rows.filter(row =>
      Object.values(row).some(val =>
        String(val).toLowerCase().includes(lowerFilter)
      )
    );
  }, [rows, filter]);

  // Sort rows
  const sortedRows = useMemo(() => {
    if (!sort.column || !sort.direction) return filteredRows;

    const col = columns.find(c => c.key === sort.column);
    const type = col?.type || "string";

    return [...filteredRows].sort((a, b) => {
      const aVal = a[sort.column];
      const bVal = b[sort.column];

      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      let comparison = 0;
      if (type === "number") {
        comparison = Number(aVal) - Number(bVal);
      } else if (type === "date") {
        comparison = new Date(String(aVal)).getTime() - new Date(String(bVal)).getTime();
      } else if (type === "boolean") {
        comparison = String(aVal).localeCompare(String(bVal));
      } else {
        comparison = String(aVal).localeCompare(String(bVal));
      }

      return sort.direction === "asc" ? comparison : -comparison;
    });
  }, [filteredRows, sort, columns]);

  // Paginate
  const paginatedRows = useMemo(() => {
    if (!paginated) return sortedRows;
    const start = (currentPage - 1) * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [sortedRows, paginated, pageSize, currentPage]);

  const totalPages = Math.ceil(sortedRows.length / pageSize) || 1;

  // Format cell value
  const formatValue = useCallback((value: unknown, column: DataTableColumn): string => {
    if (value == null) return "—";
    if (column.format) {
      // Could look up format function from registry
      return String(value);
    }
    if (column.type === "number" && typeof value === "number") {
      return value.toLocaleString();
    }
    if (column.type === "date") {
      return new Date(String(value)).toLocaleDateString();
    }
    if (column.type === "boolean") {
      return value === true ? "✓" : value === false ? "✗" : String(value);
    }
    return String(value);
  }, []);

  // Get visible columns in order
  const displayColumns = useMemo(() =>
    columns.filter(c => visibleColumns.has(c.key)),
    [columns, visibleColumns]
  );

  if (rows.length === 0) {
    return (
      <div className={`data-table-renderer ${className}`} data-instance-id={instanceId}>
        <div className="data-table-header">
          <h3 className="data-table-title">{component.title}</h3>
          {component.description && <p className="data-table-description">{component.description}</p>}
        </div>
        <div className="data-table-empty">No data available</div>
      </div>
    );
  }

  return (
    <div className={`data-table-renderer ${className}`} data-instance-id={instanceId}>
      <div className="data-table-header">
        <h3 className="data-table-title">{component.title}</h3>
        {component.description && <p className="data-table-description">{component.description}</p>}
      </div>

      <div className="data-table-toolbar">
        {filterable && (
          <div className="toolbar-item">
            <label htmlFor={`${instanceId}-filter`} className="visually-hidden">Filter table</label>
            <input
              id={`${instanceId}-filter`}
              type="search"
              className="toolbar-input"
              placeholder="Filter rows..."
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setCurrentPage(1);
              }}
              aria-label="Filter table rows"
            />
          </div>
        )}

        <div className="toolbar-item">
          <label htmlFor={`${instanceId}-columns`} className="visually-hidden">Column visibility</label>
          <select
            id={`${instanceId}-columns`}
            className="toolbar-select"
            multiple
            value={Array.from(visibleColumns)}
            onChange={(e) => {
              const selected = Array.from(e.target.selectedOptions).map(o => o.value);
              setVisibleColumns(new Set(selected));
            }}
            aria-label="Toggle column visibility"
          >
            {columns.map(col => (
              <option key={col.key} value={col.key} selected={visibleColumns.has(col.key)}>
                {col.header}
              </option>
            ))}
          </select>
        </div>

        <div className="toolbar-info">
          {filteredRows.length !== rows.length
            ? `Showing ${paginatedRows.length} of ${filteredRows.length} filtered rows (${rows.length} total)`
            : `Showing ${paginatedRows.length} of ${rows.length} rows`}
        </div>
      </div>

      <div className="data-table-wrapper">
        <table className="data-table" role="grid">
          <thead>
            <tr>
              {displayColumns.map(col => (
                <th
                  key={col.key}
                  scope="col"
                  className={sortable ? "sortable" : ""}
                  onClick={() => handleSort(col.key)}
                  style={{ width: col.width }}
                  aria-sort={
                    sort.column === col.key
                      ? sort.direction === "asc" ? "ascending" : "descending"
                      : "none"
                  }
                >
                  <div className="th-content">
                    <span>{col.header}</span>
                    {sortable && (
                      <span className="sort-indicator" aria-hidden="true">
                        {sort.column === col.key
                          ? sort.direction === "asc"
                            ? "▲"
                            : "▼"
                          : "⇅"}
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paginatedRows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {displayColumns.map(col => (
                  <td key={col.key}>
                    {formatValue(row[col.key], col)}
                  </td>
                ))}
              </tr>
            ))}
            {paginatedRows.length === 0 && (
              <tr>
                <td colSpan={displayColumns.length} className="no-results">
                  No matching rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {paginated && totalPages > 1 && (
        <div className="data-table-pagination" role="navigation" aria-label="Pagination">
          <button
            className="page-btn"
            onClick={() => setCurrentPage(1)}
            disabled={currentPage === 1}
            aria-label="First page"
          >
            ««
          </button>
          <button
            className="page-btn"
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            aria-label="Previous page"
          >
            «
          </button>

          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter(page => {
              if (totalPages <= 7) return true;
              if (page <= 2) return true;
              if (page >= totalPages - 1) return true;
              if (page >= currentPage - 1 && page <= currentPage + 1) return true;
              return false;
            })
            .map((page, idx, arr) => {
              const prevPage = arr[idx - 1];
              const showEllipsis = prevPage !== undefined && page - prevPage > 1;
              return (
                <React.Fragment key={page}>
                  {showEllipsis && <span className="page-ellipsis" aria-hidden="true">…</span>}
                  <button
                    className={`page-btn page-number ${currentPage === page ? "active" : ""}`}
                    onClick={() => setCurrentPage(page)}
                    aria-label={`Page ${page}`}
                    aria-current={currentPage === page ? "page" : undefined}
                  >
                    {page}
                  </button>
                </React.Fragment>
              );
            })}

          <button
            className="page-btn"
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            aria-label="Next page"
          >
            »
          </button>
          <button
            className="page-btn"
            onClick={() => setCurrentPage(totalPages)}
            disabled={currentPage === totalPages}
            aria-label="Last page"
          >
            »»
          </button>
        </div>
      )}
    </div>
  );
}