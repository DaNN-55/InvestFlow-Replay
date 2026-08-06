export function buildReplayRestartOptions(session) {
  return {
    interval: String(session?.interval ?? "1d"),
    gameLength: Number(session?.gameLength ?? 0),
    benchmarkCode: String(session?.benchmarkCode ?? ""),
    initialCapital: Number(session?.account?.initialCapital ?? 0),
    costConfig: { ...(session?.costConfig ?? {}) },
    trainingMode: "free",
  };
}
