#!/usr/bin/env bun
/**
 * Automated live release canary (GAP-030).
 *
 * Chain: `bun pm pack` -> extract the tarball -> install the packed
 * directory into a clean temporary OMP profile (fresh `OMP_PROFILE` and
 * `PI_CODING_AGENT_DIR`) -> verify the install via `omp plugin list` -> run
 * the opt-in live integration suite (`LCM_LIVE_INTEGRATION=1`). Any step
 * failure exits non-zero, so the release gate fails closed. The temporary
 * profile and agent state dir are removed on the way out; cleanup errors
 * never mask a real failure.
 *
 * The install step validates the packed artifact end to end (content,
 * manifest, registration) in a fresh profile; the live step runs the repo's
 * integration suite, which builds an in-memory session from `src/`. A
 * known limitation: the live step exercises the source tree, not the
 * installed copy.
 *
 * Requirements: `omp` CLI and `tar` on PATH, configured OpenAI-Codex
 * credentials in the environment, and network access.
 */

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const REPO_ROOT = join(import.meta.dir, "..");
const TARBALL_PREFIX = "omp-lcm-inspired-compaction-";

/** Spawn with inherited stdio; resolves to ok + exit code, or the spawn error. */
async function run(
  label: string,
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; code: number | null; error?: unknown }> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      cwd: REPO_ROOT,
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    return { ok: code === 0, code };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, code: null, error: `${label}: ${reason}` };
  }
}

/** Spawn capturing stdout; used to verify the install via `omp plugin list`. */
async function capture(
  label: string,
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{
  ok: boolean;
  code: number | null;
  stdout: string;
  error?: unknown;
}> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      cwd: REPO_ROOT,
      env,
      stdout: "pipe",
      stderr: "inherit",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { ok: code === 0, code, stdout };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, code: null, stdout: "", error: `${label}: ${reason}` };
  }
}

/** True when a spawn failed because the binary is not on PATH. */
function isMissingBinary(error: unknown): boolean {
  if (error instanceof Error) {
    if ("code" in error && error.code === "ENOENT") return true;
    return error.message.includes("ENOENT");
  }
  return typeof error === "string" && error.includes("ENOENT");
}

/** Newest `omp-lcm-inspired-compaction-*.tgz` in the repo root, or null. */
async function newestTarball(): Promise<string | null> {
  const entries = await readdir(REPO_ROOT);
  const tarballs = entries.filter(
    (name) => name.startsWith(TARBALL_PREFIX) && name.endsWith(".tgz"),
  );
  if (tarballs.length === 0) return null;
  let newest = tarballs[0];
  let newestMs = (await stat(join(REPO_ROOT, newest))).mtimeMs;
  for (const name of tarballs.slice(1)) {
    const ms = (await stat(join(REPO_ROOT, name))).mtimeMs;
    if (ms > newestMs) {
      newest = name;
      newestMs = ms;
    }
  }
  return newest;
}

class CanaryFailure extends Error {}

function fail(step: string, reason: string): never {
  // Throw (not process.exit) so main()'s finally cleanup always runs.
  throw new CanaryFailure(`[canary] FAILED at ${step}: ${reason}`);
}

async function main(): Promise<void> {
  let tmpDir: string | null = null;
  let profileDir: string | null = null;
  try {
    // 1. Pack the plugin.
    const pack = await run("pack", "bun", ["pm", "pack"], process.env);
    if (!pack.ok) fail("pack", pack.error ?? `exit code ${pack.code}`);
    const tarball = await newestTarball();
    if (tarball === null) {
      fail("pack", `no ${TARBALL_PREFIX}*.tgz found in repo root`);
    }
    console.log(`[canary] pack: ok (${tarball})`);

    // 2. Extract the packed artifact, install it into a clean temporary OMP
    //    profile, then verify the install. `omp plugin install` accepts a
    //    directory or a marketplace name, not a bare tarball, so the packed
    //    directory is what gets installed.
    tmpDir = await mkdtemp(join(tmpdir(), "omp-lcm-canary-"));
    const packedDir = join(tmpDir, "package");
    const extract = await run(
      "extract",
      "tar",
      ["-xzf", join(REPO_ROOT, tarball), "-C", tmpDir],
      process.env,
    );
    if (!extract.ok) {
      fail("extract", extract.error ?? `exit code ${extract.code}`);
    }
    try {
      await stat(join(packedDir, "package.json"));
    } catch {
      fail("extract", "packed artifact is missing package.json");
    }
    const profile = `lcm-canary-${randomUUID().slice(0, 8)}`;
    // Named profiles always resolve under the config root (~/.omp by default,
    // or PI_CONFIG_DIR if the operator overrides it); PI_CODING_AGENT_DIR is
    // ignored while a named profile is active. XDG redirects only engage for
    // pre-existing profile paths, which the canary never creates, so the
    // home-based path below is deterministic for our profile name.
    profileDir = join(
      homedir(),
      process.env.PI_CONFIG_DIR || ".omp",
      "profiles",
      profile,
    );
    const env: Record<string, string | undefined> = {
      ...process.env,
      OMP_PROFILE: profile,
    };
    const install = await run("install", "omp", ["plugin", "install", packedDir], env);
    if (!install.ok) {
      if (install.error !== undefined && isMissingBinary(install.error)) {
        fail("install", "omp CLI not found on PATH");
      }
      fail("install", install.error ?? `exit code ${install.code}`);
    }
    console.log(`[canary] install: ok (profile ${profile})`);

    const listed = await capture("plugin list", "omp", ["plugin", "list"], env);
    if (!listed.ok) {
      fail("plugin list", listed.error ?? `exit code ${listed.code}`);
    }
    if (!listed.stdout.includes("omp-lcm-inspired-compaction")) {
      fail("plugin list", "omp-lcm-inspired-compaction not listed");
    }
    console.log("[canary] plugin list: ok (omp-lcm-inspired-compaction installed)");

    // 3. Live integration against configured OpenAI-Codex credentials.
    // The suite builds in-memory sessions from `src/` and does not use the
    // installed plugin, so the isolated profile env must NOT carry over here:
    // credential resolution (auth storage, /login state) lives in the
    // operator's default profile, and an empty canary profile would fail the
    // live step with "No API key found" regardless of the code.
    const live = await run(
      "live integration",
      "bun",
      ["test", "test/native-replay.integration.test.ts"],
      { ...process.env, LCM_LIVE_INTEGRATION: "1" },
    );
    if (!live.ok) {
      fail("live integration", live.error ?? `exit code ${live.code}`);
    }
    console.log("[canary] live integration: ok");
    console.log("[canary] PASS");
  } finally {
    // Best-effort cleanup; never hide a real failure.
    if (tmpDir !== null) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    if (profileDir !== null) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof CanaryFailure) {
    console.error(error.message);
  } else {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[canary] FAILED: ${reason}`);
  }
  process.exit(1);
}
