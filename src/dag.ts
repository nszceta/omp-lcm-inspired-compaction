export const MAX_ACTIVE_ROOTS = 4;
export const ROOT_SUMMARY_TARGET_TOKENS = 2_048;
export interface LcmRootRef {
  artifactId: string;
  level: number;
  summary: string;
  sourceEntryCount: number;
  tokenCount: number;
}
export interface LcmPreserveStateV1 {
  version: 1;
  generation: number;
  roots: LcmRootRef[];
}
export interface LcmNodeArtifactV1 {
  schema: "omp-lcm-node/v1";
  kind: "leaf-summary" | "condensed-summary" | "legacy-summary";
  level: number;
  summary: string;
  children: string[];
  rawSources: string[];
  sourceEntryIds: string[];
  sourceEntryCount: number;
  createdAt: string;
}
export interface ArtifactStore {
  saveArtifact(content: string, toolType: string): Promise<string> | string;
}
export interface NewLeaf {
  summary: string;
  rawArtifactIds?: string[];
  rawContent?: string;
  sourceEntryIds: string[];
  tokenCount?: number;
}
export interface DagResult {
  state: LcmPreserveStateV1;
  roots: LcmRootRef[];
}
export interface DagOptions {
  store: ArtifactStore;
  generation: number;
  priorRoots?: LcmRootRef[];
  leaves?: NewLeaf[];
  previousSummary?: string;
  legacyRawArtifactIds?: string[];
  legacySourceEntryIds?: string[];
  tokenCount?: (text: string) => number;
  summarize?: (text: string, targetTokens: number) => Promise<string> | string;
  signal?: AbortSignal;
}
const numeric = (id: string) =>
  typeof id === "string" &&
  /^[1-9]\d*$/.test(id) &&
  Number.isSafeInteger(Number(id));
const checkId = (id: string) => {
  if (!numeric(id)) throw new Error(`Invalid artifact id: ${id}`);
  return id;
};
const checkAbort = (s?: AbortSignal) => {
  if (s?.aborted) throw new DOMException("Aborted", "AbortError");
};
const defaultTokens = (s: string) => Math.ceil(s.length / 4);
function validateRoot(root: LcmRootRef): LcmRootRef {
  if (
    !/^[1-9]\d*$/.test(root.artifactId) ||
    !Number.isSafeInteger(Number(root.artifactId))
  ) {
    throw new Error(`Invalid prior root artifact id: ${root.artifactId}`);
  }
  if (
    !Number.isInteger(root.level) ||
    root.level < 0 ||
    !Number.isFinite(root.sourceEntryCount) ||
    root.sourceEntryCount < 0 ||
    !Number.isFinite(root.tokenCount) ||
    root.tokenCount < 0
  ) {
    throw new Error("Invalid prior root metadata");
  }
  return { ...root };
}
async function saveNode(
  store: ArtifactStore,
  node: LcmNodeArtifactV1,
  signal?: AbortSignal,
) {
  checkAbort(signal);
  return checkId(
    String(await store.saveArtifact(JSON.stringify(node), "lcm-node")),
  );
}
export async function buildDag(options: DagOptions): Promise<DagResult> {
  const {
    store,
    tokenCount = defaultTokens,
    summarize = (s) => s,
    signal,
  } = options;
  checkAbort(signal);
  const roots = (options.priorRoots ?? []).map(validateRoot);
  if (options.previousSummary && !options.priorRoots?.length) {
    const sourceIds = [...(options.legacySourceEntryIds ?? [])];
    const node: LcmNodeArtifactV1 = {
      schema: "omp-lcm-node/v1",
      kind: "legacy-summary",
      level: 0,
      summary: options.previousSummary,
      children: [],
      rawSources: (options.legacyRawArtifactIds ?? []).map(checkId),
      sourceEntryIds: sourceIds,
      sourceEntryCount: sourceIds.length,
      createdAt: new Date().toISOString(),
    };
    const id = await saveNode(store, node, signal);
    roots.push({
      artifactId: id,
      level: 0,
      summary: node.summary,
      sourceEntryCount: node.sourceEntryCount,
      tokenCount: tokenCount(node.summary),
    });
  }
  for (const leaf of options.leaves ?? []) {
    checkAbort(signal);
    let rawIds: string[];
    if (leaf.rawArtifactIds) {
      rawIds = leaf.rawArtifactIds.map(checkId);
    } else if (leaf.rawContent === undefined) {
      rawIds = [];
    } else {
      checkAbort(signal);
      const rawId = await store.saveArtifact(leaf.rawContent, "lcm-raw");
      checkAbort(signal);
      rawIds = [checkId(String(rawId))];
    }
    const node: LcmNodeArtifactV1 = {
      schema: "omp-lcm-node/v1",
      kind: "leaf-summary",
      level: 0,
      summary: leaf.summary,
      children: [],
      rawSources: rawIds,
      sourceEntryIds: [...leaf.sourceEntryIds],
      sourceEntryCount: leaf.sourceEntryIds.length,
      createdAt: new Date().toISOString(),
    };
    const id = await saveNode(store, node, signal);
    roots.push({
      artifactId: id,
      level: 0,
      summary: node.summary,
      sourceEntryCount: node.sourceEntryCount,
      tokenCount: leaf.tokenCount ?? tokenCount(node.summary),
    });
  }
  const totalTokens = () =>
    roots.reduce((n, r) => n + tokenCount(r.summary) + 8, 0);
  while (
    roots.length > MAX_ACTIVE_ROOTS ||
    totalTokens() > ROOT_SUMMARY_TARGET_TOKENS
  ) {
    checkAbort(signal);
    const group = roots.splice(0, Math.min(MAX_ACTIVE_ROOTS, roots.length));
    let summary = await summarize(
      group.map((r, i) => `Root ${i + 1}: ${r.summary}`).join("\n"),
      ROOT_SUMMARY_TARGET_TOKENS,
    );
    checkAbort(signal);
    if (
      !summary ||
      (group.length === 1 &&
        tokenCount(summary) >= tokenCount(group[0].summary))
    ) {
      summary = `Archived LCM history: ${group[0].summary}`.slice(
        0,
        Math.max(64, (ROOT_SUMMARY_TARGET_TOKENS - 16) * 3),
      );
    }
    const node: LcmNodeArtifactV1 = {
      schema: "omp-lcm-node/v1",
      kind: "condensed-summary",
      level: Math.max(...group.map((r) => r.level)) + 1,
      summary,
      children: group.map((r) => checkId(r.artifactId)),
      rawSources: [],
      sourceEntryIds: [],
      sourceEntryCount: group.reduce((n, r) => n + r.sourceEntryCount, 0),
      createdAt: new Date().toISOString(),
    };
    const id = await saveNode(store, node, signal);
    roots.unshift({
      artifactId: id,
      level: node.level,
      summary,
      sourceEntryCount: node.sourceEntryCount,
      tokenCount: tokenCount(summary),
    });
  }
  return {
    roots,
    state: { version: 1, generation: options.generation, roots },
  };
}
export const constructDag = buildDag;
export const buildLcmDag = buildDag;
