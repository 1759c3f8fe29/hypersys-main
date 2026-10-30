// ---------------------------------------------------------------------------
// Live Information Widgets — Real-time data display engine
// ---------------------------------------------------------------------------
//
// Widget engine with data fetchers for:
// - Weather (OpenWeatherMap via /api/live/weather)
// - Currency converter (exchangerate-api.com via /api/live/currency)
// - Stock ticker (Yahoo Finance via /api/live/stocks)
// - Sports scores (free sports API via /api/live/sports)
// - News headlines (NewsAPI via /api/live/news)
// - Crypto prices (CoinGecko via /api/live/crypto)
// - World clock / timezone display
// - Countdown timers
//
// All API calls are proxied through existing /api routes (no direct browser-to-API).
// Respects rate limits with client-side caching and graceful degradation.
//
// ---------------------------------------------------------------------------

import type { LiveWidgetComponent, LiveWidgetType, LiveWidgetConfig, LiveWidgetData } from "./interactive-types";

/** Cache entry with timestamp and TTL */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

/** In-memory cache for client-side rate limiting */
class WidgetCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private maxSize = 100;

  /** Generate cache key from widget type and config */
  private makeKey(type: LiveWidgetType, config: LiveWidgetConfig): string {
    return `${type}:${JSON.stringify(config)}`;
  }

  /** Get cached data if still valid */
  get<T>(type: LiveWidgetType, config: LiveWidgetConfig): T | null {
    const key = this.makeKey(type, config);
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > entry.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  /** Store data in cache with TTL */
  set<T>(type: LiveWidgetType, config: LiveWidgetConfig, data: T, ttl: number): void {
    if (this.cache.size >= this.maxSize) {
      // Remove oldest entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    const key = this.makeKey(type, config);
    this.cache.set(key, { data, timestamp: Date.now(), ttl });
  }

  /** Clear cache for a specific widget type */
  clearType(type: LiveWidgetType): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${type}:`)) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear all cache */
  clear(): void {
    this.cache.clear();
  }
}

export const widgetCache = new WidgetCache();

/** Refresh interval options in milliseconds */
export const REFRESH_INTERVALS = {
  manual: 0,
  "30s": 30_000,
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
} as const;

export type RefreshInterval = keyof typeof REFRESH_INTERVALS;

/** Default cache TTLs per widget type (in ms) */
const DEFAULT_TTLS: Record<LiveWidgetType, number> = {
  weather: 600_000,       // 10 minutes
  currency: 300_000,      // 5 minutes
  stocks: 60_000,         // 1 minute
  sports: 120_000,        // 2 minutes
  news: 300_000,          // 5 minutes
  crypto: 60_000,         // 1 minute
  world_clock: 0,         // No caching for clocks
  countdown: 0,           // No caching for countdowns
};

/** Fetch with timeout and error handling */
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = 10_000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/** Base API URL - uses relative paths for same-origin */
const API_BASE = "/api/live";

/** Generic fetch wrapper with error handling */
async function apiFetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<{ data: T | null; error: string | null }> {
  const searchParams = new URLSearchParams(params);
  const url = `${API_BASE}/${endpoint}?${searchParams}`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      return { data: null, error: errorData.error || `HTTP ${res.status}` };
    }

    const data = await res.json();
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : "Network error" };
  }
}

/** Weather widget data fetcher */
export async function fetchWeather(config: LiveWidgetConfig): Promise<LiveWidgetData | null> {
  const cached = widgetCache.get<LiveWidgetData>("weather", config);
  if (cached) return cached;

  const { data, error } = await apiFetch<LiveWidgetData>("weather", {
    location: config.location || "",
    units: config.units || "metric",
  });

  if (error) {
    console.warn("[live-widgets] Weather fetch failed:", error);
    return { error, temperature: null, condition: null, humidity: null, windSpeed: null, icon: null };
  }

  if (data) {
    widgetCache.set("weather", config, data, DEFAULT_TTLS.weather);
  }
  return data;
}

/** Currency converter widget data fetcher */
export async function fetchCurrency(config: LiveWidgetConfig): Promise<LiveWidgetData | null> {
  const cached = widgetCache.get<LiveWidgetData>("currency", config);
  if (cached) return cached;

  const { data, error } = await apiFetch<LiveWidgetData>("currency", {
    from: config.fromCurrency || "USD",
    to: config.toCurrency || "EUR",
    amount: String(config.amount || 1),
  });

  if (error) {
    console.warn("[live-widgets] Currency fetch failed:", error);
    return { error, fromCurrency: config.fromCurrency, toCurrency: config.toCurrency, rate: null, convertedAmount: null };
  }

  if (data) {
    widgetCache.set("currency", config, data, DEFAULT_TTLS.currency);
  }
  return data;
}

/** Stock ticker widget data fetcher */
export async function fetchStocks(config: LiveWidgetConfig): Promise<LiveWidgetData | null> {
  const cached = widgetCache.get<LiveWidgetData>("stocks", config);
  if (cached) return cached;

  const symbols = Array.isArray(config.symbols) ? config.symbols.join(",") : (config.symbols || "AAPL,GOOGL,MSFT");

  const { data, error } = await apiFetch<LiveWidgetData>("stocks", {
    symbols,
  });

  if (error) {
    console.warn("[live-widgets] Stocks fetch failed:", error);
    return { error, symbols: config.symbols, quotes: [] };
  }

  if (data) {
    widgetCache.set("stocks", config, data, DEFAULT_TTLS.stocks);
  }
  return data;
}

/** Sports scores widget data fetcher */
export async function fetchSports(config: LiveWidgetConfig): Promise<LiveWidgetData | null> {
  const cached = widgetCache.get<LiveWidgetData>("sports", config);
  if (cached) return cached;

  const { data, error } = await apiFetch<LiveWidgetData>("sports", {
    league: config.league || "nba",
    date: config.date || new Date().toISOString().split("T")[0],
  });

  if (error) {
    console.warn("[live-widgets] Sports fetch failed:", error);
    return { error, league: config.league, games: [] };
  }

  if (data) {
    widgetCache.set("sports", config, data, DEFAULT_TTLS.sports);
  }
  return data;
}

/** News headlines widget data fetcher */
export async function fetchNews(config: LiveWidgetConfig): Promise<LiveWidgetData | null> {
  const cached = widgetCache.get<LiveWidgetData>("news", config);
  if (cached) return cached;

  const { data, error } = await apiFetch<LiveWidgetData>("news", {
    category: config.category || "general",
    country: config.country || "us",
    limit: String(config.limit || 10),
  });

  if (error) {
    console.warn("[live-widgets] News fetch failed:", error);
    return { error, category: config.category, articles: [] };
  }

  if (data) {
    widgetCache.set("news", config, data, DEFAULT_TTLS.news);
  }
  return data;
}

/** Crypto prices widget data fetcher */
export async function fetchCrypto(config: LiveWidgetConfig): Promise<LiveWidgetData | null> {
  const cached = widgetCache.get<LiveWidgetData>("crypto", config);
  if (cached) return cached;

  const coins = Array.isArray(config.coins) ? config.coins.join(",") : (config.coins || "bitcoin,ethereum,solana");
  const vsCurrency = config.vsCurrency || "usd";

  const { data, error } = await apiFetch<LiveWidgetData>("crypto", {
    coins,
    vs_currency: vsCurrency,
  });

  if (error) {
    console.warn("[live-widgets] Crypto fetch failed:", error);
    return { error, coins: config.coins, prices: [] };
  }

  if (data) {
    widgetCache.set("crypto", config, data, DEFAULT_TTLS.crypto);
  }
  return data;
}

/** World clock widget data fetcher (computed client-side) */
export function fetchWorldClock(config: LiveWidgetConfig): LiveWidgetData {
  const timezones = Array.isArray(config.timezones) ? config.timezones : (config.timezones ? [config.timezones] : ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"]);

  const clocks = timezones.map(tz => {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: config.format === "12h",
        timeZoneName: "short",
      });
      const dateFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      return {
        timezone: tz,
        time: formatter.format(now),
        date: dateFormatter.format(now),
        offset: getTimezoneOffset(tz),
      };
    } catch {
      return {
        timezone: tz,
        time: "Invalid TZ",
        date: "",
        offset: 0,
      };
    }
  });

  return { clocks };
}

/** Get timezone offset in hours */
function getTimezoneOffset(timezone: string): number {
  try {
    const now = new Date();
    const utc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
    const tz = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
    return (tz.getTime() - utc.getTime()) / 3_600_000;
  } catch {
    return 0;
  }
}

/** Countdown timer widget data (computed client-side) */
export function fetchCountdown(config: LiveWidgetConfig): LiveWidgetData {
  const target = config.targetDate ? new Date(config.targetDate).getTime() : 0;
  const now = Date.now();
  const diff = target - now;

  if (diff <= 0) {
    return { expired: true, days: 0, hours: 0, minutes: 0, seconds: 0, label: config.label || "Countdown" };
  }

  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1000);

  return { expired: false, days, hours, minutes, seconds, label: config.label || "Countdown", targetDate: config.targetDate };
}

/** Main fetcher dispatcher */
export async function fetchWidgetData(type: LiveWidgetType, config: LiveWidgetConfig): Promise<LiveWidgetData | null> {
  switch (type) {
    case "weather":
      return fetchWeather(config);
    case "currency":
      return fetchCurrency(config);
    case "stocks":
      return fetchStocks(config);
    case "sports":
      return fetchSports(config);
    case "news":
      return fetchNews(config);
    case "crypto":
      return fetchCrypto(config);
    case "world_clock":
      return fetchWorldClock(config);
    case "countdown":
      return fetchCountdown(config);
    default:
      return { error: `Unknown widget type: ${type}` };
  }
}

/** Default configurations for each widget type */
export const WIDGET_DEFAULTS: Record<LiveWidgetType, Partial<LiveWidgetConfig>> = {
  weather: { units: "metric", refreshInterval: "15m" },
  currency: { fromCurrency: "USD", toCurrency: "EUR", amount: 1, refreshInterval: "5m" },
  stocks: { symbols: ["AAPL", "GOOGL", "MSFT", "TSLA", "NVDA"], refreshInterval: "1m" },
  sports: { league: "nba", refreshInterval: "5m" },
  news: { category: "general", country: "us", limit: 10, refreshInterval: "5m" },
  crypto: { coins: ["bitcoin", "ethereum", "solana"], vsCurrency: "usd", refreshInterval: "1m" },
  world_clock: { timezones: ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"], format: "24h", refreshInterval: "30s" },
  countdown: { refreshInterval: "30s" },
};

/** Widget metadata for UI */
export const WIDGET_METADATA: Record<LiveWidgetType, { name: string; description: string; icon: string; requiresConfig: string[] }> = {
  weather: {
    name: "Weather",
    description: "Current conditions and forecast for any location",
    icon: "☀️",
    requiresConfig: ["location"]
  },
  currency: {
    name: "Currency Converter",
    description: "Live exchange rates between currencies",
    icon: "💱",
    requiresConfig: ["fromCurrency", "toCurrency"]
  },
  stocks: {
    name: "Stock Ticker",
    description: "Real-time stock prices and changes",
    icon: "📈",
    requiresConfig: ["symbols"]
  },
  sports: {
    name: "Sports Scores",
    description: "Live scores and game status",
    icon: "⚽",
    requiresConfig: ["league"]
  },
  news: {
    name: "News Headlines",
    description: "Latest news from around the world",
    icon: "📰",
    requiresConfig: ["category"]
  },
  crypto: {
    name: "Crypto Prices",
    description: "Live cryptocurrency prices",
    icon: "₿",
    requiresConfig: ["coins"]
  },
  world_clock: {
    name: "World Clock",
    description: "Current time across timezones",
    icon: "🌍",
    requiresConfig: ["timezones"]
  },
  countdown: {
    name: "Countdown Timer",
    description: "Time remaining until a target date",
    icon: "⏱️",
    requiresConfig: ["targetDate"]
  },
};

/** Layout variants */
export type WidgetLayout = "compact" | "detailed" | "dashboard";

/** Layout-specific field visibility */
export const LAYOUT_FIELDS: Record<WidgetLayout, Record<LiveWidgetType, string[]>> = {
  compact: {
    weather: ["temperature", "condition", "icon"],
    currency: ["rate", "convertedAmount"],
    stocks: ["symbol", "price", "change", "changePercent"],
    sports: ["homeTeam", "awayTeam", "homeScore", "awayScore", "status"],
    news: ["title", "source", "publishedAt"],
    crypto: ["symbol", "price", "changePercent24h"],
    world_clock: ["timezone", "time"],
    countdown: ["label", "days", "hours", "minutes", "seconds"],
  },
  detailed: {
    weather: ["temperature", "condition", "humidity", "windSpeed", "icon", "location"],
    currency: ["fromCurrency", "toCurrency", "rate", "amount", "convertedAmount"],
    stocks: ["symbol", "price", "change", "changePercent", "volume", "high", "low"],
    sports: ["homeTeam", "awayTeam", "homeScore", "awayScore", "status", "league", "time"],
    news: ["title", "description", "source", "publishedAt", "url", "imageUrl"],
    crypto: ["symbol", "name", "price", "changePercent24h", "marketCap", "volume24h"],
    world_clock: ["timezone", "time", "date", "offset"],
    countdown: ["label", "days", "hours", "minutes", "seconds", "targetDate"],
  },
  dashboard: {
    weather: ["temperature", "condition", "humidity", "windSpeed", "icon", "location", "forecast"],
    currency: ["fromCurrency", "toCurrency", "rate", "amount", "convertedAmount", "history"],
    stocks: ["symbol", "price", "change", "changePercent", "volume", "high", "low", "chart"],
    sports: ["homeTeam", "awayTeam", "homeScore", "awayScore", "status", "league", "time", "venue"],
    news: ["title", "description", "source", "publishedAt", "url", "imageUrl", "content"],
    crypto: ["symbol", "name", "price", "changePercent24h", "marketCap", "volume24h", "chart"],
    world_clock: ["timezone", "time", "date", "offset"],
    countdown: ["label", "days", "hours", "minutes", "seconds", "targetDate"],
  },
};