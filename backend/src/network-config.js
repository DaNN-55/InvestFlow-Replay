import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const DATA_PROVIDERS = new Set(["akshare"]);
const SYNC_MODES = new Set(["", "live", "fixture"]);
const AKSHARE_PROXY_MODES = new Set(["inherit", "bypass"]);
const DEFAULT_TUSHARE_HTTP_URL = "https://ts.gyzcloud.top/api";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const ALLOWED_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);

const MANAGED_SECTION_HEADER = "# InvestFlow network config";
const DEFAULT_FILE_OPERATIONS = Object.freeze({
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
});

export const PRIMARY_NETWORK_ENV_KEYS = Object.freeze([
  "QUANT_WORKBENCH_DATA_PROVIDER",
  "QUANT_WORKBENCH_DATA_MODE",
  "QUANT_WORKBENCH_AKSHARE_PROXY_MODE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "TUSHARE_TOKEN",
  "TUSHARE_HTTP_URL",
]);

export const PROXY_ENV_MIRRORS = Object.freeze({
  HTTP_PROXY: "http_proxy",
  HTTPS_PROXY: "https_proxy",
  ALL_PROXY: "all_proxy",
  NO_PROXY: "no_proxy",
});

const MANAGED_ENV_KEY_SET = new Set([
  ...PRIMARY_NETWORK_ENV_KEYS,
  ...Object.values(PROXY_ENV_MIRRORS),
]);

function trimText(value) {
  return String(value ?? "").trim();
}

