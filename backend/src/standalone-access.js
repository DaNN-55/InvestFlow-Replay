const allowedPaths = [
  /^\/api\/quant\/replay(?:\/|$)/,
  /^\/api\/quant\/decision\/execution-settings(?:\/|$)/,
  /^\/api\/quant\/decision\/trade-records(?:\/|$)/,
  /^\/api\/quant\/decision\/stocks\/search$/,
];

export function isStandalonePathAllowed(path) {
  return allowedPaths.some((pattern) => pattern.test(String(path ?? "")));
}
