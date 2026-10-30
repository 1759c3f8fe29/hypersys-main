// ---------------------------------------------------------------------------
// Chart Renderer — Interactive Data Visualizations
// ---------------------------------------------------------------------------
//
// Renders chart components using a lightweight SVG-based approach.
// Supports bar, line, scatter, pie, donut, area, histogram, box_plot,
// heatmap, radar, treemap, waterfall, funnel, sankey, and network_graph charts.
//
// ---------------------------------------------------------------------------

import React, { useMemo, useRef, useEffect, useState } from "react";
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

// Color scales for heatmap
const HEATMAP_SEQUENTIAL = ["#fef0f9", "#fde0dd", "#fcc5c0", "#fa9fb5", "#f768a1", "#dd3497", "#ae017e", "#7a0177", "#49006a"];
const HEATMAP_DIVERGING = ["#2166ac", "#4393c3", "#92c5de", "#d1e5f0", "#f7f7f7", "#fddbc7", "#f4a582", "#d6604d", "#b2182b"];
const HEATMAP_CATEGORICAL = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#ec4899", "#06b6d4", "#84cc16"];

export default function ChartRenderer({ component, instanceId, className = "" }: ChartRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [d3Loaded, setD3Loaded] = useState(false);

  const { chartType, data, options = {}, showDataTable = false, xKey, yKeys, labelKey, valueKey } = component;

  const width = useMemo(() => containerRef.current?.clientWidth || 600, []);
  const height = useMemo(() => options.animationDuration ? 400 : 400, []);

  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = height - MARGIN.top - MARGIN.bottom;

  // Load D3 for advanced chart types
  useEffect(() => {
    if (["network_graph", "sankey", "treemap"].includes(chartType)) {
      import("d3").then(() => setD3Loaded(true)).catch(console.error);
    } else {
      setD3Loaded(true);
    }
  }, [chartType]);

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

  // Compute scales for cartesian charts
  const scales = useMemo(() => {
    if (["pie", "donut", "radar", "heatmap", "treemap", "waterfall", "funnel", "sankey", "network_graph", "box_plot"].includes(chartType)) return null;

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

  // Histogram binning
  const histogramData = useMemo(() => {
    if (chartType !== "histogram") return null;
    const values = processedData.flatMap(d => d.y).filter(v => isFinite(v));
    if (values.length === 0) return { bins: [], min: 0, max: 0 };

    const bins = options.bins || 10;
    const range = options.binRange || [Math.min(...values), Math.max(...values)];
    const binWidth = (range[1] - range[0]) / bins;

    const binCounts = new Array(bins).fill(0);
    values.forEach(v => {
      const idx = Math.min(Math.floor((v - range[0]) / binWidth), bins - 1);
      if (idx >= 0) binCounts[idx]++;
    });

    return {
      bins: binCounts.map((count, i) => ({
        x0: range[0] + i * binWidth,
        x1: range[0] + (i + 1) * binWidth,
        count,
      })),
      min: range[0],
      max: range[1],
    };
  }, [processedData, options]);

  // Box plot statistics
  const boxPlotData = useMemo(() => {
    if (chartType !== "box_plot") return null;
    return data.map((ds, di) => {
      const values = ds.data.map(d => Number(d[yKeys?.[0] ?? "value"] ?? 0)).filter(v => isFinite(v)).sort((a, b) => a - b);
      if (values.length === 0) return null;

      const q1 = values[Math.floor(values.length * 0.25)];
      const median = values[Math.floor(values.length * 0.5)];
      const q3 = values[Math.floor(values.length * 0.75)];
      const iqr = q3 - q1;
      const lowerWhisker = Math.max(values[0], q1 - 1.5 * iqr);
      const upperWhisker = Math.min(values[values.length - 1], q3 + 1.5 * iqr);
      const outliers = values.filter(v => v < lowerWhisker || v > upperWhisker);

      return {
        label: ds.label,
        min: values[0],
        q1,
        median,
        q3,
        max: values[values.length - 1],
        lowerWhisker,
        upperWhisker,
        outliers,
        color: ds.color || COLORS[di % COLORS.length],
      };
    }).filter(Boolean);
  }, [data, yKeys]);

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

        {/* Histogram */}
        {chartType === "histogram" && histogramData && (
          <g className="chart-histogram">
            {histogramData.bins.map((bin, i) => {
              const x0 = scales!.xScale(bin.x0);
              const x1 = scales!.xScale(bin.x1);
              const y0 = scales!.yScale(0);
              const y1 = scales!.yScale(bin.count);
              const barWidth = x1 - x0;
              return (
                <rect
                  key={i}
                  x={x0}
                  y={y1}
                  width={Math.max(1, barWidth - 1)}
                  height={y0 - y1}
                  fill={COLORS[0]}
                  className="histogram-bar"
                  data-count={bin.count}
                  data-range={`${bin.x0.toFixed(2)}-${bin.x1.toFixed(2)}`}
                />
              );
            })}
          </g>
        )}

        {/* Box Plot */}
        {chartType === "box_plot" && boxPlotData && (
          <g className="chart-box-plot">
            {boxPlotData.map((box, i) => {
              const cx = scales!.xScale(i);
              const boxWidth = Math.min(60, innerWidth / (boxPlotData.length + 1));
              const halfWidth = boxWidth / 2;

              const yMin = scales!.yScale(box.min);
              const yQ1 = scales!.yScale(box.q1);
              const yMedian = scales!.yScale(box.median);
              const yQ3 = scales!.yScale(box.q3);
              const yMax = scales!.yScale(box.max);
              const yLowerWhisker = scales!.yScale(box.lowerWhisker);
              const yUpperWhisker = scales!.yScale(box.upperWhisker);

              return (
                <g key={i} className="box-plot-series" transform={`translate(${cx}, 0)`}>
                  {/* Whiskers */}
                  <line x1={0} y1={yLowerWhisker} x2={0} y2={yUpperWhisker} stroke={box.color} strokeWidth={1.5} />
                  {/* Whisker caps */}
                  <line x1={-halfWidth / 2} y1={yLowerWhisker} x2={halfWidth / 2} y2={yLowerWhisker} stroke={box.color} strokeWidth={1.5} />
                  <line x1={-halfWidth / 2} y1={yUpperWhisker} x2={halfWidth / 2} y2={yUpperWhisker} stroke={box.color} strokeWidth={1.5} />
                  {/* Box */}
                  <rect x={-halfWidth} y={yQ3} width={boxWidth} height={yQ1 - yQ3} fill={box.color} fillOpacity={0.3} stroke={box.color} strokeWidth={1.5} />
                  {/* Median line */}
                  <line x1={-halfWidth} y1={yMedian} x2={halfWidth} y2={yMedian} stroke={box.color} strokeWidth={2} />
                  {/* Outliers */}
                  {box.outliers.map((outlier, oi) => (
                    <circle key={oi} cx={0} cy={scales!.yScale(outlier)} r={3} fill={box.color} className="box-outlier" />
                  ))}
                </g>
              );
            })}
          </g>
        )}
      </g>
    );
  };

  // Render heatmap
  const renderHeatmap = () => {
    if (chartType !== "heatmap") return null;
    if (!component.categoryKey || !component.seriesKey || !component.valueKey) return null;

    const categories = Array.from(new Set(data.flatMap(ds => ds.data.map(d => String(d[component.categoryKey!])))));
    const series = Array.from(new Set(data.flatMap(ds => ds.data.map(d => String(d[component.seriesKey!])))));
    const cellSize = Math.min(innerWidth / categories.length, innerHeight / series.length, 40);
    const startX = MARGIN.left + (innerWidth - categories.length * cellSize) / 2;
    const startY = MARGIN.top + (innerHeight - series.length * cellSize) / 2;

    const values = data.flatMap(ds => ds.data.map(d => Number(d[component.valueKey!] ?? 0))).filter(v => isFinite(v));
    const vMin = Math.min(...values);
    const vMax = Math.max(...values);

    const getColor = (value: number) => {
      const normalized = (value - vMin) / (vMax - vMin || 1);
      const palette = options.colorScale === "diverging" ? HEATMAP_DIVERGING : options.colorScale === "categorical" ? HEATMAP_CATEGORICAL : HEATMAP_SEQUENTIAL;
      const idx = Math.floor(normalized * (palette.length - 1));
      return palette[Math.max(0, Math.min(idx, palette.length - 1))];
    };

    return (
      <g className="chart-heatmap" transform={`translate(${startX}, ${startY})`}>
        {series.flatMap((s, si) =>
          categories.map((c, ci) => {
            const point = data.flatMap(ds => ds.data).find(d => String(d[component.categoryKey!]) === c && String(d[component.seriesKey!]) === s);
            const value = point ? Number(point[component.valueKey!] ?? 0) : 0;
            const color = getColor(value);
            return (
              <g key={`${si}-${ci}`}>
                <rect
                  x={ci * cellSize}
                  y={si * cellSize}
                  width={cellSize}
                  height={cellSize}
                  fill={color}
                  className="heatmap-cell"
                  data-category={c}
                  data-series={s}
                  data-value={value}
                />
                {options.showLabels && (
                  <text
                    x={ci * cellSize + cellSize / 2}
                    y={si * cellSize + cellSize / 2 + 4}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="heatmap-label"
                    fill={options.colorScale === "diverging" ? (value > (vMin + vMax) / 2 ? "#fff" : "#000") : "#fff"}
                  >
                    {value.toFixed(1)}
                  </text>
                )}
              </g>
            );
          })
        )}
        {/* Category labels */}
        {categories.map((c, i) => (
          <text key={i} x={i * cellSize + cellSize / 2} y={series.length * cellSize + 15} textAnchor="middle" className="heatmap-axis-label" fontSize={10}>
            {c}
          </text>
        ))}
        {/* Series labels */}
        {series.map((s, i) => (
          <text key={i} x={-10} y={i * cellSize + cellSize / 2 + 4} textAnchor="end" dominantBaseline="middle" className="heatmap-axis-label" fontSize={10}>
            {s}
          </text>
        ))}
      </g>
    );
  };

  // Render radar chart
  const renderRadar = () => {
    if (chartType !== "radar") return null;
    if (!component.categoryKey || !component.seriesKey || !component.valueKey) return null;

    const categories = Array.from(new Set(data.flatMap(ds => ds.data.map(d => String(d[component.categoryKey!])))));
    const seriesList = data.map(ds => ds.label);
    const maxValue = options.radarMax || Math.max(...data.flatMap(ds => ds.data.map(d => Number(d[component.valueKey!] ?? 0))));
    const levels = options.radarLevels || 5;
    const radius = Math.min(innerWidth, innerHeight) / 2 - 30;
    const cx = width / 2;
    const cy = height / 2;

    const getPoint = (value: number, angle: number) => ({
      x: cx + (value / maxValue) * radius * Math.cos(angle),
      y: cy + (value / maxValue) * radius * Math.sin(angle),
    });

    return (
      <g className="chart-radar">
        {/* Grid circles */}
        {Array.from({ length: levels }, (_, i) => i + 1).map(level => (
          <polygon
            key={level}
            points={categories.map((_, i) => {
              const angle = (i / categories.length) * 2 * Math.PI - Math.PI / 2;
              const r = (level / levels) * radius;
              return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
            }).join(" ")}
            fill="none"
            stroke="#e5e7eb"
            strokeWidth={1}
          />
        ))}
        {/* Axes */}
        {categories.map((cat, i) => {
          const angle = (i / categories.length) * 2 * Math.PI - Math.PI / 2;
          return (
            <g key={i}>
              <line x1={cx} y1={cy} x2={cx + radius * Math.cos(angle)} y2={cy + radius * Math.sin(angle)} stroke="#e5e7eb" strokeWidth={1} />
              <text x={cx + (radius + 20) * Math.cos(angle)} y={cy + (radius + 20) * Math.sin(angle) + 4} textAnchor="middle" className="radar-label" fontSize={10}>
                {cat}
              </text>
            </g>
          );
        })}
        {/* Series */}
        {data.map((ds, di) => {
          const points = categories.map((cat, ci) => {
            const point = ds.data.find(d => String(d[component.categoryKey!]) === cat);
            const value = point ? Number(point[component.valueKey!] ?? 0) : 0;
            const angle = (ci / categories.length) * 2 * Math.PI - Math.PI / 2;
            return getPoint(value, angle);
          });
          const color = ds.color || COLORS[di % COLORS.length];
          const pathData = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ") + " Z";

          return (
            <g key={di} className="radar-series">
              <path d={pathData} fill={color} fillOpacity={0.15} stroke={color} strokeWidth={2} />
              {points.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={4} fill={color} className="radar-point" />
              ))}
            </g>
          );
        })}
      </g>
    );
  };

  // Render waterfall chart
  const renderWaterfall = () => {
    if (chartType !== "waterfall") return null;
    if (!component.xKey || !component.valueKey) return null;

    const points = data[0]?.data || [];
    const startValue = options.startingValue || 0;
    let runningTotal = startValue;

    const waterfallData = points.map((d, i) => {
      const value = Number(d[component.valueKey!] ?? 0);
      const x = d[component.xKey!];
      const isTotal = i === points.length - 1 && String(x).toLowerCase().includes("total");
      const prevTotal = runningTotal;
      runningTotal += isTotal ? 0 : value;
      return {
        x,
        value,
        start: isTotal ? 0 : prevTotal,
        end: runningTotal,
        isTotal,
        isPositive: value >= 0,
      };
    });

    const maxVal = Math.max(...waterfallData.map(d => d.end), startValue);
    const minVal = Math.min(0, ...waterfallData.map(d => d.start), ...waterfallData.map(d => d.end));
    const barWidth = innerWidth / (waterfallData.length + 1);

    const yScale = (val: number) => MARGIN.top + innerHeight - (val - minVal) / (maxVal - minVal || 1) * innerHeight;
    const xScale = (i: number) => MARGIN.left + (i + 0.5) * barWidth;

    return (
      <g className="chart-waterfall">
        {waterfallData.map((d, i) => {
          const x = xScale(i);
          const yStart = yScale(d.start);
          const yEnd = yScale(d.end);
          const height = Math.abs(yEnd - yStart);
          const y = Math.min(yStart, yEnd);

          return (
            <g key={i} className="waterfall-bar">
              <rect
                x={x - barWidth * 0.4}
                y={y}
                width={barWidth * 0.8}
                height={height}
                fill={d.isTotal ? "#6b7280" : d.isPositive ? "#22c55e" : "#ef4444"}
                className="waterfall-rect"
              />
              {options.showConnectors && i > 0 && !d.isTotal && (
                <line
                  x1={x - barWidth * 0.4}
                  y1={yScale(waterfallData[i - 1].end)}
                  x2={x + barWidth * 0.4}
                  y2={yScale(d.start)}
                  stroke="#9ca3af"
                  strokeWidth={1}
                  strokeDasharray="4,4"
                />
              )}
              <text x={x} y={y - 5} textAnchor="middle" className="waterfall-value" fontSize={10}>
                {d.isTotal ? d.end.toLocaleString() : (d.isPositive ? "+" : "") + d.value.toLocaleString()}
              </text>
            </g>
          );
        })}
        {/* X axis labels */}
        {waterfallData.map((d, i) => (
          <text key={i} x={xScale(i)} y={MARGIN.top + innerHeight + 20} textAnchor="middle" className="waterfall-label" fontSize={10}>
            {String(d.x)}
          </text>
        ))}
      </g>
    );
  };

  // Render funnel chart
  const renderFunnel = () => {
    if (chartType !== "funnel") return null;
    if (!component.labelKey || !component.valueKey) return null;

    const points = data[0]?.data || [];
    const sortedPoints = options.sortByValue
      ? [...points].sort((a, b) => Number(b[component.valueKey!] ?? 0) - Number(a[component.labelKey!] ?? 0))
      : points;

    const maxValue = Math.max(...sortedPoints.map(d => Number(d[component.valueKey!] ?? 0)));
    const barHeight = innerHeight / (sortedPoints.length + 1);
    const gap = barHeight * 0.15;
    const barH = barHeight - gap;

    return (
      <g className="chart-funnel">
        {sortedPoints.map((d, i) => {
          const value = Number(d[component.valueKey!] ?? 0);
          const label = String(d[component.labelKey!] ?? `Step ${i + 1}`);
          const width = (value / maxValue) * innerWidth * 0.8;
          const x = MARGIN.left + (innerWidth - width) / 2;
          const y = MARGIN.top + i * barHeight + gap / 2;
          const nextWidth = i < sortedPoints.length - 1 ? (Number(sortedPoints[i + 1][component.valueKey!] ?? 0) / maxValue) * innerWidth * 0.8 : width;

          const pathData = [
            `M ${x} ${y}`,
            `L ${x + width} ${y}`,
            `L ${x + nextWidth} ${y + barH}`,
            `L ${x} ${y + barH}`,
            "Z",
          ].join(" ");

          const percentage = options.showPercentages ? ` (${((value / maxValue) * 100).toFixed(1)}%)` : "";

          return (
            <g key={i} className="funnel-step">
              <path d={pathData} fill={COLORS[i % COLORS.length]} stroke="#fff" strokeWidth={1} />
              <text x={MARGIN.left + innerWidth / 2} y={y + barH / 2 + 4} textAnchor="middle" className="funnel-label" fontSize={11} fill="#fff">
                {label}: {value.toLocaleString()}{percentage}
              </text>
            </g>
          );
        })}
      </g>
    );
  };

  // Render treemap (simplified - uses D3 if available)
  const renderTreemap = () => {
    if (chartType !== "treemap") return null;
    if (!component.labelKey || !component.valueKey) return null;
    if (!d3Loaded) return <text x={width/2} y={height/2} textAnchor="middle" className="loading">Loading D3...</text>;

    // Simplified treemap using squarify algorithm
    const points = data[0]?.data || [];
    const total = points.reduce((sum, d) => sum + Number(d[component.valueKey!] ?? 0), 0);
    const sortedPoints = [...points].sort((a, b) => Number(b[component.valueKey!] ?? 0) - Number(a[component.valueKey!] ?? 0));

    const padding = options.treemapPadding || 2;
    const layout = options.treemapLayout || "squarify";

    // Simple squarify implementation
    const rects: Array<{x: number, y: number, w: number, h: number, label: string, value: number, color: string}> = [];
    let row: Array<typeof rects[0]> = [];
    let rowX = MARGIN.left + padding;
    let rowY = MARGIN.top + padding;
    let rowW = 0;
    let rowH = 0;
    const availableWidth = innerWidth - padding * 2;
    const availableHeight = innerHeight - padding * 2;

    // Calculate total area and scale
    const totalArea = availableWidth * availableHeight;
    const areaPerUnit = totalArea / total;

    let currentX = MARGIN.left + padding;
    let currentY = MARGIN.top + padding;
    let currentRowHeight = 0;
    let currentRowWidth = 0;
    const rowItems: typeof rects = [];

    sortedPoints.forEach((d, i) => {
      const value = Number(d[component.valueKey!] ?? 0);
      const area = value * areaPerUnit;
      const aspectRatio = Math.sqrt(area);
      const w = aspectRatio;
      const h = aspectRatio;

      if (currentRowWidth + w > availableWidth && rowItems.length > 0) {
        // Start new row
        currentX = MARGIN.left + padding;
        currentY += currentRowHeight + padding;
        currentRowWidth = 0;
        currentRowHeight = 0;
        rowItems.length = 0;
      }

      rects.push({
        x: currentX,
        y: currentY,
        w: Math.max(w - padding * 2, 10),
        h: Math.max(h - padding * 2, 10),
        label: String(d[component.labelKey!] ?? `Item ${i}`),
        value,
        color: COLORS[i % COLORS.length],
      });

      currentX += w + padding;
      currentRowWidth += w + padding;
      currentRowHeight = Math.max(currentRowHeight, h);
      rowItems.push(rects[rects.length - 1]);
    });

    return (
      <g className="chart-treemap">
        {rects.map((r, i) => (
          <g key={i} className="treemap-node">
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={r.color} stroke="#fff" strokeWidth={1} />
            {r.w > 50 && r.h > 30 && (
              <>
                <text x={r.x + r.w / 2} y={r.y + r.h / 2 - 6} textAnchor="middle" className="treemap-label" fontSize={10} fill="#fff">
                  {r.label}
                </text>
                <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 10} textAnchor="middle" className="treemap-value" fontSize={9} fill="#fff" opacity={0.9}>
                  {r.value.toLocaleString()}
                </text>
              </>
            )}
          </g>
        ))}
      </g>
    );
  };

  // Render sankey diagram (simplified - uses D3 if available)
  const renderSankey = () => {
    if (chartType !== "sankey") return null;
    if (!component.sourceKey || !component.targetKey || !component.weightKey) return null;
    if (!d3Loaded) return <text x={width/2} y={height/2} textAnchor="middle" className="loading">Loading D3...</text>;

    // Simplified sankey - just show nodes and links
    const links = data[0]?.data || [];
    const nodes = new Map<string, {name: string, value: number, x: number, y: number}>();

    links.forEach((d, i) => {
      const source = String(d[component.sourceKey!]);
      const target = String(d[component.targetKey!]);
      const weight = Number(d[component.weightKey!] ?? 0);

      if (!nodes.has(source)) nodes.set(source, { name: source, value: 0, x: 0, y: 0 });
      if (!nodes.has(target)) nodes.set(target, { name: target, value: 0, x: 0, y: 0 });

      nodes.get(source)!.value += weight;
      nodes.get(target)!.value += weight;
    });

    const nodeList = Array.from(nodes.entries());
    const nodeWidth = options.nodeWidth || 20;
    const nodePadding = options.nodePadding || 10;

    // Position nodes: sources on left, targets on right
    const sources = nodeList.filter(([_, n]) => links.some(l => String(l[component.sourceKey!]) === n.name));
    const targets = nodeList.filter(([_, n]) => links.some(l => String(l[component.targetKey!]) === n.name));

    let y = MARGIN.top + 50;
    sources.forEach(([id, node]) => {
      node.x = MARGIN.left;
      node.y = y;
      y += nodePadding + 30;
    });

    y = MARGIN.top + 50;
    targets.forEach(([id, node]) => {
      if (node.x === 0) { // not already positioned
        node.x = width - MARGIN.right - nodeWidth;
        node.y = y;
        y += nodePadding + 30;
      }
    });

    return (
      <g className="chart-sankey">
        {/* Links */}
        {links.map((d, i) => {
          const source = String(d[component.sourceKey!]);
          const target = String(d[component.targetKey!]);
          const weight = Number(d[component.weightKey!] ?? 0);
          const sNode = nodes.get(source);
          const tNode = nodes.get(target);
          if (!sNode || !tNode) return null;

          const sy = sNode.y + 15;
          const ty = tNode.y + 15;
          const thickness = Math.max(2, weight / Math.max(...links.map(l => Number(l[component.weightKey!] ?? 1))) * 30);

          return (
            <path
              key={i}
              d={`M ${sNode.x + nodeWidth} ${sy} C ${sNode.x + nodeWidth + 50} ${sy}, ${tNode.x - 50} ${ty}, ${tNode.x} ${ty}`}
              fill="none"
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={thickness}
              strokeLinecap="round"
              opacity={0.6}
              className="sankey-link"
            />
          );
        })}
        {/* Nodes */}
        {nodeList.map(([id, node]) => (
          <g key={id} className="sankey-node">
            <rect x={node.x} y={node.y} width={nodeWidth} height={30} fill={COLORS[nodeList.indexOf([id, node]) % COLORS.length]} rx={3} />
            <text x={node.x + nodeWidth / 2} y={node.y + 19} textAnchor="middle" className="sankey-label" fontSize={10} fill="#fff">
              {node.name}
            </text>
            <text x={node.x + nodeWidth / 2} y={node.y + 35} textAnchor="middle" className="sankey-value" fontSize={9} fill="#6b7280">
              {node.value.toLocaleString()}
            </text>
          </g>
        ))}
      </g>
    );
  };

  // Render network graph (simplified - uses D3 if available)
  const renderNetworkGraph = () => {
    if (chartType !== "network_graph") return null;
    if (!component.nodeIdKey || !component.linkSourceKey || !component.linkTargetKey) return null;
    if (!d3Loaded) return <text x={width/2} y={height/2} textAnchor="middle" className="loading">Loading D3...</text>;

    // Simple force-directed layout simulation
    const nodes = data.flatMap(ds => ds.data).filter(d => d[component.nodeIdKey!]);
    const links = data.flatMap(ds => ds.data).filter(d => d[component.linkSourceKey!] && d[component.linkTargetKey!]);

    // Simple circular layout for now
    const nodeList = Array.from(new Map(nodes.map(n => [String(n[component.nodeIdKey!]), n])).values());
    const radius = Math.min(innerWidth, innerHeight) / 2 - 40;
    const cx = width / 2;
    const cy = height / 2;

    const positionedNodes = nodeList.map((n, i) => {
      const angle = (i / nodeList.length) * 2 * Math.PI;
      return {
        id: String(n[component.nodeIdKey!]),
        label: String(n[component.nodeLabelKey!] ?? n[component.nodeIdKey!]),
        group: String(n[component.nodeGroupKey!] ?? "default"),
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      };
    });

    const linkDistance = options.linkDistance || 100;

    return (
      <g className="chart-network-graph">
        {/* Links */}
        {links.map((l, i) => {
          const sourceId = String(l[component.linkSourceKey!]);
          const targetId = String(l[component.linkTargetKey!]);
          const source = positionedNodes.find(n => n.id === sourceId);
          const target = positionedNodes.find(n => n.id === targetId);
          if (!source || !target) return null;

          return (
            <line
              key={i}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke="#9ca3af"
              strokeWidth={1}
              opacity={0.5}
              className="network-link"
            />
          );
        })}
        {/* Nodes */}
        {positionedNodes.map((n, i) => (
          <g key={n.id} className="network-node">
            <circle
              cx={n.x}
              cy={n.y}
              r={15}
              fill={COLORS[i % COLORS.length]}
              stroke="#fff"
              strokeWidth={2}
            />
            <text x={n.x} y={n.y + 4} textAnchor="middle" className="network-label" fontSize={9} fill="#fff">
              {n.label.length > 10 ? n.label.substring(0, 8) + ".." : n.label}
            </text>
          </g>
        ))}
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
          {renderHeatmap()}
          {renderRadar()}
          {renderWaterfall()}
          {renderFunnel()}
          {renderTreemap()}
          {renderSankey()}
          {renderNetworkGraph()}
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