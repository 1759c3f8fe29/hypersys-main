// ---------------------------------------------------------------------------
// Comparison Renderer — Side-by-Side Comparison Tables
// ---------------------------------------------------------------------------
//
// Renders comparison components with items and criteria. Supports
// horizontal and vertical layouts with sorting and highlighting.
//
// ---------------------------------------------------------------------------

import React, { useState, useMemo, useCallback } from "react";
import { ComparisonComponent, ComparisonItem, ComparisonCriterion } from "../../lib/interactive-types";

interface ComparisonRendererProps {
  component: ComparisonComponent;
  instanceId: string;
  className?: string;
}

export default function ComparisonRenderer({
  component,
  instanceId,
  className = "",
}: ComparisonRendererProps) {
  const { items, criteria, orientation = "horizontal" } = component;

  const [sortCriterion, setSortCriterion] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [highlightBest, setHighlightBest] = useState(true);

  // Sort items by a criterion
  const sortedItems = useMemo(() => {
    if (!sortCriterion) return items;

    const criterion = criteria.find(c => c.id === sortCriterion);
    if (!criterion) return items;

    return [...items].sort((a, b) => {
      const aVal = a.values[sortCriterion];
      const bVal = b.values[sortCriterion];

      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      let comparison = 0;
      if (criterion.type === "number") {
        comparison = Number(aVal) - Number(bVal);
      } else if (criterion.type === "rating") {
        comparison = Number(aVal) - Number(bVal);
      } else {
        comparison = String(aVal).localeCompare(String(bVal));
      }

      const direction = criterion.higherIsBetter ? sortDirection : (sortDirection === "asc" ? "desc" : "asc");
      return direction === "asc" ? comparison : -comparison;
    });
  }, [items, criteria, sortCriterion, sortDirection]);

  // Determine best value for each criterion
  const bestValues = useMemo(() => {
    const best: Record<string, unknown> = {};
    for (const criterion of criteria) {
      const values = items.map(item => item.values[criterion.id]).filter(v => v != null);
      if (values.length === 0) continue;

      if (criterion.type === "number" || criterion.type === "rating") {
        const nums = values.map(v => Number(v)).filter(n => isFinite(n));
        if (nums.length > 0) {
          best[criterion.id] = criterion.higherIsBetter ? Math.max(...nums) : Math.min(...nums);
        }
      } else if (criterion.type === "boolean" || criterion.type === "yes_no") {
        // For boolean, "best" is true if higherIsBetter, false otherwise
        best[criterion.id] = criterion.higherIsBetter ? true : false;
      }
    }
    return best;
  }, [items, criteria]);

  const formatValue = useCallback((value: unknown, criterion: ComparisonCriterion): string => {
    if (value == null) return "—";
    if (criterion.type === "number" && typeof value === "number") {
      return `${value.toLocaleString()}${criterion.unit ? ` ${criterion.unit}` : ""}`;
    }
    if (criterion.type === "rating" && typeof value === "number") {
      return "★".repeat(Math.round(value)) + "☆".repeat(5 - Math.round(value));
    }
    if (criterion.type === "boolean") {
      return value === true ? "✓ Yes" : value === false ? "✗ No" : String(value);
    }
    if (criterion.type === "yes_no") {
      return value === true || value === "yes" || value === "Yes" ? "Yes" : "No";
    }
    return String(value);
  }, []);

  const isBest = useCallback((value: unknown, criterion: ComparisonCriterion): boolean => {
    if (!highlightBest) return false;
    const best = bestValues[criterion.id];
    if (best == null) return false;
    if (criterion.type === "number" || criterion.type === "rating") {
      return Number(value) === Number(best);
    }
    return value === best;
  }, [bestValues, highlightBest]);

  // Horizontal layout (items as columns, criteria as rows)
  const renderHorizontal = () => (
    <div className="comparison-horizontal">
      <table className="comparison-table" role="grid">
        <thead>
          <tr>
            <th scope="col" className="criteria-header">Criteria</th>
            {sortedItems.map(item => (
              <th key={item.id} scope="col" className="item-header">
                <div className="item-header-content">
                  {item.image && <img src={item.image} alt="" className="item-image" />}
                  <span className="item-name">{item.name}</span>
                </div>
                {item.description && <div className="item-desc">{item.description}</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {criteria.map(criterion => (
            <tr key={criterion.id}>
              <th scope="row" className="criterion-cell">
                <div className="criterion-info">
                  <span className="criterion-label">{criterion.label}</span>
                  <span className="criterion-type">({criterion.type})</span>
                  {criteria.length > 1 && (
                    <button
                      onClick={() => {
                        setSortCriterion(prev => prev === criterion.id ? null : criterion.id);
                        setSortDirection(prev => prev === "asc" ? "desc" : "asc");
                      }}
                      className="sort-criterion-btn"
                      aria-label={`Sort by ${criterion.label}`}
                      aria-pressed={sortCriterion === criterion.id}
                    >
                      {sortCriterion === criterion.id ? (sortDirection === "asc" ? "↑" : "↓") : "⇅"}
                    </button>
                  )}
                </div>
              </th>
              {sortedItems.map(item => {
                const value = item.values[criterion.id];
                const best = isBest(value, criterion);
                return (
                  <td key={item.id} className={`value-cell ${best ? "best" : ""}`}>
                    <span className="cell-value">{formatValue(value, criterion)}</span>
                    {best && <span className="best-badge" aria-label="Best in this category">✦</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // Vertical layout (items as rows, criteria as columns)
  const renderVertical = () => (
    <div className="comparison-vertical">
      <table className="comparison-table" role="grid">
        <thead>
          <tr>
            <th scope="col" className="item-col-header">Item</th>
            {criteria.map(criterion => (
              <th key={criterion.id} scope="col" className="criterion-col-header">
                <div className="criterion-col-info">
                  <span>{criterion.label}</span>
                  <span className="criterion-col-type">({criterion.type})</span>
                  <button
                    onClick={() => {
                      setSortCriterion(prev => prev === criterion.id ? null : criterion.id);
                      setSortDirection(prev => prev === "asc" ? "desc" : "asc");
                    }}
                    className="sort-criterion-btn"
                    aria-label={`Sort by ${criterion.label}`}
                    aria-pressed={sortCriterion === criterion.id}
                  >
                    {sortCriterion === criterion.id ? (sortDirection === "asc" ? "↑" : "↓") : "⇅"}
                  </button>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedItems.map(item => (
            <tr key={item.id}>
              <th scope="row" className="item-row-header">
                {item.image && <img src={item.image} alt="" className="item-image-small" />}
                <span>{item.name}</span>
              </th>
              {criteria.map(criterion => {
                const value = item.values[criterion.id];
                const best = isBest(value, criterion);
                return (
                  <td key={criterion.id} className={`value-cell ${best ? "best" : ""}`}>
                    <span className="cell-value">{formatValue(value, criterion)}</span>
                    {best && <span className="best-badge" aria-label="Best in this category">✦</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // Card layout for mobile/small screens
  const renderCards = () => (
    <div className="comparison-cards" role="list">
      {sortedItems.map(item => (
        <article key={item.id} className="comparison-card" role="listitem">
          <header className="card-header">
            {item.image && <img src={item.image} alt="" className="card-image" />}
            <h4 className="card-title">{item.name}</h4>
            {item.description && <p className="card-desc">{item.description}</p>}
          </header>
          <div className="card-criteria">
            {criteria.map(criterion => {
              const value = item.values[criterion.id];
              const best = isBest(value, criterion);
              return (
                <div key={criterion.id} className={`card-criterion ${best ? "best" : ""}`}>
                  <span className="card-criterion-label">{criterion.label}</span>
                  <span className="card-criterion-value">{formatValue(value, criterion)}</span>
                  {best && <span className="best-badge" aria-label="Best">✦</span>}
                </div>
              );
            })}
          </div>
        </article>
      ))}
    </div>
  );

  return (
    <div className={`comparison-renderer ${className}`} data-instance-id={instanceId}>
      <div className="comparison-header">
        <h3 className="comparison-title">{component.title}</h3>
        {component.description && <p className="comparison-description">{component.description}</p>}

        <div className="comparison-controls">
          <label>
            <input
              type="checkbox"
              checked={highlightBest}
              onChange={(e) => setHighlightBest(e.target.checked)}
            />
            Highlight best values
          </label>
          <label htmlFor={`${instanceId}-layout`} className="visually-hidden">Layout</label>
          <select
            id={`${instanceId}-layout`}
            value={orientation}
            onChange={(e) => {}}
            className="layout-select"
            disabled
          >
            <option value="horizontal">Horizontal</option>
            <option value="vertical">Vertical</option>
            <option value="cards">Cards</option>
          </select>
        </div>
      </div>

      <div className="comparison-layout-toggle" role="tablist" aria-label="Layout">
        <button
          role="tab"
          aria-selected={orientation === "horizontal"}
          onClick={() => {}}
          className={orientation === "horizontal" ? "active" : ""}
        >
          Horizontal
        </button>
        <button
          role="tab"
          aria-selected={orientation === "vertical"}
          onClick={() => {}}
          className={orientation === "vertical" ? "active" : ""}
        >
          Vertical
        </button>
        <button
          role="tab"
          aria-selected={false}
          onClick={() => {}}
          className=""
        >
          Cards
        </button>
      </div>

      <div className="comparison-content">
        {orientation === "horizontal" ? renderHorizontal() : renderVertical()}
      </div>

      <details className="comparison-legend">
        <summary>Legend</summary>
        <div className="legend-items">
          <div className="legend-item">
            <span className="legend-badge best" aria-hidden="true">✦</span>
            <span>Best value in column (when highlighting enabled)</span>
          </div>
          <div className="legend-item">
            <span className="legend-badge sort" aria-hidden="true">⇅</span>
            <span>Click to sort by this criterion</span>
          </div>
          {criteria.some(c => c.higherIsBetter) && (
            <div className="legend-item">
              <span>▲</span>
              <span>Higher is better for this criterion</span>
            </div>
          )}
          {criteria.some(c => c.higherIsBetter === false) && (
            <div className="legend-item">
              <span>▼</span>
              <span>Lower is better for this criterion</span>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}