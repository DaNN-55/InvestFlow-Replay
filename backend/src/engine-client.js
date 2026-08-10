const DEFAULT_ENGINE_URL =
  process.env.INVESTFLOW_REPLAY_ENGINE_URL ?? "http://127.0.0.1:8775";

export class EngineClientError extends Error {
  constructor(message, status = 502, details = null) {
    super(message);
    this.name = "EngineClientError";
    this.status = status;
    this.details = details;
  }
}

function formatEngineErrorMessage(payload) {
  const detail = payload?.error?.message ?? payload?.detail;
  if (typeof detail === "string" && detail.trim()) {
    return detail;
  }
  if (Array.isArray(detail?.detail)) {
    const messages = detail.detail
      .map((item) => {
        const location = Array.isArray(item?.loc)
          ? item.loc.filter((part) => part !== "body").join(".")
          : "";
        const message = String(item?.msg ?? "").trim();
        return [location, message].filter(Boolean).join("：");
      })
      .filter(Boolean);
    if (messages.length) {
      return messages.join("；");
    }
  }
  if (detail && typeof detail === "object") {
    return JSON.stringify(detail);
  }
  return "Replay 行情引擎请求失败";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    throw new EngineClientError(
      formatEngineErrorMessage(payload),
      response.status,
      payload,
    );
  }
  return payload;
}

export function createEngineClient(baseUrl = DEFAULT_ENGINE_URL) {
  return {
    async getReplayBenchmarks({ retry = false } = {}) {
      const query = retry ? "?retry=true" : "";
      return requestJson(`${baseUrl}/internal/replay/benchmarks${query}`);
    },

    async getReplayCacheStatus() {
      return requestJson(`${baseUrl}/internal/replay/cache/status`);
    },

    async createReplayScenario({
      gameLength = 60,
      benchmarkCode,
      seed = null,
      interval = "1d",
      excludedTsCodes = [],
      recentWindowEndDates = [],
    } = {}) {
      return requestJson(`${baseUrl}/internal/replay/scenarios`, {
        method: "POST",
        body: JSON.stringify({
          gameLength,
          benchmarkCode,
          interval,
          excludedTsCodes,
          recentWindowEndDates,
          ...(seed == null ? {} : { seed }),
        }),
      });
    },

    async prefetchReplayStocks({ excludedTsCodes = [], targetReserve = 12 } = {}) {
      return requestJson(`${baseUrl}/internal/replay/cache/stocks/prefetch`, {
        method: "POST",
        body: JSON.stringify({ excludedTsCodes, targetReserve }),
      });
    },

    async searchInstruments({ q = "", limit = 8 } = {}) {
      const query = new URLSearchParams({ q, limit: String(limit) });
      return requestJson(`${baseUrl}/internal/instruments/search?${query.toString()}`);
    },
  };
}
