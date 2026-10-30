// ---------------------------------------------------------------------------
// Live Widget Renderer — Real-time information display
// ---------------------------------------------------------------------------
//
// Renders live widgets: weather, currency, stocks, sports, news, crypto,
// world clock, countdown. All data fetched via /api/live/* endpoints.
//
// ---------------------------------------------------------------------------

import React, { useEffect, useState } from "react";
import { LiveWidgetComponent, LiveWidgetType, LiveWidgetData, LiveWidgetConfig } from "../../lib/interactive-types";
import { REFRESH_INTERVALS, RefreshInterval } from "../../lib/live-widgets";
import { RendererProps } from "../../lib/interactive-renderer";

import {
  CloudSun,
  CloudRain,
  CloudSnow,
  Cloud,
  Sun,
  Wind,
  Droplets,
  DollarSign,
  TrendingUp,
  TrendingDown,
  Trophy,
  Newspaper,
  Bitcoin,
  Clock,
  Timer,
  RefreshCw,
  Loader2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  MapPin,
  Thermometer,
  BarChart2,
  Zap,
} from "lucide-react";

interface LiveWidgetRendererProps extends RendererProps {
  component: LiveWidgetComponent;
}

const WEATHER_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "01d": Sun,
  "01n": Sun,
  "02d": CloudSun,
  "02n": CloudSun,
  "03d": Cloud,
  "03n": Cloud,
  "04d": Cloud,
  "04n": Cloud,
  "09d": CloudRain,
  "09n": CloudRain,
  "10d": CloudRain,
  "10n": CloudRain,
  "11d": Zap,
  "11n": Zap,
  "13d": CloudSnow,
  "13n": CloudSnow,
  "50d": Cloud,
  "50n": Cloud,
};

function WeatherWidget({ data, config, loading, error, lastUpdated, onRefresh }: {
  data: LiveWidgetData | undefined;
  config: LiveWidgetConfig;
  loading: boolean;
  error: string | undefined;
  lastUpdated: number | undefined;
  onRefresh: () => void;
}) {
  if (loading) return <div className="widget-loading"><Loader2 className="spin" size={24} /><span>Loading weather...</span></div>;
  if (error) return <div className="widget-error"><AlertTriangle size={24} /><span>{error}</span></div>;
  if (!data) return <div className="widget-empty">No weather data</div>;

  const Icon = data.icon ? WEATHER_ICONS[data.icon] || Cloud : Cloud;
  const temp = data.temperature !== null ? `${Math.round(data.temperature)}°${config.units === "imperial" ? "F" : "C"}` : "—";
  const condition = data.condition || "—";
  const humidity = data.humidity !== null ? `${data.humidity}%` : "—";
  const wind = data.windSpeed !== null ? `${data.windSpeed} ${config.units === "imperial" ? "mph" : "m/s"}` : "—";

  return (
    <div className="live-widget weather-widget">
      <div className="widget-header">
        <div className="widget-title-row">
          <MapPin size={16} />
          <span className="widget-title">{config.location || "Weather"}</span>
        </div>
        <button onClick={onRefresh} className="refresh-btn" aria-label="Refresh" disabled={loading}>
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>

      <div className="weather-main">
        <Icon size={64} className="weather-icon" />
        <div className="weather-temp">{temp}</div>
        <div className="weather-condition">{condition}</div>
      </div>

      <div className="weather-details">
        <div className="detail"><Droplets size={16} /><span>Humidity: {humidity}</span></div>
        <div className="detail"><Wind size={16} /><span>Wind: {wind}</span></div>
      </div>

      {data.forecast && data.forecast.length > 0 && (
        <div className="weather-forecast">
          {data.forecast.slice(0, 5).map((day, i) => {
            const Icon = day.icon ? WEATHER_ICONS[day.icon] || Cloud : Cloud;
            return (
              <div key={i} className="forecast-day">
                <span>{day.date}</span>
                <Icon size={20} />
                <span>{day.condition}</span>
                <span>{Math.round(day.high)}°/{Math.round(day.low)}°</span>
              </div>
            );
          })}
        </div>
      )}

      {lastUpdated && (
        <div className="widget-timestamp">Updated {new Date(lastUpdated).toLocaleTimeString()}</div>
      )}
    </div>
  );
}

