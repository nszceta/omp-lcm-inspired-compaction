import { createHash } from "node:crypto";

export const NATIVE_REPLAY_LINEAGE_KEY = "ompLcmNativeReplayLineageV1" as const;

export interface NativeReplayLineageV1 {
  version: 1;
  provider: string;
  modelId: string;
  apiVariant: string;
  endpoint: string;
  credentialIdentity: string;
}

export interface ReplayModel {
  id?: unknown;
  requestModelId?: unknown;
  provider?: unknown;
  api?: unknown;
  baseUrl?: unknown;
  useResponsesLite?: unknown;
  remoteCompaction?: {
    api?: unknown;
    endpoint?: unknown;
    model?: unknown;
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function effectiveApi(model: ReplayModel): string {
  const api = model.remoteCompaction?.api ?? model.api;
  if (!nonEmptyString(api)) throw new Error("Native replay API is unavailable");
  return api;
}

function resolveEndpoint(model: ReplayModel, api: string): string {
  const configured = model.remoteCompaction?.endpoint;
  if (api === "azure-openai-responses") {
    const endpoint = nonEmptyString(configured)
      ? configured
      : (() => {
          const base =
            process.env.AZURE_OPENAI_BASE_URL?.trim() ||
            (process.env.AZURE_OPENAI_RESOURCE_NAME
              ? `https://${process.env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1`
              : undefined) ||
            (nonEmptyString(model.baseUrl) ? model.baseUrl : undefined);
          if (!base) throw new Error("Native replay endpoint is unavailable");
          return `${base.replace(/\/+$/, "")}/responses/compact`;
        })();
    if (/[?&]api-version=/.test(endpoint)) return endpoint;
    return `${endpoint}${endpoint.includes("?") ? "&" : "?"}api-version=${encodeURIComponent(process.env.AZURE_OPENAI_API_VERSION || "v1")}`;
  }
  if (nonEmptyString(configured)) return configured;

  if (model.provider === "openai-codex" || api === "openai-codex-responses") {
    const base = nonEmptyString(model.baseUrl)
      ? model.baseUrl
      : "https://chatgpt.com/backend-api";
    const normalizedBase = base.replace(/\/+$/, "");
    return /\/codex(?:\/v\d+)?$/.test(normalizedBase)
      ? `${normalizedBase}/responses/compact`
      : `${normalizedBase}/codex/responses/compact`;
  }

  const base = nonEmptyString(model.baseUrl)
    ? model.baseUrl
    : "https://api.openai.com/v1";
  const normalizedBase = base.replace(/\/+$/, "");
  return normalizedBase.endsWith("/v1")
    ? `${normalizedBase}/responses/compact`
    : `${normalizedBase}/v1/responses/compact`;
}

export function normalizeReplayEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  )
    url.port = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.searchParams.sort();
  return url.toString();
}

export function replayCredentialIdentity(
  kind: "api-key" | "oauth",
  identity: string,
): string {
  return `sha256:${createHash("sha256").update(`${kind}\0${identity}`).digest("hex")}`;
}

export interface NativeReplayLineageOptions {
  mechanism?: "v1" | "v2";
  endpoint?: string;
}

export function createNativeReplayLineage(
  model: ReplayModel,
  credentialIdentity: string,
  options: NativeReplayLineageOptions = {},
): NativeReplayLineageV1 {
  if (!nonEmptyString(model.provider))
    throw new Error("Native replay provider is unavailable");
  const modelId =
    model.remoteCompaction?.model ?? model.requestModelId ?? model.id;
  if (!nonEmptyString(modelId))
    throw new Error("Native replay model ID is unavailable");
  const api = effectiveApi(model);
  const mechanism = options.mechanism ?? "v1";
  let endpoint = options.endpoint;
  if (endpoint === undefined) {
    if (mechanism === "v2")
      throw new Error("Native replay V2 endpoint is unavailable");
    endpoint = resolveEndpoint(model, api);
  }
  return {
    version: 1,
    provider: model.provider,
    modelId,
    apiVariant: `${api}:${model.useResponsesLite === true ? "responses-lite" : "standard"}${mechanism === "v2" ? ":streaming-v2" : ""}`,
    endpoint: normalizeReplayEndpoint(endpoint),
    credentialIdentity,
  };
}

export function parseNativeReplayLineage(
  preserveData: unknown,
): NativeReplayLineageV1 | undefined {
  if (
    !preserveData ||
    typeof preserveData !== "object" ||
    Array.isArray(preserveData)
  )
    return undefined;
  const value = (preserveData as Record<string, unknown>)[
    NATIVE_REPLAY_LINEAGE_KEY
  ];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const lineage = value as Record<string, unknown>;
  if (
    lineage.version !== 1 ||
    !nonEmptyString(lineage.provider) ||
    !nonEmptyString(lineage.modelId) ||
    !nonEmptyString(lineage.apiVariant) ||
    !nonEmptyString(lineage.endpoint) ||
    !nonEmptyString(lineage.credentialIdentity)
  )
    return undefined;
  return {
    version: 1,
    provider: lineage.provider,
    modelId: lineage.modelId,
    apiVariant: lineage.apiVariant,
    endpoint: lineage.endpoint,
    credentialIdentity: lineage.credentialIdentity,
  };
}

export function nativeReplayLineagesMatch(
  saved: NativeReplayLineageV1 | undefined,
  active: NativeReplayLineageV1,
): boolean {
  return (
    saved?.provider === active.provider &&
    saved.modelId === active.modelId &&
    saved.apiVariant === active.apiVariant &&
    saved.endpoint === active.endpoint &&
    saved.credentialIdentity === active.credentialIdentity
  );
}
