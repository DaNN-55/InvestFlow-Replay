import {
  mergeNetworkConfigPayload,
  normalizeNetworkConfigPayload,
} from "./network-config.js";

const SOURCES = new Set(["tushare", "akshare"]);
const RESULT_STATUSES = new Set([
  "healthy",
  "upstream_incomplete",
  "configuration_error",
  "network_error",
  "service_error",
]);
const CHECK_STATUSES = new Set(["pass", "warning", "fail"]);
const MIN_SECRET_LENGTH = 4;
const REQUEST_FIELDS = new Set([
  "source",
  "tushareHttpUrl",
  "tushareTokenReplacement",
  "akshareProxyMode",
  "httpProxy",
  "httpsProxy",
  "allProxy",
  "noProxy",
]);

function invalidRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function invalidResult() {
  const error = new Error("本地数据探针返回了无效结果");
  error.status = 502;
  return error;
}

function normalizeForbiddenSecrets(values = []) {
  return [...new Set(values
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length >= MIN_SECRET_LENGTH))];
}

function decodeCredential(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function proxySecrets(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? [normalized] : [];
}

function proxyCredentialSecrets(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return [];
  const credentials = [];
  try {
    const parsed = new URL(normalized);
    for (const credential of [parsed.username, parsed.password]) {
      if (!credential) continue;
      credentials.push(credential, decodeCredential(credential));
    }
  } catch {
    return [];
  }
  return [...new Set(credentials.filter((credential) => credential.length > 0))];
}

function assertNoForbiddenSecret(value, forbiddenSecrets) {
  if (forbiddenSecrets.some((secret) => value.includes(secret))) {
    throw invalidResult();
  }
  return value;
}

function assertText(value, forbiddenSecrets = []) {
  if (typeof value !== "string" || !value.trim()) throw invalidResult();
  return assertNoForbiddenSecret(value, forbiddenSecrets);
}

function assertNullableText(value, forbiddenSecrets = []) {
  if (value == null) return null;
  if (typeof value !== "string") throw invalidResult();
  return assertNoForbiddenSecret(value, forbiddenSecrets);
}

function assertNullableCount(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0) throw invalidResult();
  return value;
}

function assertElapsed(value) {
  if (!Number.isFinite(value) || value < 0) throw invalidResult();
  return Math.round(value);
}

export function normalizeUpstreamTestRequest(body = {}, savedConfig = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalidRequest("请求体必须是对象");
  }
  if (Object.keys(body).some((key) => !REQUEST_FIELDS.has(key))) {
    throw invalidRequest("请求包含不支持的字段");
  }
  if (Object.entries(body).some(([, value]) => typeof value !== "string")) {
    throw invalidRequest("数据源配置字段必须是字符串");
  }
  const source = body.source ?? "";
  if (!SOURCES.has(source)) {
    throw invalidRequest("数据源只支持 tushare 或 akshare");
  }

  const config = normalizeNetworkConfigPayload(
    mergeNetworkConfigPayload(savedConfig, body),
  );
  const proxyPayload = {
    akshareProxyMode: config.akshareProxyMode,
    httpProxy: config.httpProxy,
    httpsProxy: config.httpsProxy,
    allProxy: config.allProxy,
    noProxy: config.noProxy,
  };

  return {
    source,
    payload: source === "tushare"
      ? {
          tushareHttpUrl: config.tushareHttpUrl,
          tushareToken: config.tushareToken,
          ...proxyPayload,
        }
      : proxyPayload,
  };
}

export function assertSafeUpstreamResult(value, expectedSource, forbiddenValues = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResult();
  }
  const forbiddenSecrets = [...new Set(forbiddenValues
    .filter((value) => typeof value === "string")
    .filter((value) => value.length > 0))];
  const source = assertText(value.source, forbiddenSecrets);
  if (!SOURCES.has(source) || (expectedSource && source !== expectedSource)) {
    throw invalidResult();
  }
  const status = assertText(value.status, forbiddenSecrets);
  if (!RESULT_STATUSES.has(status)) throw invalidResult();
  if (!Array.isArray(value.checks)) throw invalidResult();

  return {
    source,
    status,
    summary: assertText(value.summary, forbiddenSecrets),
    testedAt: assertText(value.testedAt, forbiddenSecrets),
    expectedTradeDate: assertNullableText(value.expectedTradeDate, forbiddenSecrets),
    elapsedMs: assertElapsed(value.elapsedMs),
    checks: value.checks.map((check) => {
      if (!check || typeof check !== "object" || Array.isArray(check)) {
        throw invalidResult();
      }
      const checkStatus = assertText(check.status, forbiddenSecrets);
      if (!CHECK_STATUSES.has(checkStatus)) throw invalidResult();
      return {
        id: assertText(check.id, forbiddenSecrets),
        label: assertText(check.label, forbiddenSecrets),
        status: checkStatus,
        latestTradeDate: assertNullableText(check.latestTradeDate, forbiddenSecrets),
        rowCount: assertNullableCount(check.rowCount),
        elapsedMs: assertElapsed(check.elapsedMs),
        message: assertText(check.message, forbiddenSecrets),
      };
    }),
  };
}

export function upstreamTestForbiddenSecrets(payload = {}) {
  const proxyValues = [payload.httpProxy, payload.httpsProxy, payload.allProxy];
  return [...new Set([
    ...normalizeForbiddenSecrets([
      payload.tushareToken,
      ...proxyValues.flatMap(proxySecrets),
    ]),
    ...proxyValues.flatMap(proxyCredentialSecrets),
  ])];
}

export function createUpstreamServiceError(source, { testedAt, elapsedMs }) {
  return {
    source,
    status: "service_error",
    summary: "本地数据探针暂不可用，请确认对应服务已启动后重试",
    testedAt,
    expectedTradeDate: null,
    elapsedMs,
    checks: [],
  };
}
