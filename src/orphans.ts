import type { LcmNodeArtifactV1, LcmRootRef } from "./contracts.ts";

/** Default cap on node artifacts read while walking root reachability. */
export const DEFAULT_MAX_NODE_READS = 1_000;

export interface LcmOrphanStore {
  listFiles?: () => string[] | Promise<string[]>;
  getArtifact?: (
    id: string,
  ) => unknown | null | undefined | Promise<unknown | null | undefined>;
  getArtifactPath?: (
    id: string,
  ) => string | null | undefined | Promise<string | null | undefined>;
}

export interface OrphanCountOptions {
  signal?: AbortSignal;
  maxNodeReads?: number;
}

const FILE_NAME = /^(\d+)\..*\.log$/;
const NUMERIC = /^[0-9]+$/;
const NODE_KINDS = new Set([
  "leaf-summary",
  "condensed-summary",
  "legacy-summary",
] as const);

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/**
 * Adapt any session surface to the read-only orphan store contract: a
 * sessionManager exposing `getArtifactManager()`, or the artifact manager
 * itself (listFiles + getArtifact/getArtifactPath/getPath).
 */
export function orphanStoreFor(manager: unknown): LcmOrphanStore {
  const am =
    (
      manager as { getArtifactManager?: () => unknown } | null
    )?.getArtifactManager?.() ?? manager;
  if (am === null || am === undefined || typeof am !== "object") return {};
  const store: LcmOrphanStore = {};
  const anyAm = am as Record<string, unknown>;
  // Closures (not bare references) keep `this` bound to the artifact manager:
  // real ArtifactManager methods read private fields (this.#dir), so a
  // detached reference would fail the private-field brand check.
  if (typeof anyAm.listFiles === "function")
    store.listFiles = () =>
      (anyAm.listFiles as () => string[] | Promise<string[]>).call(am);
  if (typeof anyAm.getArtifact === "function")
    store.getArtifact = (id: string) =>
      (anyAm.getArtifact as (id: string) => unknown).call(am, id);
  else if (typeof anyAm.getArtifactPath === "function")
    store.getArtifactPath = (id: string) =>
      (
        anyAm.getArtifactPath as (
          id: string,
        ) => string | null | undefined | Promise<string | null | undefined>
      ).call(am, id);
  else if (typeof anyAm.getPath === "function")
    store.getArtifactPath = (id: string) =>
      (
        anyAm.getPath as (
          id: string,
        ) => string | null | undefined | Promise<string | null | undefined>
      ).call(am, id);
  return store;
}

/**
 * Count artifacts whose numeric id is not reachable from the installed roots:
 * walk each root node (children + rawSources) and count files named
 * `{id}.{toolType}.log` whose id was never reached. Malformed, missing, or
 * unreadable content is treated as terminal and never throws; only abort
 * signals propagate.
 */
export async function countOrphanArtifacts(
  store: LcmOrphanStore,
  roots: readonly LcmRootRef[],
  options: OrphanCountOptions = {},
): Promise<number> {
  const signal = options.signal;
  const maxNodeReads = options.maxNodeReads ?? DEFAULT_MAX_NODE_READS;
  if (!store.listFiles) return 0;
  const fileIds: string[] = [];
  for (const name of await store.listFiles()) {
    const match = typeof name === "string" ? FILE_NAME.exec(name) : null;
    if (match) fileIds.push(match[1]);
  }
  const reachable = new Set<string>();
  const queue: string[] = [];
  let reads = 0;
  const visit = async (id: string): Promise<void> => {
    checkAbort(signal);
    if (reachable.has(id) || reads >= maxNodeReads) return;
    reads++;
    let content: string | undefined;
    try {
      if (store.getArtifact) {
        const value = await store.getArtifact(id);
        content =
          value === null || value === undefined ? undefined : String(value);
      } else if (store.getArtifactPath) {
        const path = await store.getArtifactPath(id);
        if (path === null || path === undefined) return;
        content = await Bun.file(String(path)).text();
      } else {
        return;
      }
    } catch {
      return; // missing or unreadable content: treat as terminal
    }
    if (content === undefined) return;
    let parsed: Partial<LcmNodeArtifactV1>;
    try {
      parsed = JSON.parse(content);
    } catch {
      return; // malformed content: treat as terminal
    }
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.schema !== "omp-lcm-node/v1") return;
    if (!NODE_KINDS.has(parsed.kind as LcmNodeArtifactV1["kind"])) return;
    reachable.add(id);
    if (Array.isArray(parsed.children)) {
      for (const child of parsed.children) {
        if (
          typeof child === "string" &&
          NUMERIC.test(child) &&
          !reachable.has(child)
        )
          queue.push(child);
      }
    }
    if (Array.isArray(parsed.rawSources)) {
      for (const raw of parsed.rawSources) {
        if (typeof raw === "string" && NUMERIC.test(raw)) reachable.add(raw);
      }
    }
  };
  for (const root of roots ?? []) {
    checkAbort(signal);
    if (typeof root?.artifactId === "string" && NUMERIC.test(root.artifactId))
      queue.push(root.artifactId);
  }
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (reachable.has(id)) continue;
    await visit(id);
  }
  let orphans = 0;
  for (const id of fileIds) {
    if (!reachable.has(id)) orphans++;
  }
  return orphans;
}