function parseEnvValue(rawValue = "") {
  const trimmed = String(rawValue).trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed
        .slice(1, -1)
        .replace(/\\(["\\$`])/g, "$1");
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readEnvMap(filePath) {
  const values = new Map();
  if (!filePath || !existsSync(filePath)) {
    return values;
  }
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const matched = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!matched) {
      continue;
    }
    values.set(matched[1], parseEnvValue(matched[2]));
  }
  return values;
}

function hasOwnValue(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

export function readEnvironmentFileUpdates({
  env = process.env,
  filePaths = [],
} = {}) {
  const updates = new Map();
  for (const filePath of filePaths) {
    for (const [key, value] of readEnvMap(filePath)) {
      if (hasOwnValue(env, key) || updates.has(key)) {
        continue;
      }
      const normalizedValue = String(value ?? "");
      if (normalizedValue.includes("\0")) {
        throw new Error(`环境变量 ${key} 不能包含 NUL 字符`);
      }
      updates.set(key, normalizedValue);
    }
  }
  return Object.fromEntries(updates);
}

function readValue(env, fileValues, key, fallback = "") {
  if (hasOwnValue(env, key)) {
    return String(env[key] ?? "");
  }
  if (fileValues.has(key)) {
    return String(fileValues.get(key) ?? "");
  }
  return fallback;
}

function readProxyValue(env, fileValues, key) {
  const mirrorKey = PROXY_ENV_MIRRORS[key];
  if (hasOwnValue(env, key)) {
    return String(env[key] ?? "");
  }
  if (mirrorKey && hasOwnValue(env, mirrorKey)) {
    return String(env[mirrorKey] ?? "");
  }
  if (fileValues.has(key)) {
    return String(fileValues.get(key) ?? "");
  }
  if (mirrorKey && fileValues.has(mirrorKey)) {
    return String(fileValues.get(mirrorKey) ?? "");
  }
  return "";
}

function assertConfig(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.status = 400;
    throw error;
  }
}

function normalizeDataProvider(value) {
  const normalized = trimText(value).toLowerCase() || "akshare";
  assertConfig(
    DATA_PROVIDERS.has(normalized),
    "默认数据源当前只支持 akshare（AkShare / Eastmoney）",
  );
  return normalized;
}

function normalizeSyncMode(value) {
  const normalized = trimText(value).toLowerCase();
  assertConfig(
    SYNC_MODES.has(normalized),
    "同步模式只支持 auto、live 或 fixture",
  );
  return normalized;
}

function normalizeAkshareProxyMode(value) {
  const normalized = trimText(value).toLowerCase() || "inherit";
  assertConfig(
    AKSHARE_PROXY_MODES.has(normalized),
    "数据源代理模式只支持 inherit 或 bypass",
  );
  return normalized;
}

function normalizeProxyUrl(value, fieldName) {
  const normalized = trimText(value);
  if (!normalized) {
    return "";
  }
  let parsed = null;
  try {
    parsed = new URL(normalized);
  } catch {
    assertConfig(false, `${fieldName} 必须是合法的代理地址`);
  }
  assertConfig(
    ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol),
    `${fieldName} 仅支持 http/https/socks 代理协议`,
  );
  return normalized;
}

function toPublicProxyUrl(value) {
  const normalized = trimText(value);
  if (!normalized) {
    return {
      value: "",
      credentialsConfigured: false,
    };
  }
  try {
    const parsed = new URL(normalized);
    const credentialsConfigured = Boolean(parsed.username || parsed.password);
    return {
      value: `${parsed.protocol}//${parsed.host}`,
      credentialsConfigured,
    };
  } catch {
    return {
      value: "",
      credentialsConfigured: normalized.includes("@"),
    };
  }
}

function normalizeTushareHttpUrl(value) {
  const normalized = trimText(value) || DEFAULT_TUSHARE_HTTP_URL;
  let parsed = null;
  try {
    parsed = new URL(normalized);
  } catch {
    assertConfig(false, "Tushare SDK 地址必须是合法 URL");
  }
  assertConfig(
    parsed.protocol === "http:" || parsed.protocol === "https:",
    "Tushare SDK 地址只支持 http 或 https",
  );
  assertConfig(
    parsed.protocol === "https:" || LOOPBACK_HOSTS.has(parsed.hostname),
    "Tushare SDK 远程地址必须使用 HTTPS",
  );
  return normalized.replace(/\/+$/, "");
}

function serializeEnvValue(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@,%+-]+$/.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function formatEnvAssignment(key, value) {
  return `${key}=${serializeEnvValue(value)}`;
}

export function readNetworkConfigSnapshot({
  env = process.env,
  envFilePath,
} = {}) {
  const fileValues = readEnvMap(envFilePath);
  const syncMode = normalizeSyncMode(
    readValue(env, fileValues, "QUANT_WORKBENCH_DATA_MODE"),
  );
  const config = {
    dataProvider: normalizeDataProvider(
      readValue(env, fileValues, "QUANT_WORKBENCH_DATA_PROVIDER", "akshare"),
    ),
    syncMode,
    akshareProxyMode: normalizeAkshareProxyMode(
      readValue(
        env,
        fileValues,
        "QUANT_WORKBENCH_AKSHARE_PROXY_MODE",
        "inherit",
      ),
    ),
    httpProxy: trimText(readProxyValue(env, fileValues, "HTTP_PROXY")),
    httpsProxy: trimText(readProxyValue(env, fileValues, "HTTPS_PROXY")),
    allProxy: trimText(readProxyValue(env, fileValues, "ALL_PROXY")),
    noProxy: trimText(readProxyValue(env, fileValues, "NO_PROXY")),
    tushareToken: trimText(readValue(env, fileValues, "TUSHARE_TOKEN")),
    tushareHttpUrl: normalizeTushareHttpUrl(
      readValue(
        env,
        fileValues,
        "TUSHARE_HTTP_URL",
        DEFAULT_TUSHARE_HTTP_URL,
      ),
    ),
  };
  return {
    ...config,
    proxyConfigured: Boolean(
      config.httpProxy || config.httpsProxy || config.allProxy,
    ),
    envFileExists: Boolean(envFilePath && existsSync(envFilePath)),
    envFilePath: envFilePath ?? "",
  };
}

export function normalizeNetworkConfigPayload(payload = {}) {
  return {
    dataProvider: normalizeDataProvider(payload.dataProvider),
    syncMode: normalizeSyncMode(payload.syncMode),
    akshareProxyMode: normalizeAkshareProxyMode(payload.akshareProxyMode),
    httpProxy: normalizeProxyUrl(payload.httpProxy, "HTTP_PROXY"),
    httpsProxy: normalizeProxyUrl(payload.httpsProxy, "HTTPS_PROXY"),
    allProxy: normalizeProxyUrl(payload.allProxy, "ALL_PROXY"),
    noProxy: trimText(payload.noProxy),
    tushareToken: trimText(payload.tushareToken),
    tushareHttpUrl: normalizeTushareHttpUrl(payload.tushareHttpUrl),
  };
}

export function mergeNetworkConfigPayload(current = {}, payload = {}) {
  const replacement = trimText(
    payload.tushareTokenReplacement ?? payload.tushareToken,
  );
  const mergeProxy = (key) => {
    if (!hasOwnValue(payload, key)) {
      return current[key];
    }
    return payload[key];
  };
  return {
    dataProvider: payload.dataProvider ?? current.dataProvider,
    syncMode: payload.syncMode ?? current.syncMode,
    akshareProxyMode: payload.akshareProxyMode ?? current.akshareProxyMode,
    httpProxy: mergeProxy("httpProxy"),
    httpsProxy: mergeProxy("httpsProxy"),
    allProxy: mergeProxy("allProxy"),
    noProxy: payload.noProxy ?? current.noProxy,
    tushareToken: replacement || current.tushareToken || "",
    tushareHttpUrl: payload.tushareHttpUrl ?? current.tushareHttpUrl,
  };
}

export function mergeNetworkConfigUpdatePayload(current = {}, payload = {}) {
  const normalizedPayload = { ...payload };
  for (const key of ["httpProxy", "httpsProxy", "allProxy"]) {
    if (!hasOwnValue(payload, key)) {
      continue;
    }
    const value = payload[key];
    assertConfig(
      value === null ||
        (typeof value === "string" && trimText(value).length > 0),
      `${key} 清除代理请传 null，替换代理请传非空字符串`,
    );
    normalizedPayload[key] = value === null ? "" : value;
  }
  return mergeNetworkConfigPayload(current, normalizedPayload);
}

export function toPublicNetworkConfig(config = {}) {
  const publicConfig = { ...config };
  const tushareToken = publicConfig.tushareToken;
  delete publicConfig.tushareToken;
  delete publicConfig.envFilePath;
  const normalizedToken = trimText(tushareToken);
  const httpProxy = toPublicProxyUrl(publicConfig.httpProxy);
  const httpsProxy = toPublicProxyUrl(publicConfig.httpsProxy);
  const allProxy = toPublicProxyUrl(publicConfig.allProxy);
  delete publicConfig.httpProxy;
  delete publicConfig.httpsProxy;
  delete publicConfig.allProxy;
  return {
    ...publicConfig,
    httpProxyConfigured: Boolean(trimText(config.httpProxy)),
    httpsProxyConfigured: Boolean(trimText(config.httpsProxy)),
    allProxyConfigured: Boolean(trimText(config.allProxy)),
    httpProxyHint: httpProxy.value || null,
    httpsProxyHint: httpsProxy.value || null,
    allProxyHint: allProxy.value || null,
    httpProxyCredentialsConfigured: httpProxy.credentialsConfigured,
    httpsProxyCredentialsConfigured: httpsProxy.credentialsConfigured,
    allProxyCredentialsConfigured: allProxy.credentialsConfigured,
    tushareTokenConfigured: Boolean(normalizedToken),
    tushareTokenHint: normalizedToken ? `••••${normalizedToken.slice(-4)}` : null,
  };
}

export function buildPersistedEnvironmentUpdates(config) {
  return {
    QUANT_WORKBENCH_DATA_PROVIDER: config.dataProvider,
    QUANT_WORKBENCH_DATA_MODE: config.syncMode,
    QUANT_WORKBENCH_AKSHARE_PROXY_MODE:
      config.akshareProxyMode === "bypass" ? "bypass" : "",
    HTTP_PROXY: config.httpProxy,
    HTTPS_PROXY: config.httpsProxy,
    ALL_PROXY: config.allProxy,
    NO_PROXY: config.noProxy,
    TUSHARE_TOKEN: config.tushareToken,
    TUSHARE_HTTP_URL: config.tushareHttpUrl,
  };
}

export function buildRuntimeEnvironmentUpdates(config) {
  const updates = buildPersistedEnvironmentUpdates(config);
  for (const [key, mirrorKey] of Object.entries(PROXY_ENV_MIRRORS)) {
    updates[mirrorKey] = updates[key];
  }
  return updates;
}

export function applyRuntimeEnvironmentUpdates(targetEnv, updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (value == null) {
      delete targetEnv[key];
      continue;
    }
    targetEnv[key] = String(value);
  }
}

