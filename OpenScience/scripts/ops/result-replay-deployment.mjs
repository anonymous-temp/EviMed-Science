/** Select only the isolated Compose executor; native VCR configuration is independent. */
export function resultReplayDeployment(values) {
  const url = String(values.OPEN_SCIENCE_RESULT_ENGINE_URL ?? "").trim();
  if (!url) return null;
  if (url !== "http://result-replay:8031") {
    throw new Error("OPEN_SCIENCE_RESULT_ENGINE_URL must be http://result-replay:8031 for the hosted Compose overlay.");
  }
  const image = String(values.OPEN_SCIENCE_RESULT_REPLAY_IMAGE ?? "").trim();
  const leaf = image.slice(image.lastIndexOf("/") + 1);
  const pinned = image.includes("@") ? /@sha256:[a-f0-9]{64}$/.test(image) : /^[^:]+:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(leaf);
  if (!image || image.length > 255 || /[\s\0]/.test(image) || /:latest(?:@|$)/i.test(image) || !pinned) {
    throw new Error("OPEN_SCIENCE_RESULT_REPLAY_IMAGE must name an exact tag or digest.");
  }
  return { url, image, envName: "OPEN_SCIENCE_RESULT_REPLAY_IMAGE_ID" };
}
