// ---------------------------------------------------------------------------
// Chart Renderer — Interactive Data Visualizations
// ---------------------------------------------------------------------------
//
// Renders chart components using a lightweight SVG-based approach.
// Supports bar, line, scatter, pie, donut, and area charts.
//
// ---------------------------------------------------------------------------

import React, { useMemo, useRef, useEffect } from "react";
import { ChartComponent, ChartDataset, ChartDataPoint } from "../../lib/interactive-types";

interface ChartRendererProps {
  component: ChartComponent;
  instanceId: string;
  className?: string;
}

const COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#a855f7",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

const MARGIN = { top: 20, right: 30, bottom: 50, left: 60 };
const PIE_MARGIN = { top: 20, right: 20, bottom: 20, left: 20 };

export default function ChartRenderer({ component, instanceId, className = "" }: ChartRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const { chartType, data, options = {}, showDataTable = false, xKey, yKeys, labelKey, valueKey } = component;

  const width = useMemo(() => containerRef.current?.clientWidth || 600, []);
  const height = useMemo(() => options.animationDuration ? 400 : 400, []);

  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = height - MARGIN.top - MARGIN.bottom;

  // Process data for different chart types
  const processedData = useMemo(() => {
    if (["pie", "donut"].includes(chartType)) {
      const key = labelKey || "label";
      const valKey = valueKey || "value";
      return data.flatMap((ds, di) =>
        ds.data.map((d, i) => ({
          label: String(d[key] ?? `Item ${i + 1}`),
          value: Number(d[valKey] ?? 0),
          color: ds.color || COLORS[(di * data.length + i) % COLORS.length],
          datasetLabel: ds.label,
        }))
      ).filter(d => d.value > 0);
    }

    if (!xKey || !yKeys?.length) return [];

    return data.flatMap((ds, di) =>
      ds.data.map((d) => ({
        x: d[xKey],
        y: yKeys.map(k => Number(d[k] ?? 0)),
        color: ds.color || COLORS[di % COLORS.length],
        datasetLabel: ds.label,
      }))
    );
  }, [chartType, data, xKey, yKeys, labelKey, valueKey]);

  // Compute scales
  const scales = useMemo(() => {
    if (["pie", "donut"].includes(chartType)) return null;

    const allX = processedData.flatMap(d => [d.x]).filter(v => v != null);
    const allY = processedData.flatMap(d => d.y).filter(v => v != null && isFinite(v));

    const xValues = allX as (string | number)[];
    const isNumericX = xValues.every(v => typeof v === "number");

    const xMin = isNumericX ? Math.min(...xValues as number[]) : 0;
    const xMax = isNumericX ? Math.max(...xValues as number[]) : xValues.length - 1;
    const yMin = Math.min(0, ...allY);
    const yMax = Math.max(...allY);

    const xScale = (val: string | number) => {
      if (isNumericX) {
        return MARGIN.left + ((val as number) - xMin) / (xMax - xMin || 1) * innerWidth;
      }
      const idx = xValues.indexOf(val);
      return MARGIN.left + (idx + 0.5) / xValues.length * innerWidth;
    };

    const yScale = (val: number) =>
      MARGIN.top + innerHeight - (val - yMin) / (yMax - yMin || 1) * innerHeight;

    return { xScale, yScale, xMin, xMax, yMin, yMax, isNumericX, xValues };
  }, [processedData, chartType, innerWidth, innerHeight]);

  // Render axes for cartesian charts
  const renderAxes = () => {
    if (!scales || ["pie", "donut"].includes(chartType)) return null;

    const { xScale, yScale, xMin, xMax, yMin, yMax, isNumericX, xValues } = scales;
    const tickCount = Math.min(10, innerWidth / 60);
    const yTicks = Array.from({ length: tickCount }, (_, i) => yMin + (yMax - yMin) * i / (tickCount - 1));

    return (
      <g className="chart-axes">
        {/* Y axis */}
        <line x1={MARGIN.left} y1={MARGIN.top} x2={MARGIN.left} y2={MARGIN.top + innerHeight} className="axis-line" />
        {yTicks.map((val, i) => (
          <g key={i} className="y-tick">
            <line x1={MARGIN.left - 5} y1={yScale(val)} x2={MARGIN.left} y2={yScale(val)} className="tick-line" />
            <text x={MARGIN.left - 10} y={yScale(val) + 4} textAnchor="end" className="tick-label">
              {val.toLocaleString(undefined, { maximumFractionDigits: 1 })}
            </text>
          </g>
        ))}
        {options.yAxisLabel && (
          <text
            x={MARGIN.left - 40}
            y={MARGIN.top + innerHeight / 2}
            textAnchor="middle"
            transform={`rotate(-90, ${MARGIN.left - 40}, ${MARGIN.top + innerHeight / 2})`}
            className="axis-label"
          >
            {options.yAxisLabel}
          </text>
        )}

        {/* X axis */}
        <line x1={MARGIN.left} y1={MARGIN.top + innerHeight} x2={MARGIN.left + innerWidth} y2={MARGIN.top + innerHeight} className="axis-line" />
        {isNumericX ? (
          Array.from({ length: tickCount }, (_, i) => xMin + (xMax - xMin) * i / (tickCount - 1)).map((val, i) => (
            <g key={i} className="x-tick">
              <line x1={xScale(val)} y1={MARGIN.top + innerHeight} x2={xScale(val)} y2={MARGIN.top + innerHeight + 5} className="tick-line" />
              <text x={xScale(val)} y={MARGIN.top + innerHeight + 20} textAnchor="middle" className="tick-label">
                {val.toLocaleString(undefined, { maximumFractionDigits: 1 })}
              </text>
            </g>
          ))
        ) : (
          xValues.map((val, i) => (
            <g key={val} className="x-tick">
              <line x1={xScale(val)} y1={MARGIN.top + innerHeight} x2={xScale(val)} y2={MARGIN.top + innerHeight + 5} className="tick-line" />
              <text x={xScale(val)} y={MARGIN.top + innerHeight + 20} textAnchor="middle" className="tick-label">
                {String(val)}
              </text>
            </g>
          ))
        )}
        {options.xAxisLabel && (
          <text
            x={MARGIN.left + innerWidth / 2}
            y={MARGIN.top + innerHeight + 45}
            textAnchor="middle"
            className="axis-label"
          >
            {options.xAxisLabel}
          </text>
        )}
      </g>
    );
  };

  // Render grid lines
  const renderGrid = () => {
    if (!scales || ["pie", "donut"].includes(chartType) || !options.grid) return null;

    const { yScale, yMin, yMax } = scales;
    const tickCount = Math.min(10, innerHeight / 40);
    const yTicks = Array.from({ length: tickCount }, (_, i) => yMin + (yMax - yMin) * i / (tickCount - 1));

    return (
      <g className="chart-grid">
        {yTicks.map((val, i) => (
          <line key={i} x1={MARGIN.left} y1={yScale(val)} x2={MARGIN.left + innerWidth} y2={yScale(val)} className="grid-line" />
        ))}
      </g>
    );
  };

  // Render chart based on type
  const renderChart = () => {
    if (["pie", "donut"].includes(chartType)) {
      // Type narrow for pie/donut data
      const pieData = processedData as Array<{ label: string; value: number; color: string; datasetLabel: string }>;
      const total = pieData.reduce((sum, d) => sum + d.value, 0);
      let currentAngle = -Math.PI / 2;
      const radius = Math.min(innerWidth, innerHeight) / 2;
      const innerRadius = chartType === "donut" ? radius * 0.6 : 0;
      const cx = width / 2;
      const cy = height / 2;

      return (
        <g className={`chart-${chartType}`} transform={`translate(${cx}, ${cy})`}>
          {pieData.map((d, i) => {
            const sliceAngle = (d.value / total) * 2 * Math.PI;
            const startAngle = currentAngle;
            const endAngle = currentAngle + sliceAngle;
            currentAngle = endAngle;

            const x1 = Math.cos(startAngle) * radius;
            const y1 = Math.sin(startAngle) * radius;
            const x2 = Math.cos(endAngle) * radius;
            const y2 = Math.sin(endAngle) * radius;
            const largeArc = sliceAngle > Math.PI ? 1 : 0;

            const pathData = [
              `M 0 0`,
              `L ${Math.cos(startAngle) * innerRadius} ${Math.sin(startAngle) * innerRadius}`,
              `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
              `L ${Math.cos(endAngle) * innerRadius} ${Math.sin(endAngle) * innerRadius}`,
              `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${Math.cos(startAngle) * innerRadius} ${Math.sin(startAngle) * innerRadius}`,
              "Z",
            ].join(" ");

            return (
              <path
                key={i}
                d={pathData}
                fill={d.color}
                className="pie-slice"
                data-label={d.label}
                data-value={d.value}
                data-dataset={d.datasetLabel}
              />
            );
          })}
        </g>
      );
    }

    // Cartesian charts: bar, line, scatter, area
    return (
      <g className={`chart-${chartType}`}>
        {processedData.map((d, i) => {
          const x = scales!.xScale(d.x);
          const ys = d.y.map(v => scales!.yScale(v));
          const color = d.color;

          if (chartType === "bar") {
            const barWidth = innerWidth / (scales!.xValues.length * (d.y.length + 0.5));
            return (
              <g key={i} className="bar-series">
                {d.y.map((yVal, yi) => (
                  <rect
                    key={yi}
                    x={x - barWidth * (d.y.length - 1) / 2 + yi * barWidth}
                    y={ys[yi]}
                    width={barWidth * 0.8}
                    height={innerHeight + MARGIN.top - ys[yi]}
                    fill={color}
                    className="bar"
                    data-value={yVal}
                    data-x={d.x}
                    data-dataset={d.datasetLabel}
                  />
                ))}
              </g>
            );
          }

          if (chartType === "line" || chartType === "area") {
            const points = d.y.map((yVal, yi) => ({
              x: scales!.xScale(d.x),
              y: scales!.yScale(yVal),
              value: yVal,
            }));

            const pathData = points.map((p, pi) =>
              `${pi === 0 ? "M" : "L"} ${p.x} ${p.y}`
            ).join(" ");

            return (
              <g key={i} className={`${chartType}-series`}>
                {chartType === "area" && (
                  <path
                    d={pathData + ` L ${points[points.length - 1].x} ${MARGIN.top + innerHeight} L ${points[0].x} ${MARGIN.top + innerHeight} Z`}
                    fill={color}
                    fillOpacity={0.15}
                    className="area-fill"
                  />
                )}
                <path
                  d={pathData}
                  stroke={color}
                  strokeWidth={2}
                  fill="none"
                  className={chartType === "line" ? "line-path" : "area-path"}
                />
                {points.map((p, pi) => (
                  <circle
                    key={pi}
                    cx={p.x}
                    cy={p.y}
                    r={4}
                    fill={color}
                    className="data-point"
                    data-value={p.value}
                    data-x={d.x}
                    data-dataset={d.datasetLabel}
                  />
                ))}
              </g>
            );
          }

          if (chartType === "scatter") {
            return (
              <g key={i} className="scatter-series">
                {d.y.map((yVal, yi) => (
                  <circle
                    key={yi}
                    cx={x}
                    cy={ys[yi]}
                    r={5}
                    fill={color}
                    className="scatter-point"
                    data-value={yVal}
                    data-x={d.x}
                    data-dataset={d.datasetLabel}
                  />
                ))}
              </g>
            );
          }

          return null;
        })}
      </g>
    );
  };

  // Legend
  const renderLegend = () => {
    if (!options.legend) return null;

    if (["pie", "donut"].includes(chartType)) {
      return (
        <div className="chart-legend pie-legend">
          {processedData.map((d, i) => (
            <div key={i} className="legend-item">
              <span className="legend-color" style={{ backgroundColor: d.color }} />
              <span className="legend-label">{d.label}</span>
              <span className="legend-value">{d.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      );
    }

    const datasets = data.map((ds, i) => ({
      label: ds.label,
      color: ds.color || COLORS[i % COLORS.length],
    }));

    return (
      <div className="chart-legend">
        {datasets.map((ds, i) => (
          <div key={i} className="legend-item">
            <span className="legend-color" style={{ backgroundColor: ds.color }} />
            <span className="legend-label">{ds.label}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className={`chart-renderer ${className}`} data-instance-id={instanceId} ref={containerRef}>
      <div className="chart-header">
        <h3 className="chart-title">{component.title}</h3>
        {component.description && <p className="chart-description">{component.description}</p>}
      </div>

      <div className="chart-container">
        <svg
          ref={svgRef}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="chart-svg"
          role="img"
          aria-label={component.title}
        >
          {renderGrid()}
          {renderAxes()}
          {renderChart()}
        </svg>
        {renderLegend()}
      </div>

      {showDataTable && (
        <details className="chart-data-table">
          <summary>Show Data Table</summary>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>{xKey || "Label"}</th>
                  {yKeys?.map(k => <th key={k}>{k}</th>) || (
                    <>
                      <th>{labelKey || "Label"}</th>
                      <th>{valueKey || "Value"}</th>
                    </>
                  )}
                  <th>Dataset</th>
                </tr>
              </thead>
              <tbody>
                {data.flatMap((ds, di) =>
                  ds.data.map((d, i) => (
                    <tr key={`${di}-${i}`}>
                      <td>{d[xKey || labelKey || "label"]}</td>
                      {yKeys?.map(k => <td key={k}>{d[k]}</td>) || (
                        <>
                          <td>{d[labelKey || "label"]}</td>
                          <td>{d[valueKey || "value"]}</td>
                        </>
                      )}
                      <td>{ds.label}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}