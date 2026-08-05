export function buildReplayRestartOptions(session) {
  const trainingConfig = session?.trainingConfig ?? { mode: "free" };
  const options = {
    interval: String(session?.interval ?? "1d"),
    gameLength: Number(session?.gameLength ?? 0),
    benchmarkCode: String(session?.benchmarkCode ?? ""),
    initialCapital: Number(session?.account?.initialCapital ?? 0),
    costConfig: { ...(session?.costConfig ?? {}) },
    trainingMode: trainingConfig.mode === "playbook" ? "playbook" : "free",
  };

  if (options.trainingMode === "playbook") {
    options.playbookId = trainingConfig.playbookId;
    options.playbookVersionId = trainingConfig.playbookVersionId;
  }
  return options;
}
