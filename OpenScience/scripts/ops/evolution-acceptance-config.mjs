/** Explicit configuration for an isolated live measurement; no serving settings are changed. */
export function createEvolutionConfiguration(input, secrets) {
  const gateway = "http://evimed-evolution-acceptance-web:8787";
  return {
    production: false, localAutoConfig: false, devAuth: false, authMode: "local", bootstrapUser: "evolution-acceptance",
    bootstrapPassword: secrets.password, operatorUsers: "evolution-acceptance", host: "0.0.0.0", port: 8787,
    dataDir: input.dataDir, databaseUrl: input.databaseUrl, stateStore: "postgres", databasePoolMax: 6, requireSharedStateStore: true,
    sourceRevision: input.sourceRevision,
    deepseekApiKeyFile: input.deepseekKeyFile, deepseekProviderEnabled: true, modelGatewaySigningSecret: secrets.modelSecret,
    dashscopeApiKeyFile: input.dashscopeKeyFile,
    evimedWorkloadSigningSecret: secrets.workloadSecret, runtimeMode: "kernel", runtimeProvider: "docker", runtimeSandboxMode: "docker",
    runtimeControllerMode: "socket", runtimeControllerSocket: "/acceptance/.openscience/runtime-controller.sock", allowDirectDockerControl: false,
    runtimeContainerImage: input.runtimeImage, runtimeContainerUser: "10001:10001", runtimeDataVolume: input.volume,
    runtimeTransport: "unix", runtimeNetworkMode: input.network, runtimeInternalNetworkName: input.network,
    runtimeEgressAllowedPeers: input.egressAllowedPeers ?? [],
    evolutionEvaluationNetwork: input.evolutionEvaluationNetwork ?? '',
    allowRuntimeNetworkEgress: false, runtimeNetworkEgressPolicyAck: false, runtimeMemoryLimit: input.runtimeMemoryLimit ?? "1536m", runtimeCpuLimit: "1.5",
    maxRunningRuntimes: input.hostRuntimeLimit ?? 2, maxRunningRuntimesPerUser: 1, runtimeRequireImageLocal: true,
    modelGatewayInternalUrl: gateway + "/internal/model/v1", publicSourceGatewayInternalUrl: gateway + "/internal/sources/v1/fetch",
    webSearchGatewayInternalUrl: gateway + "/internal/search/v1/query", evolutionGatewayInternalUrl: gateway + "/internal/evolution/v1",
    learningEnabled: false, sourceIngestionEnabled: true, sourceUnderstandingEnabled: false, autopilotEnabled: true, reviewEnabled: false, runtimeReviewEnabled: false,
    frontierEnabled: false, imEnabled: false, geoEnabled: false, vcrEnabled: false, evimedCreditsEnabled: false,
    personalSkillsEnabled: false, memoryEnabled: false, llmRoutingEnabled: true,
    evolutionEnabled: true, evolutionDailyBudgetCny: 50, evolutionRunBudgetCny: 10, evolutionMaxBuildAttempts: input.maxBuildAttempts ?? 3,
    evaluationDataDir: input.evaluationDataDir, evolutionEvaluationTimeoutMs: 1_800_000,
  };
}
