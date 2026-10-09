/**
 * scripts/ci/db-tests.ts
 *
 * CI entry point for the pgTAP database suites (`supabase/tests/*.test.sql`),
 * invoked via `npx tsx scripts/ci/db-tests.ts` (npm script `test:db`).
 *
 * Behaviour:
 *   1. Probe Docker with `docker info` (read-only; stderr is ignored because
 *      Docker prints warnings there even on success).
 *   2. Probe the local stack with `npx supabase status`.
 *   3. If either probe fails, print an honest explanation naming the blocker,
 *      list the exact recovery commands, and exit with code 2.
 *   4. Otherwise run `npx supabase db reset` and then `npx supabase test db`,
 *      streaming their output, and propagate the real exit code.
 *
 * A success line is printed ONLY when both commands exited 0.
 *
 * Commands are passed as single strings, which requires a shell; on Windows
 * this means spawnSync with `shell: true`.
 */
import { spawnSync } from "node:child_process";

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a command, capture its output, and never throw on a non-zero exit. */
function capture(command: string): CommandResult {
  const result = spawnSync(command, { shell: true, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Run a command with its output streaming straight to this process' stdio. */
function stream(command: string): number {
  const result = spawnSync(command, {
    shell: true,
    stdio: "inherit",
    windowsHide: true,
  });
  return result.status ?? 1;
}

function reportUnreachable(dockerOk: boolean, supabaseOk: boolean): void {
  const lines: string[] = [
    "Database tests were NOT run: the local Supabase/Postgres database is not reachable.",
  ];

  if (!dockerOk) {
    lines.push(
      "Blocker: Docker's daemon is not running, so `docker info` failed and there is",
      "no Postgres container for Supabase to use.",
    );
  } else if (!supabaseOk) {
    lines.push(
      "Blocker: Docker answered, but `npx supabase status` failed — the local",
      "Supabase stack has not been started.",
    );
  }

  lines.push(
    "",
    "No SQL suite was executed by this script and no success is claimed.",
    "",
    "Starting Docker requires an interactive login. Once Docker Desktop is up, run:",
    "  npx supabase start",
    "  npx supabase db reset",
    "  npx supabase test db",
  );

  console.error(lines.join("\n"));
}

function main(): number {
  const dockerOk = capture("docker info").status === 0;
  const supabaseOk = dockerOk && capture("npx supabase status").status === 0;

  if (!dockerOk || !supabaseOk) {
    reportUnreachable(dockerOk, supabaseOk);
    return 2;
  }

  console.log("Local database is reachable. Resetting it and running the pgTAP suites...");

  const resetCode = stream("npx supabase db reset");
  if (resetCode !== 0) {
    console.error(
      `\`npx supabase db reset\` exited with code ${resetCode}; aborting before the test run.`,
    );
    return resetCode;
  }

  const testCode = stream("npx supabase test db");
  if (testCode !== 0) {
    console.error(`\`npx supabase test db\` exited with code ${testCode}.`);
    return testCode;
  }

  console.log(
    "All database tests passed (`npx supabase db reset` and `npx supabase test db` both exited 0).",
  );
  return 0;
}

process.exitCode = main();
