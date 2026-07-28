import { expect } from "bun:test";
export type SavedArtifact = { id: string; content: string; toolType: string };
export function artifactStore(start = 1) {
  let next = start;
  const saved: SavedArtifact[] = [];
  const store = {
    saved,
    saveArtifact(content: string, toolType: string) {
      const id = String(next++);
      saved.push({ id, content, toolType });
      return id;
    },
    getArtifact(id: string) {
      return saved.find((x) => x.id === id)?.content;
    },
    getArtifactPath(id: string) {
      return store.getArtifact(id);
    },
  };
  return store;
}
export function entry(id: string, text = id): any {
  return { type: "message", id, message: { role: "user", content: text } };
}
export function preparation(
  firstKeptEntryId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    firstKeptEntryId,
    messagesToSummarize: [],
    turnPrefixMessages: [],
    recentMessages: [],
    isSplitTurn: false,
    tokensBefore: 42,
    fileOps: {},
    settings: { strategy: "context-full", remoteEnabled: false },
    ...overrides,
  } as any;
}
export function event(
  prep: any,
  branchEntries: any[] = [],
  overrides: Record<string, unknown> = {},
) {
  return {
    type: "session_before_compact",
    preparation: prep,
    branchEntries,
    signal: new AbortController().signal,
    ...overrides,
  } as any;
}
export function fakeModel(acceptsImage = false) {
  return {
    id: "fake-model",
    input: acceptsImage ? ["text", "image"] : ["text"],
  } as any;
}
export function jsonLines(entries: unknown[]) {
  return entries.map((item) => JSON.stringify(item)).join("\n");
}
export function modelCall(outputs: string[] | string) {
  const queue = Array.isArray(outputs) ? [...outputs] : [outputs];
  const requests: any[] = [];
  const call = async (request: any) => {
    requests.push(request);
    return queue.length > 1 ? queue.shift()! : (queue[0] ?? "");
  };
  return { call, requests };
}
export function expectCancel(result: any) {
  expect(result).toEqual({ cancel: true });
  expect(result).not.toBeUndefined();
}
