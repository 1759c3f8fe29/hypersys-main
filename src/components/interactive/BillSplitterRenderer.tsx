// ---------------------------------------------------------------------------
// Bill Splitter Renderer — Split Bills with Tips & Custom Allocations
// ---------------------------------------------------------------------------
//
// Renders an interactive bill splitter with editable inputs for total,
// tip, tax, number of people, and custom splits.
//
// ---------------------------------------------------------------------------

import React, { useState, useMemo, useCallback } from "react";
import { BillSplitterComponent } from "../../lib/interactive-types";

interface BillSplitterRendererProps {
  component: BillSplitterComponent;
  instanceId: string;
  onUpdate?: (key: string, inputs: Record<string, unknown>) => void;
  className?: string;
}

export default function BillSplitterRenderer({
  component,
  instanceId,
  onUpdate,
  className = "",
}: BillSplitterRendererProps) {
  const [total, setTotal] = useState(component.total);
  const [people, setPeople] = useState(component.people);
  const [tipPercent, setTipPercent] = useState(component.tipPercent || 0);
  const [taxPercent, setTaxPercent] = useState(component.taxPercent || 0);
  const [customSplits, setCustomSplits] = useState<{ name: string; amount: number }[]>(
    component.customSplits || Array.from({ length: people }, (_, i) => ({ name: `Person ${i + 1}`, amount: 0 }))
  );
  const [useCustom, setUseCustom] = useState(!!component.customSplits);
  const currency = component.currency || "$";

  // Sync custom splits when people count changes
  const syncCustomSplits = useCallback((newPeople: number) => {
    setCustomSplits(prev => {
      if (newPeople <= prev.length) return prev.slice(0, newPeople);
      return [
        ...prev,
        ...Array.from({ length: newPeople - prev.length }, (_, i) => ({
          name: `Person ${prev.length + i + 1}`,
          amount: 0,
        })),
      ];
    });
  }, []);

  const handlePeopleChange = useCallback((newPeople: number) => {
    const clamped = Math.max(1, Math.min(100, newPeople));
    setPeople(clamped);
    syncCustomSplits(clamped);
    onUpdate?.(instanceId, { total, people: clamped, tipPercent, taxPercent, customSplits, useCustom });
  }, [instanceId, onUpdate, total, tipPercent, taxPercent, customSplits, useCustom, syncCustomSplits]);

  const handleTotalChange = useCallback((newTotal: number) => {
    const clamped = Math.max(0, newTotal);
    setTotal(clamped);
    onUpdate?.(instanceId, { total: clamped, people, tipPercent, taxPercent, customSplits, useCustom });
  }, [instanceId, onUpdate, people, tipPercent, taxPercent, customSplits, useCustom]);

  const handleTipChange = useCallback((newTip: number) => {
    const clamped = Math.max(0, Math.min(100, newTip));
    setTipPercent(clamped);
    onUpdate?.(instanceId, { total, people, tipPercent: clamped, taxPercent, customSplits, useCustom });
  }, [instanceId, onUpdate, total, people, taxPercent, customSplits, useCustom]);

  const handleTaxChange = useCallback((newTax: number) => {
    const clamped = Math.max(0, Math.min(100, newTax));
    setTaxPercent(clamped);
    onUpdate?.(instanceId, { total, people, tipPercent, taxPercent: clamped, customSplits, useCustom });
  }, [instanceId, onUpdate, total, people, tipPercent, customSplits, useCustom]);

  const handleCustomSplitChange = useCallback((index: number, field: "name" | "amount", value: string | number) => {
    setCustomSplits(prev => {
      const next = [...prev];
      if (field === "amount") {
        const num = typeof value === "string" ? parseFloat(value) : value;
        next[index] = { ...next[index], amount: isNaN(num) ? 0 : Math.max(0, num) };
      } else {
        next[index] = { ...next[index], name: String(value) };
      }
      onUpdate?.(instanceId, { total, people, tipPercent, taxPercent, customSplits: next, useCustom: true });
      return next;
    });
  }, [instanceId, onUpdate, total, people, tipPercent, taxPercent, useCustom]);

  // Computed values
  const computed = useMemo(() => {
    const subtotal = total;
    const tipAmount = subtotal * (tipPercent / 100);
    const taxAmount = subtotal * (taxPercent / 100);
    const grandTotal = subtotal + tipAmount + taxAmount;

    if (useCustom && customSplits.length > 0) {
      const customTotal = customSplits.reduce((sum, s) => sum + s.amount, 0);
      const remaining = grandTotal - customTotal;
      const equalShare = remaining / Math.max(1, people - customSplits.length);
      return {
        subtotal,
        tipAmount,
        taxAmount,
        grandTotal,
        perPerson: equalShare,
        customTotal,
        remaining,
        isValid: Math.abs(customTotal - grandTotal) < 0.01 || customTotal <= grandTotal,
      };
    }

    const perPerson = grandTotal / Math.max(1, people);
    return {
      subtotal,
      tipAmount,
      taxAmount,
      grandTotal,
      perPerson,
      customTotal: 0,
      remaining: grandTotal,
      isValid: true,
    };
  }, [total, people, tipPercent, taxPercent, customSplits, useCustom]);

  const formatCurrency = (val: number) => `${currency}${val.toFixed(2)}`;

  return (
    <div className={`bill-splitter-renderer ${className}`} data-instance-id={instanceId}>
      <div className="bill-splitter-header">
        <h3 className="bill-splitter-title">{component.title}</h3>
        {component.description && <p className="bill-splitter-description">{component.description}</p>}
      </div>

      <div className="bill-splitter-inputs">
        <div className="input-group">
          <label htmlFor={`${instanceId}-total`}>Bill Total</label>
          <div className="input-with-symbol">
            <span className="currency-symbol">{currency}</span>
            <input
              id={`${instanceId}-total`}
              type="number"
              step="0.01"
              min="0"
              value={total}
              onChange={(e) => handleTotalChange(parseFloat(e.target.value) || 0)}
              className="input-field"
            />
          </div>
        </div>

        <div className="input-row">
          <div className="input-group">
            <label htmlFor={`${instanceId}-people`}>People</label>
            <input
              id={`${instanceId}-people`}
              type="number"
              min="1"
              max="100"
              value={people}
              onChange={(e) => handlePeopleChange(parseInt(e.target.value) || 1)}
              className="input-field"
            />
          </div>

          <div className="input-group">
            <label htmlFor={`${instanceId}-tip`}>Tip %</label>
            <div className="input-with-symbol">
              <input
                id={`${instanceId}-tip`}
                type="number"
                step="1"
                min="0"
                max="100"
                value={tipPercent}
                onChange={(e) => handleTipChange(parseFloat(e.target.value) || 0)}
                className="input-field"
              />
              <span className="percent-symbol">%</span>
            </div>
          </div>

          <div className="input-group">
            <label htmlFor={`${instanceId}-tax`}>Tax %</label>
            <div className="input-with-symbol">
              <input
                id={`${instanceId}-tax`}
                type="number"
                step="1"
                min="0"
                max="100"
                value={taxPercent}
                onChange={(e) => handleTaxChange(parseFloat(e.target.value) || 0)}
                className="input-field"
              />
              <span className="percent-symbol">%</span>
            </div>
          </div>
        </div>

        <div className="input-group">
          <label>
            <input
              type="checkbox"
              checked={useCustom}
              onChange={(e) => {
                setUseCustom(e.target.checked);
                onUpdate?.(instanceId, { total, people, tipPercent, taxPercent, customSplits, useCustom: e.target.checked });
              }}
            />
            Custom splits
          </label>
        </div>

        {useCustom && (
          <div className="custom-splits">
            <h4>Custom Allocations</h4>
            <div className="custom-splits-header">
              <span>Name</span>
              <span>Amount</span>
            </div>
            {customSplits.map((split, index) => (
              <div key={index} className="custom-split-row">
                <input
                  type="text"
                  value={split.name}
                  onChange={(e) => handleCustomSplitChange(index, "name", e.target.value)}
                  placeholder={`Person ${index + 1}`}
                  className="input-field split-name"
                />
                <div className="input-with-symbol">
                  <span className="currency-symbol">{currency}</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={split.amount}
                    onChange={(e) => handleCustomSplitChange(index, "amount", e.target.value)}
                    className="input-field split-amount"
                  />
                </div>
              </div>
            ))}
            <div className="custom-splits-summary">
              <span>Custom total: {formatCurrency(computed.customTotal)}</span>
              <span className={computed.isValid ? "" : "warning"}>
                Remaining: {formatCurrency(computed.remaining)}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="bill-splitter-results">
        <div className="result-row">
          <span>Subtotal</span>
          <span>{formatCurrency(computed.subtotal)}</span>
        </div>
        {tipPercent > 0 && (
          <div className="result-row">
            <span>Tip ({tipPercent}%)</span>
            <span>{formatCurrency(computed.tipAmount)}</span>
          </div>
        )}
        {taxPercent > 0 && (
          <div className="result-row">
            <span>Tax ({taxPercent}%)</span>
            <span>{formatCurrency(computed.taxAmount)}</span>
          </div>
        )}
        <div className="result-row total">
          <span>Grand Total</span>
          <span>{formatCurrency(computed.grandTotal)}</span>
        </div>
        <div className="result-row per-person">
          <span>Per Person</span>
          <span>{formatCurrency(computed.perPerson)}</span>
        </div>
      </div>

      {people > 1 && !useCustom && (
        <div className="bill-splitter-breakdown">
          <h4>Equal Split Breakdown</h4>
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: people }, (_, i) => (
                <tr key={i}>
                  <td>Person {i + 1}</td>
                  <td>{formatCurrency(computed.perPerson)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}