function CurrencyWidget({ data, config, loading, error, lastUpdated, onRefresh }: {
  data: LiveWidgetData | undefined;
  config: LiveWidgetConfig;
  loading: boolean;
  error: string | undefined;
  lastUpdated: number | undefined;
  onRefresh: () => void;
}) {
  if (loading) return <div className="widget-loading"><Loader2 className="spin" size={24} /><span>Loading rates...</span></div>;
  if (error) return <div className="widget-error"><AlertTriangle size={24} /><span>{error}</span></div>;
  if (!data) return <div className="widget-empty">No currency data</div>;

  const rate = data.rate !== null ? data.rate.toFixed(4) : "—";
  const converted = data.convertedAmount !== null ? data.convertedAmount.toFixed(2) : "—";
  const from = data.fromCurrency || config.fromCurrency || "USD";
  const to = data.toCurrency || config.toCurrency || "EUR";

  return (
    <div className="live-widget currency-widget">
      <div className="widget-header">
        <div className="widget-title-row">
          <DollarSign size={16} />
          <span className="widget-title">Currency Converter</span>
        </div>
        <button onClick={onRefresh} className="refresh-btn" aria-label="Refresh" disabled={loading}>
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>

      <div className="currency-main">
        <div className="currency-pair">
          <span className="currency-from">{from}</span>
          <span className="currency-arrow">→</span>
          <span className="currency-to">{to}</span>
        </div>
        <div className="currency-rate">1 {from} = {rate} {to}</div>
        {config.amount && config.amount !== 1 && (
          <div className="currency-converted">
            {config.amount} {from} = <strong>{converted} {to}</strong>
          </div>
        )}
      </div>

      {data.history && data.history.length > 0 && (
        <div className="currency-history">
          <span className="history-label">Recent rates:</span>
          <div className="history-sparkline">
            {data.history.slice(-7).map((point, i) => (
              <div key={i} className="spark-point" style={{ height: `${(point.rate / Math.max(...data.history!.slice(-7).map(h => h.rate))) * 100}%` }} />
            ))}
          </div>
        </div>
      )}

      {lastUpdated && <div className="widget-timestamp">Updated {new Date(lastUpdated).toLocaleTimeString()}</div>}
    </div>
  );
}

