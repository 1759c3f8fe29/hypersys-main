// ---------------------------------------------------------------------------
// Planner Renderer — Task Timelines, Schedules, Budgets, and Projects
// ---------------------------------------------------------------------------
//
// Renders planner components with multiple modes: timeline, schedule,
// budget, and tasks. Interactive with completion toggles.
//
// ---------------------------------------------------------------------------

import React, { useState, useMemo, useCallback } from "react";
import { PlannerComponent, PlannerItem } from "../../lib/interactive-types";

interface PlannerRendererProps {
  component: PlannerComponent;
  instanceId: string;
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
  className?: string;
}

export default function PlannerRenderer({
  component,
  instanceId,
  onUpdate,
  className = "",
}: PlannerRendererProps) {
  const [items, setItems] = useState<PlannerItem[]>(component.items || []);
  const [mode, setMode] = useState(component.mode);
  const [totalBudget, setTotalBudget] = useState(component.totalBudget || 0);
  const currency = component.currency || "$";

  const handleItemUpdate = useCallback((id: string, updates: Partial<PlannerItem>) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item));
    const updated = items.map(item => item.id === id ? { ...item, ...updates } : item);
    onUpdate?.(instanceId, { items: updated, mode, totalBudget });
  }, [instanceId, onUpdate, items, mode, totalBudget]);

  const handleItemComplete = useCallback((id: string, completed: boolean) => {
    handleItemUpdate(id, { completed });
  }, [handleItemUpdate]);

  const handleAddItem = useCallback(() => {
    const newItem: PlannerItem = {
      id: `item-${Date.now()}`,
      name: "New item",
      value: 0,
      completed: false,
    };
    const updated = [...items, newItem];
    setItems(updated);
    onUpdate?.(instanceId, { items: updated, mode, totalBudget });
  }, [instanceId, onUpdate, items, mode, totalBudget]);

  const handleRemoveItem = useCallback((id: string) => {
    const updated = items.filter(item => item.id !== id);
    setItems(updated);
    onUpdate?.(instanceId, { items: updated, mode, totalBudget });
  }, [instanceId, onUpdate, items, mode, totalBudget]);

  const handleModeChange = useCallback((newMode: PlannerComponent["mode"]) => {
    setMode(newMode);
    onUpdate?.(instanceId, { items, mode: newMode, totalBudget });
  }, [instanceId, onUpdate, items, totalBudget]);

  const handleBudgetChange = useCallback((budget: number) => {
    setTotalBudget(Math.max(0, budget));
    onUpdate?.(instanceId, { items, mode, totalBudget: Math.max(0, budget) });
  }, [instanceId, onUpdate, items, mode]);

  // Computed values
  const computed = useMemo(() => {
    const total = items.reduce((sum, item) => sum + (item.value || 0), 0);
    const completed = items.filter(item => item.completed).length;
    const remaining = items.length - completed;

    if (mode === "budget") {
      return {
        total,
        completed,
        remaining,
        budgetUsed: totalBudget > 0 ? (total / totalBudget) * 100 : 0,
        budgetRemaining: totalBudget - total,
        overBudget: total > totalBudget,
      };
    }

    if (mode === "timeline" || mode === "schedule") {
      const datedItems = items.filter(item => item.startDate || item.endDate);
      return { total, completed, remaining, datedItems: datedItems.length };
    }

    return { total, completed, remaining };
  }, [items, mode, totalBudget]);

  const formatCurrency = (val: number) => `${currency}${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Mode-specific rendering
  const renderTasksMode = () => (
    <div className="planner-tasks">
      <div className="planner-summary">
        <span>{computed.completed} of {items.length} completed</span>
        <span>Total: {computed.total}</span>
      </div>
      <ul className="task-list">
        {items.map(item => (
          <li key={item.id} className="task-item">
            <label className="task-checkbox">
              <input
                type="checkbox"
                checked={item.completed}
                onChange={(e) => handleItemComplete(item.id, e.target.checked)}
              />
              <span className="checkmark" />
            </label>
            <input
              type="text"
              value={item.name}
              onChange={(e) => handleItemUpdate(item.id, { name: e.target.value })}
              className="task-name"
              placeholder="Task name"
            />
            <input
              type="number"
              step="any"
              value={item.value}
              onChange={(e) => handleItemUpdate(item.id, { value: parseFloat(e.target.value) || 0 })}
              className="task-value"
              placeholder="Value"
              aria-label="Value"
            />
            <select
              value={item.category || ""}
              onChange={(e) => handleItemUpdate(item.id, { category: e.target.value })}
              className="task-category"
              aria-label="Category"
            >
              <option value="">Category</option>
              {["Work", "Personal", "Shopping", "Health", "Learning"].map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            <button
              onClick={() => handleRemoveItem(item.id)}
              className="task-delete"
              aria-label={`Delete ${item.name}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button onClick={handleAddItem} className="add-task-btn">+ Add Task</button>
    </div>
  );

  const renderBudgetMode = () => (
    <div className="planner-budget">
      <div className="budget-header">
        <div className="budget-input">
          <label htmlFor={`${instanceId}-budget`}>Total Budget</label>
          <div className="input-with-symbol">
            <span className="currency-symbol">{currency}</span>
            <input
              id={`${instanceId}-budget`}
              type="number"
              step="0.01"
              min="0"
              value={totalBudget}
              onChange={(e) => handleBudgetChange(parseFloat(e.target.value) || 0)}
            />
          </div>
        </div>
        <div className={`budget-status ${computed.overBudget ? "over" : ""}`}>
          <div className="budget-bar">
            <div
              className="budget-fill"
              style={{ width: `${Math.min(100, computed.budgetUsed)}%` }}
            />
          </div>
          <div className="budget-labels">
            <span>Used: {formatCurrency(computed.total)}</span>
            <span>Remaining: {formatCurrency(Math.max(0, computed.budgetRemaining))}</span>
          </div>
        </div>
      </div>
      <ul className="budget-items">
        {items.map(item => (
          <li key={item.id} className="budget-item">
            <input
              type="text"
              value={item.name}
              onChange={(e) => handleItemUpdate(item.id, { name: e.target.value })}
              className="item-name"
              placeholder="Item name"
            />
            <div className="input-with-symbol">
              <span className="currency-symbol">{currency}</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={item.value}
                onChange={(e) => handleItemUpdate(item.id, { value: parseFloat(e.target.value) || 0 })}
                className="item-value"
              />
            </div>
            <button
              onClick={() => handleRemoveItem(item.id)}
              className="item-delete"
              aria-label={`Delete ${item.name}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button onClick={handleAddItem} className="add-item-btn">+ Add Item</button>
    </div>
  );

  const renderTimelineMode = () => (
    <div className="planner-timeline">
      <div className="timeline-header">
        <div className="timeline-dates">
          <label>
            Start: <input type="date" value={component.startDate || ""} onChange={(e) => onUpdate?.(instanceId, { items, mode, totalBudget, startDate: e.target.value })} />
          </label>
          <label>
            End: <input type="date" value={component.endDate || ""} onChange={(e) => onUpdate?.(instanceId, { items, mode, totalBudget, endDate: e.target.value })} />
          </label>
        </div>
      </div>
      <div className="timeline-items">
        {items
          .filter(item => item.startDate || item.endDate)
          .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""))
          .map(item => (
            <div key={item.id} className="timeline-item">
              <div className="timeline-marker" />
              <div className="timeline-content">
                <div className="timeline-item-header">
                  <input
                    type="text"
                    value={item.name}
                    onChange={(e) => handleItemUpdate(item.id, { name: e.target.value })}
                    className="timeline-name"
                  />
                  <span className="timeline-dates">
                    {item.startDate && <span>Start: {item.startDate}</span>}
                    {item.endDate && <span>End: {item.endDate}</span>}
                  </span>
                </div>
                {item.dependencies?.length && (
                  <div className="timeline-deps">
                    Depends on: {item.dependencies.join(", ")}
                  </div>
                )}
              </div>
            </div>
          ))}
        {computed.datedItems === 0 && (
          <p className="timeline-empty">Add start/end dates to items to see them on the timeline.</p>
        )}
      </div>
      <details className="timeline-task-list">
        <summary>All Items ({items.length})</summary>
        <ul>
          {items.map(item => (
            <li key={item.id}>
              <input
                type="checkbox"
                checked={item.completed}
                onChange={(e) => handleItemComplete(item.id, e.target.checked)}
              />
              <input
                type="text"
                value={item.name}
                onChange={(e) => handleItemUpdate(item.id, { name: e.target.value })}
              />
              <input
                type="date"
                value={item.startDate || ""}
                onChange={(e) => handleItemUpdate(item.id, { startDate: e.target.value })}
              />
              <input
                type="date"
                value={item.endDate || ""}
                onChange={(e) => handleItemUpdate(item.id, { endDate: e.target.value })}
              />
              <button onClick={() => handleRemoveItem(item.id)}>×</button>
            </li>
          ))}
        </ul>
        <button onClick={handleAddItem}>+ Add Item</button>
      </details>
    </div>
  );

  const renderScheduleMode = () => (
    <div className="planner-schedule">
      <p className="schedule-info">Schedule view — drag to reorder (not yet implemented)</p>
      {renderTasksMode()}
    </div>
  );

  return (
    <div className={`planner-renderer ${className}`} data-instance-id={instanceId}>
      <div className="planner-header">
        <h3 className="planner-title">{component.title}</h3>
        {component.description && <p className="planner-description">{component.description}</p>}

        <div className="planner-mode-tabs" role="tablist">
          {["tasks", "timeline", "schedule", "budget"].map(m => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={`mode-tab ${mode === m ? "active" : ""}`}
              onClick={() => handleModeChange(m as PlannerComponent["mode"])}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {mode === "tasks" && renderTasksMode()}
      {mode === "budget" && renderBudgetMode()}
      {mode === "timeline" && renderTimelineMode()}
      {mode === "schedule" && renderScheduleMode()}
    </div>
  );
}