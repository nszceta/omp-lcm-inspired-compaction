import { boundedByTokens } from "./summarize.ts";
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
  rawContents?: string[];
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
  repairRoot?: (
    root: LcmRootRef,
    targetTokens: number,
  ) => Promise<string | undefined> | string | undefined;
  signal?: AbortSignal;
}
const numeric = (id: string) =>
  typeof id === "string" &&
  /^(0|[1-9]\d*)$/.test(id) &&
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
    !/^(0|[1-9]\d*)$/.test(root.artifactId) ||
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
  const priorRootCount = roots.length;
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
    } else if (leaf.rawContents) {
      const written: string[] = [];
      for (const content of leaf.rawContents) {
        checkAbort(signal);
        written.push(String(await store.saveArtifact(content, "lcm-raw")));
      }
      rawIds = written.map(checkId);
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
  const parentTarget = ROOT_SUMMARY_TARGET_TOKENS - 8;
  const condense = async (
    group: LcmRootRef[],
    replacement?: string,
  ): Promise<LcmRootRef> => {
    checkAbort(signal);
    const source = group
      .map((root, index) => `Root ${index + 1}: ${root.summary}`)
      .join("\n");
    const candidate = String(
      replacement ?? (await summarize(source, parentTarget)),
    ).trim();
    let summary = boundedByTokens(
      candidate || source,
      parentTarget,
      tokenCount,
    );
    if (!summary)
      summary = boundedByTokens(
        "Archived LCM history",
        parentTarget,
        tokenCount,
      );
    checkAbort(signal);
    const node: LcmNodeArtifactV1 = {
      schema: "omp-lcm-node/v1",
      kind: "condensed-summary",
      level: Math.max(...group.map((root) => root.level)) + 1,
      summary,
      children: group.map((root) => checkId(root.artifactId)),
      rawSources: [],
      sourceEntryIds: [],
      sourceEntryCount: group.reduce(
        (count, root) => count + root.sourceEntryCount,
        0,
      ),
      createdAt: new Date().toISOString(),
    };
    const id = await saveNode(store, node, signal);
    return {
      artifactId: id,
      level: node.level,
      summary,
      sourceEntryCount: node.sourceEntryCount,
      tokenCount: tokenCount(summary),
    };
  };
  if (options.repairRoot)
    for (let index = 0; index < priorRootCount; index++) {
      const repaired = await options.repairRoot(roots[index], parentTarget);
      if (repaired) roots[index] = await condense([roots[index]], repaired);
    }
  const totalTokens = () =>
    roots.reduce((count, root) => count + tokenCount(root.summary) + 8, 0);
  while (
    roots.length > MAX_ACTIVE_ROOTS ||
    totalTokens() > ROOT_SUMMARY_TARGET_TOKENS
  ) {
    const group = roots.splice(0, Math.min(MAX_ACTIVE_ROOTS, roots.length));
    roots.unshift(await condense(group));
  }
  return {
    roots,
    state: { version: 1, generation: options.generation, roots },
  };
}
export const constructDag = buildDag;
export const buildLcmDag = buildDag;
