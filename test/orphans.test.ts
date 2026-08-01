import { describe, expect, test } from "bun:test";
import type { LcmRootRef } from "../src/contracts.ts";
import {
  countOrphanArtifacts,
  DEFAULT_MAX_NODE_READS,
  type LcmOrphanStore,
  orphanStoreFor,
} from "../src/orphans.ts";

function node(
  overrides: { kind?: string; children?: string[]; rawSources?: string[] } = {},
): string {
  return JSON.stringify({
    schema: "omp-lcm-node/v1",
    kind: "leaf-summary",
    level: 0,
    summary: "s",
    children: [],
    rawSources: [],
    sourceEntryIds: [],
    sourceEntryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function root(artifactId: string): LcmRootRef {
  return {
    artifactId,
    level: 0,
    summary: "s",
    sourceEntryCount: 1,
    tokenCount: 1,
  };
}

describe("countOrphanArtifacts", () => {
  test("counts unreferenced artifact files and zeroes on an empty store", async () => {
    const store: LcmOrphanStore = {
      listFiles: async () => ["1.lcm-raw.log", "2.lcm-node.log"],
      getArtifact: async () => undefined,
    };
    expect(await countOrphanArtifacts(store, [])).toBe(2);
    expect(
      await countOrphanArtifacts({ ...store, listFiles: async () => [] }, []),
    ).toBe(0);
  });

  test("never counts artifacts linked from a root node's rawSources", async () => {
    const contents = new Map<string, string>([
      ["1", "raw source content"],
      ["2", node({ rawSources: ["1"] })],
      ["3", "orphaned raw content"],
    ]);
    const store: LcmOrphanStore = {
      listFiles: async () => [
        "1.lcm-raw.log",
        "2.lcm-node.log",
        "3.lcm-raw.log",
      ],
      getArtifact: async (id: string) => contents.get(id),
    };
    expect(await countOrphanArtifacts(store, [root("2")])).toBe(1);
  });

  test("follows transitive children to their rawSources", async () => {
    const contents = new Map<string, string>([
      ["10", node({ children: ["20"] })],
      ["20", node({ rawSources: ["5"] })],
      ["5", "raw source content"],
      ["99", "orphaned raw content"],
    ]);
    const store: LcmOrphanStore = {
      listFiles: async () => [
        "5.lcm-raw.log",
        "10.lcm-node.log",
        "20.lcm-node.log",
        "99.lcm-raw.log",
      ],
      getArtifact: async (id: string) => contents.get(id),
    };
    expect(await countOrphanArtifacts(store, [root("10")])).toBe(1);
  });

  test("treats malformed, non-node, missing, and unreadable content as terminal", async () => {
    const roots = [root("1"), root("2")];
    const malformed: LcmOrphanStore = {
      listFiles: async () => ["1.lcm-node.log", "2.lcm-node.log"],
      getArtifact: async (id: string) =>
        id === "1"
          ? "not json at all"
          : JSON.stringify({ kind: "leaf-summary" }),
    };
    expect(await countOrphanArtifacts(malformed, roots)).toBe(2);
    const missing: LcmOrphanStore = {
      listFiles: async () => ["1.lcm-node.log", "2.lcm-node.log"],
      getArtifactPath: async () => null,
    };
    expect(await countOrphanArtifacts(missing, roots)).toBe(2);
    const unreadable: LcmOrphanStore = {
      listFiles: async () => ["1.lcm-node.log"],
      getArtifact: async () => {
        throw new Error("store exploded");
      },
    };
    expect(await countOrphanArtifacts(unreadable, [root("1")])).toBe(1);
    const missingFile: LcmOrphanStore = {
      listFiles: async () => ["1.lcm-node.log"],
      getArtifactPath: async () => "/nonexistent/1.lcm-node.log",
    };
    expect(await countOrphanArtifacts(missingFile, [root("1")])).toBe(1);
  });

  test("ignores file names that do not match the numeric artifact pattern", async () => {
    const store: LcmOrphanStore = {
      listFiles: async () => [
        "notes.txt",
        "abc.lcm-node.log",
        "dir/2.lcm-raw.log",
        "1.lcm-raw.log",
      ],
      getArtifact: async () => undefined,
    };
    expect(await countOrphanArtifacts(store, [])).toBe(1);
  });

  test("aborts mid-walk with AbortError", async () => {
    const controller = new AbortController();
    const store: LcmOrphanStore = {
      listFiles: async () => ["1.lcm-node.log", "2.lcm-raw.log"],
      getArtifact: async (id: string) => {
        if (id === "1") {
          controller.abort();
          return node({ children: ["2"] });
        }
        return "raw source content";
      },
    };
    try {
      await countOrphanArtifacts(store, [root("1")], {
        signal: controller.signal,
      });
      expect.unreachable("expected AbortError");
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
    }
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      countOrphanArtifacts(store, [root("1")], { signal: preAborted.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("caps node reads at maxNodeReads with DEFAULT_MAX_NODE_READS as the default", async () => {
    expect(DEFAULT_MAX_NODE_READS).toBe(1_000);
    const contents = new Map<string, string>([
      ["1", node({ children: ["2"] })],
      ["2", node({ rawSources: ["5"] })],
      ["5", "raw source content"],
    ]);
    const store: LcmOrphanStore = {
      listFiles: async () => [
        "1.lcm-node.log",
        "2.lcm-node.log",
        "5.lcm-raw.log",
      ],
      getArtifact: async (id: string) => contents.get(id),
    };
    expect(await countOrphanArtifacts(store, [root("1")])).toBe(0);
    expect(
      await countOrphanArtifacts(store, [root("1")], { maxNodeReads: 1 }),
    ).toBe(2);
  });
});

describe("orphanStoreFor", () => {
  test("maps a sessionManager exposing getArtifactManager()", () => {
    const inner = {
      listFiles: () => ["1.lcm-node.log"],
      getPath: (id: string) => `/tmp/${id}.log`,
    };
    const manager = {
      getArtifactManager: () => inner,
      saveArtifact: () => "1",
    };
    const store = orphanStoreFor(manager);
    expect(store.listFiles?.()).toEqual(["1.lcm-node.log"]);
    expect(store.getArtifact).toBeUndefined();
    expect(store.getArtifactPath?.("7")).toBe("/tmp/7.log");
  });

  test("maps a bare artifact manager with listFiles and getArtifact", () => {
    const store = orphanStoreFor({
      listFiles: () => ["2.lcm-raw.log"],
      getArtifact: (id: string) => `content ${id}`,
    });
    expect(store.listFiles?.()).toEqual(["2.lcm-raw.log"]);
    expect(store.getArtifact?.("3")).toBe("content 3");
    expect(store.getArtifactPath).toBeUndefined();
  });

  test("prefers getArtifactPath over getPath when both exist", () => {
    const store = orphanStoreFor({
      listFiles: async () => [],
      getArtifactPath: (id: string) => `/a/${id}.log`,
      getPath: () => "/b",
    });
    expect(store.getArtifactPath?.("9")).toBe("/a/9.log");
  });

  test("keeps methods bound to the artifact manager instance", () => {
    // Real ArtifactManager methods read private fields (this.#dir); a
    // detached reference would fail the brand check. The adapted store must
    // call through the original instance.
    let files = ["1.lcm-node.log"];
    const inner = {
      get files() {
        return files;
      },
      listFiles() {
        return this.files;
      },
      getPath(id: string) {
        return `/dir/${id}-${this.files.length}.log`;
      },
    };
    const store = orphanStoreFor({ getArtifactManager: () => inner });
    expect(store.listFiles?.()).toEqual(["1.lcm-node.log"]);
    files = ["1.lcm-node.log", "2.lcm-raw.log"];
    expect(store.listFiles?.()).toEqual(["1.lcm-node.log", "2.lcm-raw.log"]);
    expect(store.getArtifactPath?.("5")).toBe("/dir/5-2.log");
  });

  test("returns an all-undefined store when nothing is available", () => {
    for (const manager of [{}, null, undefined, 42]) {
      const store = orphanStoreFor(manager);
      expect(store.listFiles).toBeUndefined();
      expect(store.getArtifact).toBeUndefined();
      expect(store.getArtifactPath).toBeUndefined();
    }
  });
});
