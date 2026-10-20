import { startComparisonTestServer } from "./comparison-server.js";

// Shared fixed-market fixture for analytics API and browser acceptance tests.
// The comparison fixture already contains first/retrain, hidden and synthetic
// sessions and exposes its temporary SQLite root for read-only assertions.
export async function startAnalyticsTestServer(port = 0) {
  return startComparisonTestServer(port);
}