function StocksWidget({ data, config, loading, error, lastUpdated, onRefresh }: {
  data: LiveWidgetData | undefined;
  config: LiveWidgetConfig;
  loading: boolean;
  error: string | undefined;
  lastUpdated: number | undefined;
  onRefresh: () => void;
}) {
  if (loading) return <div className="widget-loading"><Loader2 className="spin" size={24} /><span>Loading stocks...</span></div>;
  if (error) return <div className="widget-error"><AlertTriangle size={24} /><span>{error}</span></div>;
  if (!data?.quotes?.length) return <div className="widget-empty">No stock data</div>;

  return (
    <div className="live-widget stocks-widget">
      <div className="widget-header">
        <div className="widget-title-row">
          <TrendingUp size={16} />
          <span className="widget-title">Stock Ticker</span>
        </div>
        <button onClick={onRefresh} className="refresh-btn" aria-label="Refresh" disabled={loading}>
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>

      <div className="stocks-list">
        {data.quotes.map((quote, i) => (
          <div key={i} className="stock-row">
            <div className="stock-info">
              <span className="stock-symbol">{quote.symbol}</span>
              <span className="stock-price">${quote.price.toFixed(2)}</span>
            </div>
            <div className={`stock-change ${quote.change >= 0 ? "positive" : "negative"}`}>
              {quote.change >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
              <span>{quote.change >= 0 ? "+" : ""}{quote.change.toFixed(2)} ({quote.changePercent >= 0 ? "+" : ""}{quote.changePercent.toFixed(2)}%)</span>
            </div>
          </div>
        ))}
      </div>

      {lastUpdated && <div className="widget-timestamp">Updated {new Date(lastUpdated).toLocaleTimeString()}</div>}
    </div>
  );
}

function SportsWidget({ data, config, loading, error, lastUpdated, onRefresh }: {
  data: LiveWidgetData | undefined;
  config: LiveWidgetConfig;
  loading: boolean;
  error: string | undefined;
  lastUpdated: number | undefined;
  onRefresh: () => void;
}) {
  if (loading) return <div className="widget-loading"><Loader2 className="spin" size={24} /><span>Loading scores...</span></div>;
  if (error) return <div className="widget-error"><AlertTriangle size={24} /><span>{error}</span></div>;
  if (!data?.games?.length) return <div className="widget-empty">No games found</div>;

  return (
    <div className="live-widget sports-widget">
      <div className="widget-header">
        <div className="widget-title-row">
          <Trophy size={16} />
          <span className="widget-title">{config.league?.toUpperCase() || "Sports"}</span>
          {config.date && <span className="widget-date">{config.date}</span>}
        </div>
        <button onClick={onRefresh} className="refresh-btn" aria-label="Refresh" disabled={loading}>
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>

      <div className="games-list">
        {data.games.map((game, i) => (
          <div key={i} className="game-row">
            <div className="teams">
              <div className="team away">
                <span>{game.awayTeam}</span>
                {game.awayScore !== null && <span className="score">{game.awayScore}</span>}
              </div>
              <div className="team home">
                <span>{game.homeTeam}</span>
                {game.homeScore !== null && <span className="score">{game.homeScore}</span>}
              </div>
            </div>
            <div className="game-status">{game.status} {game.time ? `• ${game.time}` : ""}</div>
          </div>
        ))}
      </div>

      {lastUpdated && <div className="widget-timestamp">Updated {new Date(lastUpdated).toLocaleTimeString()}</div>}
    </div>
  );
}

function NewsWidget({ data, config, loading, error, lastUpdated, onRefresh }: {
  data: LiveWidgetData | undefined;
  config: LiveWidgetConfig;
  loading: boolean;
  error: string | undefined;
  lastUpdated: number | undefined;
  onRefresh: () => void;
}) {
  if (loading) return <div className="widget-loading"><Loader2 className="spin" size={24} /><span>Loading news...</span></div>;
  if (error) return <div className="widget-error"><AlertTriangle size={24} /><span>{error}</span></div>;
  if (!data?.articles?.length) return <div className="widget-empty">No articles found</div>;

  return (
    <div className="live-widget news-widget">
      <div className="widget-header">
        <div className="widget-title-row">
          <Newspaper size={16} />
          <span className="widget-title">{config.category?.charAt(0).toUpperCase() + config.category?.slice(1) || "News"}</span>
        </div>
        <button onClick={onRefresh} className="refresh-btn" aria-label="Refresh" disabled={loading}>
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>

      <div className="articles-list">
        {data.articles.slice(0, config.layout === "compact" ? 3 : 5).map((article, i) => (
          <div key={i} className="article-item">
            <a href={article.url} target="_blank" rel="noopener noreferrer" className="article-link">
              <h4 className="article-title">{article.title}</h4>
              {article.description && <p className="article-description">{article.description}</p>}
              <div className="article-meta">
                <span>{article.source}</span>
                <span>{new Date(article.publishedAt).toLocaleDateString()}</span>
              </div>
            </a>
          </div>
        ))}
      </div>

      {lastUpdated && <div className="widget-timestamp">Updated {new Date(lastUpdated).toLocaleTimeString()}</div>}
    </div>
  );
}

function CryptoWidget({ data, config, loading, error, lastUpdated, onRefresh }: {
  data: LiveWidgetData | undefined;
  config: LiveWidgetConfig;
  loading: boolean;
  error: string | undefined;
  lastUpdated: number | undefined;
  onRefresh: () => void;
}) {
  if (loading) return <div className="widget-loading"><Loader2 className="spin" size={24} /><span>Loading crypto...</span></div>;
  if (error) return <div className="widget-error"><AlertTriangle size={24} /><span>{error}</span></div>;
  if (!data?.prices?.length) return <div className="widget-empty">No crypto data</div>;

  return (
    <div className="live-widget crypto-widget">
      <div className="widget-header">
        <div className="widget-title-row">
          <Bitcoin size={16} />
          <span className="widget-title">Crypto Prices</span>
        </div>
        <button onClick={onRefresh} className="refresh-btn" aria-label="Refresh" disabled={loading}>
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>

      <div className="crypto-list">
        {data.prices.map((coin, i) => (
          <div key={i} className="crypto-row">
            <div className="crypto-info">
              <span className="crypto-symbol">{coin.symbol.toUpperCase()}</span>
              <span className="crypto-name">{coin.name}</span>
            </div>
            <div className={`crypto-price ${coin.changePercent24h >= 0 ? "positive" : "negative"}`}>
              ${coin.price.toLocaleString()}
              <span className="change-pct">{coin.changePercent24h >= 0 ? "+" : ""}{coin.changePercent24h.toFixed(2)}%</span>
            </div>
          </div>
        ))}
      </div>

      {lastUpdated && <div className="widget-timestamp">Updated {new Date(lastUpdated).toLocaleTimeString()}</div>}
    </div>
  );
}

function WorldClockWidget({ data, config, loading, error, lastUpdated, onRefresh }: {
  data: LiveWidgetData | undefined;
  config: LiveWidgetConfig;
  loading: boolean;
  error: string | undefined;
  lastUpdated: number | undefined;
  onRefresh: () => void;
}) {
  if (loading) return <div className="widget-loading"><Loader2 className="spin" size={24} /><span>Loading clocks...</span></div>;
  if (error) return <div className="widget-error"><AlertTriangle size={24} /><span>{error}</span></div>;
  if (!data?.clocks?.length) return <div className="widget-empty">No clock data</div>;

  return (
    <div className="live-widget clock-widget">
      <div className="widget-header">
        <div className="widget-title-row">
          <Clock size={16} />
          <span className="widget-title">World Clock</span>
        </div>
        <button onClick={onRefresh} className="refresh-btn" aria-label="Refresh" disabled={loading}>
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>

      <div className="clocks-list">
        {data.clocks.map((clock, i) => (
          <div key={i} className="clock-row">
            <div className="clock-info">
              <span className="clock-timezone">{clock.timezone}</span>
              <span className="clock-date">{clock.date}</span>
            </div>
            <div className="clock-time">{clock.time}</div>
          </div>
        ))}
      </div>

      {lastUpdated && <div className="widget-timestamp">Updated {new Date(lastUpdated).toLocaleTimeString()}</div>}
    </div>
  );
}

function CountdownWidget({ data, config, loading, error, lastUpdated, onRefresh }: {
  data: LiveWidgetData | undefined;
  config: LiveWidgetConfig;
  loading: boolean;
  error: string | undefined;
  lastUpdated: number | undefined;
  onRefresh: () => void;
}) {
  if (loading) return <div className="widget-loading"><Loader2 className="spin" size={24} /><span>Loading countdown...</span></div>;
  if (error) return <div className="widget-error"><AlertTriangle size={24} /><span>{error}</span></div>;
  if (!data || (data.days === undefined && data.hours === undefined)) return <div className="widget-empty">No countdown data</div>;

  const expired = data.expired === true;

  return (
    <div className={`live-widget countdown-widget ${expired ? "expired" : ""}`}>
      <div className="widget-header">
        <div className="widget-title-row">
          <Timer size={16} />
          <span className="widget-title">{config.label || "Countdown"}</span>
        </div>
        <button onClick={onRefresh} className="refresh-btn" aria-label="Refresh" disabled={loading}>
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>

      {!expired && (
        <div className="countdown-display">
          {data.days !== undefined && data.days > 0 && (
            <div className="countdown-unit">
              <span className="countdown-value">{data.days}</span>
              <span className="countdown-label">Days</span>
            </div>
          )}
          <div className="countdown-unit">
            <span className="countdown-value">{String(data.hours || 0).padStart(2, "0")}</span>
            <span className="countdown-label">Hours</span>
          </div>
          <div className="countdown-unit">
            <span className="countdown-value">{String(data.minutes || 0).padStart(2, "0")}</span>
            <span className="countdown-label">Minutes</span>
          </div>
          <div className="countdown-unit">
            <span className="countdown-value">{String(data.seconds || 0).padStart(2, "0")}</span>
            <span className="countdown-label">Seconds</span>
          </div>
        </div>
      )}

      {expired && (
        <div className="countdown-expired">
          <Timer size={48} />
          <span>{config.label || "Countdown"} has ended!</span>
        </div>
      )}

      {data.targetDate && <div className="countdown-target">Until {new Date(data.targetDate).toLocaleString()}</div>}
    </div>
  );
}

const WIDGET_RENDERERS: Record<LiveWidgetType, React.ComponentType<{
  data: LiveWidgetData | undefined;
  config: LiveWidgetConfig;
  loading: boolean;
  error: string | undefined;
  lastUpdated: number | undefined;
  onRefresh: () => void;
}>> = {
  weather: WeatherWidget,
  currency: CurrencyWidget,
  stocks: StocksWidget,
  sports: SportsWidget,
  news: NewsWidget,
  crypto: CryptoWidget,
  world_clock: WorldClockWidget,
  countdown: CountdownWidget,
};

export default function LiveWidgetRenderer({ component, instanceId, onUpdate, className }: LiveWidgetRendererProps) {
  const [data, setData] = useState<LiveWidgetData | undefined>(component.data);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(component.error);
  const [lastUpdated, setLastUpdated] = useState<number | undefined>(component.lastUpdated);

  const { fetchWeather, fetchCurrency, fetchStocks, fetchSports, fetchNews, fetchCrypto, fetchWorldClock, fetchCountdown } = require("../../lib/live-widgets");

  const fetchData = async () => {
    setLoading(true);
    setError(undefined);
    try {
      let result: LiveWidgetData | null = null;
      switch (component.widgetType) {
        case "weather": result = await fetchWeather(component.config); break;
        case "currency": result = await fetchCurrency(component.config); break;
        case "stocks": result = await fetchStocks(component.config); break;
        case "sports": result = await fetchSports(component.config); break;
        case "news": result = await fetchNews(component.config); break;
        case "crypto": result = await fetchCrypto(component.config); break;
        case "world_clock": result = await fetchWorldClock(component.config); break;
        case "countdown": result = await fetchCountdown(component.config); break;
      }
      if (result) {
        setData(result);
        setLastUpdated(Date.now());
        onUpdate?.(instanceId, { data: result, lastUpdated: Date.now() });
      }
      if (result?.error) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();

    const interval = REFRESH_INTERVALS[component.config.refreshInterval || "manual"];
    if (interval > 0) {
      const timer = setInterval(fetchData, interval);
      return () => clearInterval(timer);
    }
  }, [component.widgetType, component.config.refreshInterval]);

  const WidgetComponent = WIDGET_RENDERERS[component.widgetType];
  if (!WidgetComponent) {
    return <div className="widget-error">Unknown widget type: {component.widgetType}</div>;
  }

  return (
    <div className={`live-widget-container ${className || ""}`} data-widget-type={component.widgetType} data-instance-id={instanceId}>
      <WidgetComponent
        data={data}
        config={component.config}
        loading={loading}
        error={error}
        lastUpdated={lastUpdated}
        onRefresh={fetchData}
      />
    </div>
  );
}