export function persistEnvironmentUpdates(
  filePath,
  updates,
  { fileOperations = DEFAULT_FILE_OPERATIONS } = {},
) {
  const existingLines = fileOperations.existsSync(filePath)
    ? fileOperations.readFileSync(filePath, "utf8").split(/\r?\n/)
    : [];
  const retainedLines = existingLines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return true;
    }
    if (trimmed === MANAGED_SECTION_HEADER) {
      return false;
    }
    if (trimmed.startsWith("#")) {
      return true;
    }
    const matched = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!matched) {
      return true;
    }
    return !MANAGED_ENV_KEY_SET.has(matched[1]);
  });

  const outputLines = retainedLines.slice();
  if (outputLines.length && outputLines[outputLines.length - 1] !== "") {
    outputLines.push("");
  }
  outputLines.push(MANAGED_SECTION_HEADER);
  for (const key of PRIMARY_NETWORK_ENV_KEYS) {
    outputLines.push(formatEnvAssignment(key, updates[key] ?? ""));
  }

  const normalizedOutput = `${outputLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
  const temporaryPath = resolve(
    dirname(filePath),
    `${basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    fileOperations.writeFileSync(temporaryPath, normalizedOutput, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fileOperations.renameSync(temporaryPath, filePath);
  } finally {
    if (fileOperations.existsSync(temporaryPath)) {
      fileOperations.rmSync(temporaryPath, { force: true });
    }
  }
}
