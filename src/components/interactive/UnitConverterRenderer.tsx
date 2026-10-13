// ---------------------------------------------------------------------------
// Unit Converter Renderer — Convert Between Units Across Categories
// ---------------------------------------------------------------------------
//
// Renders an interactive unit converter with category selection,
// from/to unit selection, and live conversion.
//
// ---------------------------------------------------------------------------

import React, { useState, useMemo, useCallback, useEffect } from "react";
import { UnitConverterComponent } from "../../lib/interactive-types";
import { convertUnit, getUnitsForCategory, UnitDefinition } from "../../lib/interactive-validators";

interface UnitConverterRendererProps {
  component: UnitConverterComponent;
  instanceId: string;
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
  className?: string;
}

type UnitCategory = "length" | "weight" | "temperature" | "volume" | "area" | "speed" | "time" | "data" | "pressure";

export default function UnitConverterRenderer({
  component,
  instanceId,
  onUpdate,
  className = "",
}: UnitConverterRendererProps) {
  const [category, setCategory] = useState<UnitCategory>(component.category);
  const [fromUnit, setFromUnit] = useState(component.fromUnit);
  const [toUnit, setToUnit] = useState(component.toUnit);
  const [value, setValue] = useState(component.value);
  const [swapDirection, setSwapDirection] = useState(false);

  const availableUnits = useMemo(() => getUnitsForCategory(category), [category]);

  // Sync units when category changes
  useEffect(() => {
    const units = getUnitsForCategory(category);
    if (units.length > 0) {
      if (!units.find(u => u.value === fromUnit)) {
        setFromUnit(units[0].value);
      }
      if (!units.find(u => u.value === toUnit) || toUnit === fromUnit) {
        setToUnit(units[Math.min(1, units.length - 1)].value);
      }
    }
  }, [category]);

  const handleCategoryChange = useCallback((newCategory: string) => {
    setCategory(newCategory as UnitCategory);
    onUpdate?.(instanceId, { category: newCategory, fromUnit, toUnit, value });
  }, [instanceId, onUpdate, fromUnit, toUnit, value]);

  const handleFromUnitChange = useCallback((newUnit: string) => {
    setFromUnit(newUnit);
    onUpdate?.(instanceId, { category, fromUnit: newUnit, toUnit, value });
  }, [instanceId, onUpdate, category, toUnit, value]);

  const handleToUnitChange = useCallback((newUnit: string) => {
    setToUnit(newUnit);
    onUpdate?.(instanceId, { category, fromUnit, toUnit: newUnit, value });
  }, [instanceId, onUpdate, category, fromUnit, value]);

  const handleValueChange = useCallback((newValue: number) => {
    setValue(newValue);
    onUpdate?.(instanceId, { category, fromUnit, toUnit, value: newValue });
  }, [instanceId, onUpdate, category, fromUnit, toUnit]);

  const handleSwap = useCallback(() => {
    setFromUnit(toUnit);
    setToUnit(fromUnit);
    onUpdate?.(instanceId, { category, fromUnit: toUnit, toUnit: fromUnit, value });
  }, [instanceId, onUpdate, category, fromUnit, toUnit, value]);

  // Compute conversion
  const result = useMemo(() => {
    if (!isFinite(value)) return { converted: NaN, formula: "" };
    try {
      const converted = convertUnit(value, fromUnit, toUnit, category);
      const fromDef = availableUnits.find(u => u.value === fromUnit);
      const toDef = availableUnits.find(u => u.value === toUnit);
      const formula = fromDef && toDef
        ? `${value} ${fromDef.symbol || fromDef.value} = ${converted.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${toDef.symbol || toDef.value}`
        : "";
      return { converted, formula };
    } catch {
      return { converted: NaN, formula: "Conversion error" };
    }
  }, [value, fromUnit, toUnit, category, availableUnits]);

  const fromUnitDef = availableUnits.find(u => u.value === fromUnit);
  const toUnitDef = availableUnits.find(u => u.value === toUnit);

  return (
    <div className={`unit-converter-renderer ${className}`} data-instance-id={instanceId}>
      <div className="unit-converter-header">
        <h3 className="unit-converter-title">{component.title}</h3>
        {component.description && <p className="unit-converter-description">{component.description}</p>}
      </div>

      <div className="unit-converter-category">
        <label htmlFor={`${instanceId}-category`} className="visually-hidden">Category</label>
        <select
          id={`${instanceId}-category`}
          value={category}
          onChange={(e) => handleCategoryChange(e.target.value)}
          className="category-select"
        >
          {Object.keys(getUnitsForCategory("length")).length > 0 && (
            <optgroup label="Common">
              <option value="length">Length</option>
              <option value="weight">Weight / Mass</option>
              <option value="temperature">Temperature</option>
              <option value="volume">Volume</option>
            </optgroup>
          )}
          <optgroup label="More">
            <option value="area">Area</option>
            <option value="speed">Speed</option>
            <option value="time">Time</option>
            <option value="data">Data Storage</option>
            <option value="pressure">Pressure</option>
          </optgroup>
        </select>
      </div>

      <div className="unit-converter-main">
        <div className="converter-input">
          <label htmlFor={`${instanceId}-value`} className="visually-hidden">Value to convert</label>
          <input
            id={`${instanceId}-value`}
            type="number"
            step="any"
            value={value}
            onChange={(e) => handleValueChange(parseFloat(e.target.value) || 0)}
            className="converter-value-input"
            placeholder="Enter value"
            aria-label="Value to convert"
          />
          <select
            id={`${instanceId}-from-unit`}
            value={fromUnit}
            onChange={(e) => handleFromUnitChange(e.target.value)}
            className="converter-unit-select"
            aria-label="From unit"
          >
            {availableUnits.map(unit => (
              <option key={unit.value} value={unit.value}>
                {unit.label} {unit.symbol ? `(${unit.symbol})` : ""}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={handleSwap}
          className="swap-button"
          aria-label="Swap from and to units"
          title="Swap units"
        >
          ⇄
        </button>

        <div className="converter-output">
          <label htmlFor={`${instanceId}-result`} className="visually-hidden">Converted value</label>
          <div className="converter-value-display">
            {isFinite(result.converted)
              ? result.converted.toLocaleString(undefined, { maximumFractionDigits: 6 })
              : "—"}
          </div>
          <select
            id={`${instanceId}-to-unit`}
            value={toUnit}
            onChange={(e) => handleToUnitChange(e.target.value)}
            className="converter-unit-select"
            aria-label="To unit"
          >
            {availableUnits.map(unit => (
              <option key={unit.value} value={unit.value}>
                {unit.label} {unit.symbol ? `(${unit.symbol})` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {result.formula && (
        <div className="converter-formula" role="status" aria-live="polite">
          {result.formula}
        </div>
      )}

      <details className="unit-converter-reference">
        <summary>All units in this category</summary>
        <table className="unit-reference-table">
          <thead>
            <tr>
              <th>Unit</th>
              <th>Symbol</th>
              <th>Relative to base</th>
            </tr>
          </thead>
          <tbody>
            {availableUnits.map(unit => (
              <tr key={unit.value}>
                <td>{unit.label}</td>
                <td>{unit.symbol || "—"}</td>
                <td>{unit.toBase === 1 ? "Base unit" : `×${unit.toBase}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}