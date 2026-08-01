import { describe, expect, test } from "bun:test";
import {
  formatArtifactUri,
  formatRoots,
  isNumericArtifactId,
  LCM_PRESERVE_KEY,
  parseLcmPreserveState,
  parseRenderer,
} from "../src/contracts.ts";

describe("contracts", () => {
  test("parses valid bounded state", () => {
    const state = {
      version: 1 as const,
      generation: 2,
      roots: [
        {
          artifactId: "3",
          level: 0,
          summary: "s",
          sourceEntryCount: 1,
          tokenCount: 2,
        },
      ],
    };
    expect(parseLcmPreserveState(state)).toEqual(state);
  });
  test("rejects hostile state and IDs", () => {
    expect(parseLcmPreserveState({ version: 9 })).toBeUndefined();
    expect(
      parseLcmPreserveState({
        version: 1,
        generation: 0,
        roots: [{ artifactId: "x" }],
      }),
    ).toBeUndefined();
    expect(isNumericArtifactId("01")).toBe(false);
    expect(isNumericArtifactId("00")).toBe(false);
    expect(isNumericArtifactId("-0")).toBe(false);
  });
  test("accepts zero as a numeric artifact id (real OMP stores are 0-based)", () => {
    expect(isNumericArtifactId("0")).toBe(true);
    expect(formatArtifactUri("0")).toBe("artifact://0");
    expect(isNumericArtifactId("00")).toBe(false);
    expect(isNumericArtifactId("-1")).toBe(false);
  });
  test("formats stable roots and links", () => {
    const roots: any[] = [
      {
        artifactId: "7",
        level: 0,
        summary: "alpha",
        sourceEntryCount: 1,
        tokenCount: 2,
      },
      {
        artifactId: "8",
        level: 1,
        summary: "beta",
        sourceEntryCount: 2,
        tokenCount: 3,
      },
    ];
    const text = formatRoots(roots);
    expect(text).toContain("### Root 1\nalpha\nExpand node: artifact://7");
    expect(text).toContain("### Root 2\nbeta\nExpand node: artifact://8");
    expect(formatArtifactUri("7")).toBe("artifact://7");
    expect(formatArtifactUri("x")).toBeUndefined();
    expect(parseRenderer("snapcompact")).toBe("snapcompact");
    expect(parseRenderer("wat")).toBeUndefined();
    expect(LCM_PRESERVE_KEY).toBe("ompLcmArtifactsV1");
  });
});
