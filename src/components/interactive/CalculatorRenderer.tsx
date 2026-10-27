// ---------------------------------------------------------------------------
// Calculator Renderer — Interactive Calculator Components
// ---------------------------------------------------------------------------
//
// Renders calculator-type components (basic, percentage, compound interest,
// time, grade calculators) with editable inputs and live results.
//
// ---------------------------------------------------------------------------

import React, { useState, useMemo, useCallback } from "react";
import { CalculatorComponent, CalculatorField } from "../../lib/interactive-types";
import { getCalculator } from "../../lib/interactive-validators";

interface CalculatorRendererProps {
  component: CalculatorComponent;
  instanceId: string;
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
  className?: string;
}

export default function CalculatorRenderer({
  component,
  instanceId,
  onUpdate,
  className = "",
}: CalculatorRendererProps) {
  const [inputs, setInputs] = useState<Record<string, number | string>>(component.inputs || {});

  // Compute result using the registered calculator function
  const result = useMemo(() => {
    const calculator = getCalculator(component.formula);
    if (!calculator) {
      return { value: null, error: `Unknown formula: ${component.formula}` };
    }

    try {
      // Convert string inputs to numbers for calculation
      const numericInputs: Record<string, number> = {};
      for (const [key, value] of Object.entries(inputs)) {
        const num = typeof value === "string" ? parseFloat(value) : value;
        if (!isNaN(num)) numericInputs[key] = num;
      }

      const computed = calculator(numericInputs);
      if (typeof computed === "object" && computed !== null) {
        return { value: computed, error: null };
      }
      return { value: computed, error: null };
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : "Calculation error" };
    }
  }, [component.formula, inputs]);

  const handleInputChange = useCallback((fieldId: string, value: string | number) => {
    setInputs(prev => {
      const next = { ...prev, [fieldId]: value };
      onUpdate?.(instanceId, next);
      return next;
    });
  }, [instanceId, onUpdate]);

  const handleNumberInput = useCallback((field: CalculatorField, e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === "" || value === "-") {
      handleInputChange(field.id, value);
      return;
    }
    const num = parseFloat(value);
    if (!isNaN(num)) {
      if (field.min !== undefined && num < field.min) return;
      if (field.max !== undefined && num > field.max) return;
      handleInputChange(field.id, num);
    }
  }, [handleInputChange]);

  const handleSelectChange = useCallback((field: CalculatorField, e: React.ChangeEvent<HTMLSelectElement>) => {
    handleInputChange(field.id, e.target.value);
  }, [handleInputChange]);

  const formatResult = useCallback((val: unknown): string => {
    if (val === null || val === undefined) return "—";
    if (typeof val === "number") {
      if (!isFinite(val)) return "∞";
      const precision = component.precision ?? 2;
      return val.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: precision,
      });
    }
    if (typeof val === "object") {
      return JSON.stringify(val, null, 2);
    }
    return String(val);
  }, [component.precision]);

  return (
    <div className={`calculator-renderer ${className}`} data-instance-id={instanceId}>
      <div className="calculator-header">
        <h3 className="calculator-title">{component.title}</h3>
        {component.description && <p className="calculator-description">{component.description}</p>}
      </div>

      <div className="calculator-fields">
        {component.fields.map((field) => (
          <div key={field.id} className="calculator-field">
            <label htmlFor={`${instanceId}-${field.id}`} className="field-label">
              {field.label}
              {field.required && <span className="required" aria-hidden="true">*</span>}
            </label>
            {field.type === "number" ? (
              <input
                id={`${instanceId}-${field.id}`}
                type="number"
                className="field-input"
                value={inputs[field.id] ?? ""}
                onChange={(e) => handleNumberInput(field, e)}
                min={field.min}
                max={field.max}
                step={field.step ?? "any"}
                placeholder={field.placeholder}
                aria-describedby={field.unit ? `${instanceId}-${field.id}-unit` : undefined}
              />
            ) : (
              <select
                id={`${instanceId}-${field.id}`}
                className="field-select"
                value={inputs[field.id] ?? ""}
                onChange={(e) => handleSelectChange(field, e)}
              >
                <option value="">Select...</option>
                {field.options?.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}
            {field.unit && (
              <span id={`${instanceId}-${field.id}-unit`} className="field-unit" aria-hidden="true">
                {field.unit}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="calculator-result" role="status" aria-live="polite">
        <div className="result-label">Result</div>
        <div className="result-value">
          {result.error ? (
            <span className="result-error" role="alert">{result.error}</span>
          ) : (
            formatResult(result.value)
          )}
        </div>
      </div>

      {component.showExplanation !== false && component.formula && (
        <details className="calculator-explanation">
          <summary>How this is calculated</summary>
          <div className="explanation-content">
            <p>Formula: <code>{component.formula}</code></p>
            <p>Inputs: {JSON.stringify(inputs, null, 2)}</p>
          </div>
        </details>
      )}
    </div>
  );
}