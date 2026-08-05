const DEFAULT_ENGINE_URL =
  process.env.QUANT_WORKBENCH_ENGINE_URL ?? "http://127.0.0.1:8765";

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
  return "Python engine request failed";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  });

  const isJson = response.headers
    .get("content-type")
    ?.includes("application/json");
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
    async getStrategies() {
      return requestJson(`${baseUrl}/internal/strategies`);
    },

    async getDataCoverage() {
      return requestJson(`${baseUrl}/internal/data/coverage`);
    },

    async getDataVersion() {
      return requestJson(`${baseUrl}/internal/data/version`);
    },

    async getDataOverview() {
      return requestJson(`${baseUrl}/internal/data/overview`);
    },

    async getDataCatalog({
      keyword = "",
      type = "",
      exchange = "",
      interval = "1d",
      adjust = "",
      page = 1,
      pageSize = 20,
    } = {}) {
      const query = new URLSearchParams({
        interval,
        page: String(page),
        pageSize: String(pageSize),
      });
      if (keyword) {
        query.set("keyword", keyword);
      }
      if (type) {
        query.set("type", type);
      }
      if (exchange) {
        query.set("exchange", exchange);
      }
      if (adjust) {
        query.set("adjust", adjust);
      }
      return requestJson(`${baseUrl}/internal/data/catalog?${query.toString()}`);
    },

    async getDataCatalogItem(orderBookId) {
      return requestJson(
        `${baseUrl}/internal/data/catalog/${encodeURIComponent(orderBookId)}`,
      );
    },

    async getReplayBenchmarks({ retry = false } = {}) {
      const query = retry ? "?retry=true" : "";
      return requestJson(`${baseUrl}/internal/replay/benchmarks${query}`);
    },

    async createReplayScenario({
      gameLength = 60,
      benchmarkCode,
      seed = null,
      interval = "1d",
    } = {}) {
      return requestJson(`${baseUrl}/internal/replay/scenarios`, {
        method: "POST",
        body: JSON.stringify({
          gameLength,
          benchmarkCode,
          interval,
          ...(seed == null ? {} : { seed }),
        }),
      });
    },

    async getRawDatasets() {
      return requestJson(`${baseUrl}/internal/data/raw-datasets`);
    },

    async updateRuntimeEnvironment(payload) {
      return requestJson(`${baseUrl}/internal/runtime/environment`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },

    async searchInstruments({ q = "", limit = 8 } = {}) {
      const query = new URLSearchParams({
        q,
        limit: String(limit),
      });
      return requestJson(
        `${baseUrl}/internal/instruments/search?${query.toString()}`,
      );
    },

    async getBars({
      symbol,
      exchange,
      interval,
      startDate,
      endDate,
      adjust = "qfq",
    }) {
      const query = new URLSearchParams({
        symbol,
        exchange,
        interval,
        startDate,
        endDate,
        adjust,
      });
      return requestJson(`${baseUrl}/internal/data/bars?${query.toString()}`);
    },

    async getRawTable({
      dataset,
      page = 1,
      pageSize = 50,
      keyword = "",
      startDate = "",
      endDate = "",
      fieldFilters = null,
    }) {
      const query = new URLSearchParams({
        dataset,
        page: String(page),
        pageSize: String(pageSize),
      });
      if (keyword) {
        query.set("keyword", keyword);
      }
      if (startDate) {
        query.set("startDate", startDate);
      }
      if (endDate) {
        query.set("endDate", endDate);
      }
      if (fieldFilters && typeof fieldFilters === "object") {
        query.set("fieldFilters", JSON.stringify(fieldFilters));
      }
      return requestJson(`${baseUrl}/internal/data/raw-table?${query.toString()}`);
    },

    async syncData(payload) {
      return requestJson(`${baseUrl}/internal/data/sync`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },

    async runBacktest(payload) {
      return requestJson(`${baseUrl}/internal/backtests/run`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },

    async runWorkspaceStrategy(payload) {
      return requestJson(`${baseUrl}/internal/workspace/run`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },

    async getRun(runId) {
      return requestJson(`${baseUrl}/internal/backtests/${runId}`);
    },
  };
}
