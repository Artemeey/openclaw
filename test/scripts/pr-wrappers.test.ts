// PR wrapper tests cover maintainer helper command delegation.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyPrWrapperFixture,
  readPrAnchorRuntimePaths,
  readPrRemoteOnlyTrustPaths,
} from "./pr-wrapper-fixture.js";

function readScript(path: string): string {
  return readFileSync(path, "utf8");
}

const anchorSubstitutionNotice = (repo: string) =>
  `scripts/pr wrapper in this worktree differs from origin/main; running the canonical checkout's wrapper (matches the origin/main trust anchor): ${repo}`;
const itPosix = process.platform === "win32" ? it.skip : it;

function makeMismatchedWrapperRepo(dispatchBody = 'echo "canonical wrapper executed";') {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "openclaw-pr-dev-wrapper-")));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const canonicalPath = join(root, "canonical");
  const linkedPath = join(root, "linked");
  const originPath = join(root, "origin.git");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  // This fixture exercises wrapper trust routing, not the host command inventory.
  for (const command of ["pnpm", "rg"]) {
    const commandPath = join(bin, command);
    writeFileSync(commandPath, "#!/bin/sh\nexit 0\n");
    chmodSync(commandPath, 0o755);
  }
  // Deterministic gh stub: main-only subcommands fail fast on the base-branch
  // gate instead of reaching the network, proving which wrapper actually ran.
  const ghStub = join(bin, "gh");
  writeFileSync(
    ghStub,
    '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then\n  printf \'{"baseRefName":"not-main"}\\n\'\n  exit 0\nfi\nexit 0\n',
  );
  chmodSync(ghStub, 0o755);

  const fixtureEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: fixtureEnv,
      stdio: "pipe",
    });
    expect(result.status, `git ${args.join(" ")}\n${result.stderr}`).toBe(0);
    return result;
  };

  git(root, ["init", "--bare", "-b", "main", originPath]);
  git(root, ["init", "-b", "main", canonicalPath]);
  const canonical = realpathSync(canonicalPath);
  const origin = realpathSync(originPath);
  copyPrWrapperFixture(canonical);
  writeFileSync(
    join(canonical, "scripts", "lib", "plain-gh.sh"),
    "resolve_plain_gh_bin() { printf '/usr/bin/true\\n'; }\ngh_plain() { :; }\n",
  );
  // Marker stub committed to main (the origin/main anchor), so tests can tell
  // an anchor-substituted canonical run apart from a local wrapper run.
  writeFileSync(
    join(canonical, "scripts", "pr-lib", "gates.sh"),
    `ci_dispatch() { ${dispatchBody} }\n`,
  );
  chmodSync(join(canonical, "scripts", "pr"), 0o755);

  git(canonical, ["config", "user.name", "OpenClaw Test"]);
  git(canonical, ["config", "user.email", "test@example.invalid"]);
  git(canonical, ["config", "commit.gpgSign", "false"]);
  git(canonical, ["config", "core.hooksPath", "/dev/null"]);
  git(canonical, ["remote", "add", "origin", origin]);
  git(canonical, ["add", "scripts", ".github", "packages"]);
  git(canonical, ["commit", "-m", "test: canonical wrapper"]);
  git(canonical, ["push", "-u", "origin", "main"]);
  const anchorRevision = git(canonical, ["rev-parse", "HEAD"]).stdout.trim();
  git(canonical, ["worktree", "add", "-b", "feature", linkedPath, "main"]);

  const linked = realpathSync(linkedPath);
  git(linked, ["config", "user.name", "OpenClaw Test"]);
  git(linked, ["config", "user.email", "test@example.invalid"]);
  git(linked, ["config", "commit.gpgSign", "false"]);
  expect(git(linked, ["rev-parse", "refs/remotes/origin/main"]).stdout.trim()).toBe(
    git(canonical, ["rev-parse", "main"]).stdout.trim(),
  );

  writeFileSync(
    join(linked, "scripts", "pr-lib", "gates.sh"),
    'ci_dispatch() { echo "local wrapper executed"; }\n',
  );
  git(linked, ["add", "scripts/pr-lib/gates.sh"]);
  git(linked, ["commit", "-m", "test: local wrapper"]);
  const localRevision = git(linked, ["rev-parse", "HEAD"]).stdout.trim();

  return {
    anchorRevision,
    bin,
    canonical,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    env: fixtureEnv,
    git,
    linked,
    localRevision,
    root,
  };
}

function resolveCommand(command: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) {
      return realpathSync(candidate);
    }
  }
  throw new Error(`command not found in test PATH: ${command}`);
}

function parseSubcommandClassifications(script: string): Map<string, string> {
  const start = script.indexOf("# PR_SUBCOMMAND_CLASSIFICATIONS_BEGIN");
  const end = script.indexOf("# PR_SUBCOMMAND_CLASSIFICATIONS_END");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const table = script.slice(start, end);
  const classifications = new Map<string, string>();
  const armPattern = /^\s+([^\n)]+)\)\s*\n\s+printf '(landing|advisory)\\n'/gm;
  for (const match of table.matchAll(armPattern)) {
    const commandGroup = match[1];
    const classification = match[2];
    if (commandGroup === undefined || classification === undefined) {
      throw new Error("classification regexp returned incomplete captures");
    }
    for (const command of commandGroup.split("|").map((value) => value.trim())) {
      classifications.set(command, classification);
    }
  }
  return classifications;
}

function parseDispatchedSubcommands(script: string): string[] {
  const start = script.lastIndexOf('  case "$cmd" in');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = script.indexOf("\n  esac", start);
  expect(end).toBeGreaterThan(start);
  const commands: string[] = [];
  const armPattern = /^\s{4}([^\n)]+)\)/gm;
  for (const match of script.slice(start, end).matchAll(armPattern)) {
    const commandGroup = match[1];
    if (commandGroup === undefined) {
      throw new Error("dispatch regexp returned an incomplete capture");
    }
    commands.push(...commandGroup.split("|").map((value) => value.trim()));
  }
  return commands.filter((command) => command !== "*");
}

function runtimeRelativeDependencies(file: string): string[] {
  const source = readScript(file);
  const dependencies = new Set<string>();
  if (/\.[cm]?[jt]sx?$/u.test(file)) {
    const modulePattern = /(?:from\s+|import\s*\(|new URL\s*\()\s*["'](\.{1,2}\/[^"']+)["']/gu;
    for (const match of source.matchAll(modulePattern)) {
      const specifier = match[1];
      if (specifier) {
        dependencies.add(posix.normalize(posix.join(posix.dirname(file), specifier)));
      }
    }
  }
  for (const line of source.split("\n")) {
    const fromScriptsDir = /source "\$script_parent_dir\/([^"]+)"/u.exec(line)?.[1];
    if (fromScriptsDir) {
      dependencies.add(posix.join("scripts", fromScriptsDir));
      continue;
    }
    const siblingSource = /source .*\/([^/"$]+\.sh)"/u.exec(line)?.[1];
    if (siblingSource) {
      dependencies.add(posix.join(posix.dirname(file), siblingSource));
    }
  }
  return [...dependencies];
}

describe("scripts/pr wrappers", () => {
  it("keeps the materialized anchor manifest valid and closed over relative imports", () => {
    const runtimePaths = readPrAnchorRuntimePaths();
    const remoteOnlyPaths = readPrRemoteOnlyTrustPaths();
    const runtimePathSet = new Set(runtimePaths);

    expect(runtimePaths.length).toBeGreaterThan(0);
    expect(runtimePathSet.size).toBe(runtimePaths.length);
    expect(runtimePathSet).toContain("scripts/pr");
    expect(runtimePathSet).toContain("scripts/pr-lib/anchor-runtime-paths.txt");
    for (const file of runtimePaths) {
      expect(file).toMatch(/^[A-Za-z0-9@._+/-]+$/u);
      expect(file.startsWith("/")).toBe(false);
      expect(file.startsWith("./")).toBe(false);
      expect(file.startsWith("-")).toBe(false);
      expect(file.split("/")).not.toContain("");
      expect(file.split("/")).not.toContain(".");
      expect(file.split("/")).not.toContain("..");
      expect(posix.normalize(file)).toBe(file);
      expect(lstatSync(file).isFile()).toBe(true);
      expect(lstatSync(file).isSymbolicLink()).toBe(false);
      for (const dependency of runtimeRelativeDependencies(file)) {
        expect(runtimePathSet.has(dependency), `${file} imports ${dependency}`).toBe(true);
      }
    }
    for (const file of remoteOnlyPaths) {
      expect(runtimePathSet.has(file), file).toBe(false);
    }
  });

  it("keeps the main PR helper usage and command table aligned", () => {
    const script = readScript("scripts/pr");
    const runtimePaths = readPrAnchorRuntimePaths();

    expect(script).toContain("export NO_COLOR=1");
    expect(script).toContain("unset COLORTERM");
    expect(script).toContain('source "$script_parent_dir/lib/plain-gh.sh"');
    expect(script).toContain("for cmd in git gh jq rg pnpm node");
    expect(script).not.toContain("gh() {");
    expect(runtimePaths).toContain("scripts/watch-pr-ci.mjs");
    expect(runtimePaths).toContain("scripts/watch-pr-ci.mts");
    expect(runtimePaths).toContain("scripts/verify-pr-hosted-gates.mjs");
    expect(runtimePaths).toContain("scripts/verify-pr-hosted-gates.mts");
    expect(runtimePaths).toContain("scripts/lib/tsx-cli-shim.mjs");
    expect(runtimePaths).toContain("scripts/tsx.mjs");
    expect(runtimePaths).toContain("scripts/lib/plain-gh.mjs");
    expect(runtimePaths).toContain("scripts/lib/direct-run.mjs");
    expect(script).toContain("scripts/pr review-init <PR>");
    expect(script).toContain("scripts/pr prepare-run <PR>");
    expect(script).toContain("scripts/pr ci-dispatch <PR>");
    expect(script).toContain("scripts/pr merge-run <PR> [--auto-merge]");
    expect(script).toContain("OPENCLAW_PR_AUTO_MERGE=1 is equivalent");
    expect(script).toContain("Required commands: git, gh, jq, rg (ripgrep), pnpm, node.");
    expect(script).toContain('review_init "$pr"');
    expect(script).toContain('prepare_run "$pr"');
    expect(script).toContain('ci_dispatch "$pr"');
    expect(script).toContain('merge_run "$pr" "$auto_merge"');
    expect(script).toContain('require_main_target_pr "${1-}"');
    expect(script).toContain("only support PRs targeting main");
  });

  itPosix("preserves the caller's gh route environment through startup", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      cpSync("scripts/lib/plain-gh.sh", join(fixture.canonical, "scripts/lib/plain-gh.sh"));
      writeFileSync(
        join(fixture.canonical, "scripts/pr-lib/worktree.sh"),
        `list_pr_worktrees() { /bin/sh -c 'printf "%s\\n" "\${OPENCLAW_GH_BIN-absent}"'; }\n`,
      );
      for (const override of [undefined, "", join(fixture.bin, "gh")]) {
        const result = spawnSync(join(fixture.canonical, "scripts/pr"), ["ls"], {
          cwd: fixture.canonical,
          encoding: "utf8",
          env: { ...fixture.env, OPENCLAW_GH_BIN: override },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(`${override ?? "absent"}\n`);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("routes cached reads and writer-sensitive operations through their owning gh seams", () => {
    const script = readScript("scripts/pr");
    const common = readScript("scripts/pr-lib/common.sh");
    const worktree = readScript("scripts/pr-lib/worktree.sh");
    const review = readScript("scripts/pr-lib/review.sh");
    const push = readScript("scripts/pr-lib/push.sh");
    const merge = readScript("scripts/pr-lib/merge.sh");

    expect(script).toContain('base_json=$(read_pr_view_json "$pr" "baseRefName")');
    expect(common).toContain('gh pr view "$pr" --json "$fields"');
    expect(worktree).toContain('metadata=$(read_pr_view_json "$pr"');
    expect(review).toContain('gh_plain pr edit "$pr" --add-assignee "$reviewer"');
    expect(push).toContain('gh_plain api graphql --input - <<< "$payload"');
    expect(merge).toContain('gh_plain pr merge "$pr"');
    expect(merge).toContain('"repos/$repo_nwo/issues/$pr/comments"');
    expect(merge).toContain("--jq '.html_url // empty'");
    expect(merge).toContain('git push --force-with-lease="refs/heads/$head_ref:$PREP_HEAD_SHA"');
  });

  itPosix("fails loudly at preflight when ripgrep is unavailable", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      rmSync(join(fixture.bin, "rg"));
      for (const command of ["bash", "basename", "dirname", "git", "gh", "jq", "pnpm", "node"]) {
        rmSync(join(fixture.bin, command), { force: true });
        symlinkSync(resolveCommand(command), join(fixture.bin, command));
      }

      const result = spawnSync(join(fixture.canonical, "scripts", "pr"), ["ls"], {
        cwd: fixture.canonical,
        encoding: "utf8",
        env: {
          ...fixture.env,
          PATH: fixture.bin,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Missing required command(s): rg");
      expect(result.stderr).toContain("Install ripgrep and retry:");
    } finally {
      fixture.cleanup();
    }
  });

  it("classifies every dispatched subcommand", () => {
    const script = readScript("scripts/pr");
    const classifications = parseSubcommandClassifications(script);
    const dispatched = parseDispatchedSubcommands(script);

    expect([...classifications.keys()].toSorted()).toEqual(
      [...dispatched, "lock-recover"].toSorted(),
    );
    expect(classifications.get("ls")).toBe("advisory");
    expect(classifications.get("ci-dispatch")).toBe("advisory");
    for (const command of dispatched.filter((value) => !["ls", "ci-dispatch"].includes(value))) {
      expect(classifications.get(command), command).toBe("landing");
    }
  });

  itPosix("requires a separate operator confirmation for merge recovery", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      for (const args of [
        ["123", "a".repeat(40)],
        ["123", "", "--confirmed-operator-recovery"],
        ["123", "not-an-outcome", "--confirmed-operator-recovery"],
        ["123", "a".repeat(40), "--confirmed-no-running-tools"],
        ["123", "a".repeat(40), "--confirmed-operator-recovery", "--auto-merge"],
      ]) {
        const result = spawnSync(
          join(fixture.canonical, "scripts", "pr"),
          ["merge-recover", ...args],
          { cwd: fixture.canonical, encoding: "utf8", env: fixture.env },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
        expect(result.stdout).toContain("Usage:");
        expect(result.stderr).not.toContain("only support PRs targeting main");
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("runs a mismatched advisory wrapper locally with an explicit developer opt-in", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      const cliResult = spawnSync(
        join(fixture.linked, "scripts", "pr"),
        ["--dev-wrapper", "ci-dispatch", "123"],
        {
          cwd: fixture.linked,
          encoding: "utf8",
          env: fixture.env,
        },
      );
      expect(cliResult.status, `${cliResult.stderr}\n${cliResult.stdout}`).toBe(0);
      expect(cliResult.stdout).toContain("local wrapper executed");
      expect(cliResult.stderr).toContain(
        `WARNING: running local scripts/pr revision ${fixture.localRevision} via dev-wrapper opt-in.`,
      );
      expect(cliResult.stderr).toContain("subcommand 'ci-dispatch' is classified advisory.");
      expect(cliResult.stderr).toContain("landing subcommands remain refused");

      const envResult = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: { ...fixture.env, OPENCLAW_PR_DEV_WRAPPER: "1" },
      });
      expect(envResult.status, `${envResult.stderr}\n${envResult.stdout}`).toBe(0);
      expect(envResult.stdout).toContain("local wrapper executed");
      expect(envResult.stderr).toContain("subcommand 'ci-dispatch' is classified advisory.");
    } finally {
      fixture.cleanup();
    }
  });

  it("substitutes the anchor-matching canonical wrapper for a mismatched worktree without opt-in", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: fixture.env,
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("canonical wrapper executed");
      expect(result.stdout).not.toContain("local wrapper executed");
      expect(result.stderr).toContain(anchorSubstitutionNotice(fixture.canonical));
      expect(result.stderr).not.toContain("Refusing to silently substitute");
    } finally {
      fixture.cleanup();
    }
  });

  it.each(["prepare-run", "merge-recover"])(
    "routes mismatched %s to the canonical wrapper despite opt-in",
    (command) => {
      const fixture = makeMismatchedWrapperRepo();
      try {
        const result = spawnSync(
          join(fixture.linked, "scripts", "pr"),
          [
            "--dev-wrapper",
            command,
            "123",
            ...(command === "merge-recover"
              ? ["a".repeat(40), "--confirmed-operator-recovery"]
              : []),
          ],
          { cwd: fixture.linked, encoding: "utf8", env: fixture.env },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          `subcommand '${command}' is classified landing; dev-wrapper opt-in is unavailable.`,
        );
        expect(result.stderr).toContain(anchorSubstitutionNotice(fixture.canonical));
        // The stubbed gh reports a non-main base: reaching this gate proves the
        // canonical wrapper ran instead of the mismatched local one.
        expect(result.stderr).toContain(
          "scripts/pr prepare and merge commands only support PRs targeting main; PR #123 targets not-main.",
        );
        expect(result.stdout).not.toContain("local wrapper executed");
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("substitutes the canonical wrapper for a stale-base worktree once main moves the wrapper", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      // Stale worktree: created at the pushed main base, no local wrapper edits.
      const stale = join(fixture.root, "stale");
      const baseline = fixture.git(fixture.canonical, ["rev-parse", "main"]).stdout.trim();
      fixture.git(fixture.canonical, ["worktree", "add", "-b", "stale-feature", stale, baseline]);

      // main's wrapper then advances and the canonical checkout tracks it.
      writeFileSync(
        join(fixture.canonical, "scripts", "pr-lib", "gates.sh"),
        'ci_dispatch() { echo "canonical v2 executed"; }\n',
      );
      fixture.git(fixture.canonical, ["add", "scripts/pr-lib/gates.sh"]);
      fixture.git(fixture.canonical, ["commit", "-m", "test: wrapper v2"]);
      fixture.git(fixture.canonical, ["push", "origin", "main"]);

      const result = spawnSync(join(stale, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: stale,
        encoding: "utf8",
        env: fixture.env,
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("canonical v2 executed");
      expect(result.stderr).toContain(anchorSubstitutionNotice(fixture.canonical));
      expect(result.stderr).not.toContain("Refusing to silently substitute");
    } finally {
      fixture.cleanup();
    }
  });

  // Parks the canonical checkout on a diverging branch so neither the linked
  // worktree nor canonical matches the fetched origin/main anchor — the shape
  // that previously refused and forced a rebase.
  function parkCanonicalOffAnchor(fixture: ReturnType<typeof makeMismatchedWrapperRepo>) {
    fixture.git(fixture.canonical, ["checkout", "-b", "parked"]);
    writeFileSync(
      join(fixture.canonical, "scripts", "pr-lib", "gates.sh"),
      'ci_dispatch() { echo "parked canonical executed"; }\n',
    );
    fixture.git(fixture.canonical, ["add", "scripts/pr-lib/gates.sh"]);
    fixture.git(fixture.canonical, ["commit", "-m", "test: parked canonical wrapper"]);
  }

  it("materializes the origin/main anchor wrapper when canonical is parked elsewhere", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      parkCanonicalOffAnchor(fixture);
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: fixture.env,
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      // The anchor (pushed main) marker proves materialized anchor code ran,
      // not the linked worktree's wrapper and not the parked canonical one.
      expect(result.stdout).toContain("canonical wrapper executed");
      expect(result.stdout).not.toContain("local wrapper executed");
      expect(result.stdout).not.toContain("parked canonical executed");
      expect(result.stderr).toContain(
        "running wrapper code materialized from the refs/remotes/origin/main trust anchor",
      );
      expect(result.stderr).not.toContain("Refusing to silently substitute");
    } finally {
      fixture.cleanup();
    }
  });

  it("initializes stamped review artifacts through the materialized anchor", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      const reviewRoot = join(fixture.canonical, ".worktrees", "pr-123");
      fixture.git(fixture.canonical, [
        "worktree",
        "add",
        "--detach",
        reviewRoot,
        fixture.localRevision,
      ]);
      mkdirSync(join(reviewRoot, ".local"));
      writeFileSync(join(reviewRoot, ".local", "pr-meta.env"), "PR_NUMBER=123\n");
      writeFileSync(
        join(reviewRoot, ".local", "pr-meta.json"),
        JSON.stringify({ number: 123, headRefOid: fixture.localRevision, files: [] }),
      );
      parkCanonicalOffAnchor(fixture);
      const result = spawnSync(
        join(fixture.linked, "scripts", "pr"),
        ["review-artifacts-init", "123"],
        {
          cwd: fixture.linked,
          encoding: "utf8",
          env: { ...fixture.env, TMPDIR: fixture.root },
        },
      );
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stderr).toContain("running wrapper code materialized from");
      expect(JSON.parse(readScript(join(reviewRoot, ".local", "review.json"))).pr).toEqual({
        number: 123,
        headSha: fixture.localRevision,
      });
      expect(readScript(join(reviewRoot, ".local", "review.md")).split("\n")[0]).toBe(
        `Review artifact for PR #123 at ${fixture.localRevision}`,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("starts the hosted verifier from a dependency-less PR worktree", () => {
    const fixture = makeMismatchedWrapperRepo(
      'node "$script_parent_dir/verify-pr-hosted-gates.mjs" --anchor-proof;',
    );
    try {
      symlinkSync(
        realpathSync("node_modules"),
        join(fixture.canonical, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      parkCanonicalOffAnchor(fixture);
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: {
          ...fixture.env,
          TMPDIR: fixture.root,
        },
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("Unknown option: --anchor-proof");
      expect(`${result.stdout}${result.stderr}`).not.toContain("ERR_MODULE_NOT_FOUND");
    } finally {
      fixture.cleanup();
    }
  });

  it("uses canonical dependencies without caller TSX path aliases", () => {
    const fixture = makeMismatchedWrapperRepo(
      'node "$script_parent_dir/verify-pr-hosted-gates.mjs" --anchor-proof;',
    );
    try {
      symlinkSync(
        realpathSync("node_modules"),
        join(fixture.canonical, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      writeFileSync(
        join(fixture.linked, "caller-dependency.mts"),
        'throw new Error("caller workspace dependency executed");\n',
      );
      writeFileSync(
        join(fixture.linked, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            paths: {
              minimatch: ["./caller-dependency.mts"],
              "@openclaw/normalization-core/record-coerce": ["./caller-dependency.mts"],
            },
          },
        }),
      );
      fixture.git(fixture.linked, ["add", "caller-dependency.mts", "tsconfig.json"]);
      fixture.git(fixture.linked, ["commit", "-m", "test: caller-owned dependency aliases"]);
      parkCanonicalOffAnchor(fixture);
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: { ...fixture.env, TMPDIR: fixture.root },
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("Unknown option: --anchor-proof");
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        "caller workspace dependency executed",
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain("ERR_MODULE_NOT_FOUND");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects legacy root-only anchor handoffs instead of executing a partial archive", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      const result = spawnSync(join(fixture.canonical, "scripts", "pr"), ["ls"], {
        cwd: fixture.canonical,
        encoding: "utf8",
        env: {
          ...fixture.env,
          OPENCLAW_PR_ANCHOR_REPO_ROOT: fixture.canonical,
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("legacy scripts/pr anchor handoff");
      expect(result.stdout).not.toContain("canonical wrapper executed");
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ["empty entry", "scripts/pr\n\nscripts/pr-lib/anchor-runtime-paths.txt\n"],
    ["absolute path", "/scripts/pr\n"],
    ["dot path", "./scripts/pr\n"],
    ["parent traversal", "scripts/pr-lib/../pr\n"],
    ["duplicate path", "scripts/pr\nscripts/pr\n"],
    ["unsafe syntax", "scripts/pr path\n"],
  ])("rejects an anchor runtime manifest with %s", (_label, manifest) => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      fixture.git(fixture.canonical, ["checkout", "main"]);
      writeFileSync(join(fixture.canonical, "scripts/pr-lib/anchor-runtime-paths.txt"), manifest);
      fixture.git(fixture.canonical, ["add", "scripts/pr-lib/anchor-runtime-paths.txt"]);
      fixture.git(fixture.canonical, ["commit", "-m", "test: invalid anchor manifest"]);
      fixture.git(fixture.canonical, ["push", "origin", "main"]);
      fixture.git(fixture.linked, ["fetch", "origin", "main"]);
      parkCanonicalOffAnchor(fixture);

      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: { ...fixture.env, TMPDIR: fixture.root },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid scripts/pr anchor runtime manifest");
      expect(result.stdout).not.toContain("canonical wrapper executed");
    } finally {
      fixture.cleanup();
    }
  });

  it("uses one frozen anchor SHA when the remote-tracking ref moves during selection", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      fixture.git(fixture.canonical, ["checkout", "main"]);
      writeFileSync(
        join(fixture.canonical, "scripts/pr-lib/gates.sh"),
        'ci_dispatch() { echo "moved anchor executed"; }\n',
      );
      fixture.git(fixture.canonical, ["add", "scripts/pr-lib/gates.sh"]);
      fixture.git(fixture.canonical, ["commit", "-m", "test: moved anchor"]);
      const movedAnchor = fixture.git(fixture.canonical, ["rev-parse", "HEAD"]).stdout.trim();
      fixture.git(fixture.linked, [
        "update-ref",
        "refs/remotes/origin/main",
        fixture.anchorRevision,
      ]);
      parkCanonicalOffAnchor(fixture);

      const realGit = resolveCommand("git");
      const movedMarker = join(fixture.root, "anchor-moved");
      writeFileSync(
        join(fixture.bin, "git"),
        `#!/bin/sh
if [ ! -e "${movedMarker}" ]; then
  case " $* " in
    *" refs/remotes/origin/main"*)
      output=$("${realGit}" "$@") || exit $?
      "${realGit}" -C "${fixture.linked}" update-ref refs/remotes/origin/main "${movedAnchor}"
      : > "${movedMarker}"
      printf '%s\n' "$output"
      exit 0
      ;;
  esac
fi
exec "${realGit}" "$@"
`,
      );
      chmodSync(join(fixture.bin, "git"), 0o755);

      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: { ...fixture.env, TMPDIR: fixture.root },
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("canonical wrapper executed");
      expect(result.stdout).not.toContain("moved anchor executed");
      expect(result.stderr).toContain(fixture.anchorRevision.slice(0, 12));
      expect(result.stderr).not.toContain(movedAnchor.slice(0, 12));
    } finally {
      fixture.cleanup();
    }
  });

  it("trusts remote-only publisher inputs without archiving them locally", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      const publisher = join(fixture.linked, "scripts/pr-crabbox-gate-publisher.mjs");
      writeFileSync(publisher, `${readScript(publisher)}\n// uncommitted publisher drift\n`);
      const dirty = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: fixture.env,
      });
      expect(dirty.status).toBe(1);
      expect(dirty.stderr).toContain("wrapper files have uncommitted changes");
      fixture.git(fixture.linked, ["restore", "scripts/pr-crabbox-gate-publisher.mjs"]);

      parkCanonicalOffAnchor(fixture);
      const realGit = resolveCommand("git");
      const archiveArgs = join(fixture.root, "archive-args");
      writeFileSync(
        join(fixture.bin, "git"),
        `#!/bin/sh
case " $* " in
  *" archive "*)
    printf '%s\n' "$@" > "${archiveArgs}"
    ;;
esac
exec "${realGit}" "$@"
`,
      );
      chmodSync(join(fixture.bin, "git"), 0o755);

      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: { ...fixture.env, TMPDIR: fixture.root },
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      const archived = readScript(archiveArgs).split("\n");
      for (const file of readPrAnchorRuntimePaths()) {
        expect(archived, file).toContain(file);
      }
      for (const file of readPrRemoteOnlyTrustPaths()) {
        expect(archived, file).not.toContain(file);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("routes a mismatched landing subcommand through the materialized anchor", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      parkCanonicalOffAnchor(fixture);
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["prepare-run", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: fixture.env,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "running wrapper code materialized from the refs/remotes/origin/main trust anchor",
      );
      // The stubbed gh reports a non-main base: reaching this gate proves the
      // materialized anchor wrapper ran the landing subcommand.
      expect(result.stderr).toContain(
        "scripts/pr prepare and merge commands only support PRs targeting main; PR #123 targets not-main.",
      );
      expect(result.stderr).not.toContain("Refusing to silently substitute");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps the refusal when the anchor wrapper predates the handoff contract", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      // Rewrite origin/main's scripts/pr to an entrypoint without the
      // versioned handoff marker, as pre-fix anchors are.
      fixture.git(fixture.canonical, ["checkout", "main"]);
      const legacy = readScript(join(fixture.canonical, "scripts", "pr")).replaceAll(
        "OPENCLAW_PR_ANCHOR_HANDOFF_VERSION",
        "OPENCLAW_PR_LEGACY_UNSUPPORTED",
      );
      writeFileSync(join(fixture.canonical, "scripts", "pr"), legacy);
      fixture.git(fixture.canonical, ["add", "scripts/pr"]);
      fixture.git(fixture.canonical, ["commit", "-m", "test: legacy anchor wrapper"]);
      fixture.git(fixture.canonical, ["push", "origin", "main"]);
      fixture.git(fixture.linked, ["fetch", "origin", "main"]);
      parkCanonicalOffAnchor(fixture);
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: fixture.env,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Refusing to silently substitute");
      expect(result.stdout).not.toContain("canonical wrapper executed");
      expect(result.stdout).not.toContain("local wrapper executed");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps merge wrapper modes delegated to the main PR helper", () => {
    const script = readScript("scripts/pr-merge");

    expect(script).toContain("scripts/pr-merge <PR>");
    expect(script).toContain('exec "$base" merge-verify "$1"');
    expect(script).toContain('exec "$base" merge-verify "$pr"');
    expect(script).toContain('exec "$base" merge-run "$pr"');
  });

  it("defaults to squash and allows commit-preserving merge methods", () => {
    const script = readScript("scripts/pr-lib/merge.sh");

    expect(script).toContain("OPENCLAW_PR_MERGE_METHOD:-squash");
    expect(script).toContain("--squash");
    expect(script).toContain("--merge");
    expect(script).toContain("--rebase");
    expect(script).toContain("'Merged via %s.");
    expect(script).toContain("--auto");
    expect(script).toContain('--match-head-commit "$PREP_HEAD_SHA"');
  });

  it("keeps prepare wrapper modes delegated to the main PR helper", () => {
    const script = readScript("scripts/pr-prepare");

    expect(script).toContain("scripts/pr-prepare <init|validate-commit|gates|push|run> <PR>");
    for (const mode of ["init", "validate-commit", "gates", "push", "run"]) {
      expect(script).toContain(`${mode})`);
    }
    expect(script).toContain('exec "$base" prepare-init "$pr"');
    expect(script).toContain('exec "$base" prepare-validate-commit "$pr"');
    expect(script).toContain('exec "$base" prepare-gates "$pr"');
    expect(script).toContain('exec "$base" prepare-push "$pr"');
    expect(script).toContain('exec "$base" prepare-run "$pr"');
  });

  it("keeps review wrapper delegated to review-init", () => {
    const script = readScript("scripts/pr-review");

    expect(script).toContain('base="$script_dir/pr"');
    expect(script).toContain('exec "$base" review-init "$@"');
  });

  it("refuses to substitute a different canonical wrapper implementation", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-wrapper-revision-"));
    const repo = join(dir, "repo");
    const linked = join(dir, "linked");
    copyPrWrapperFixture(repo);
    writeFileSync(join(repo, "scripts", "pr-lib", "merge.sh"), "# canonical\n");
    chmodSync(join(repo, "scripts", "pr"), 0o755);

    const git = (cwd: string, args: string[]) =>
      spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    expect(git(repo, ["init", "-b", "main"]).status).toBe(0);
    expect(git(repo, ["config", "user.name", "OpenClaw Test"]).status).toBe(0);
    expect(git(repo, ["config", "user.email", "test@example.invalid"]).status).toBe(0);
    expect(git(repo, ["add", "scripts", ".github", "packages"]).status).toBe(0);
    expect(git(repo, ["commit", "-m", "test: canonical wrapper"]).status).toBe(0);
    expect(git(repo, ["worktree", "add", "-b", "feature", linked]).status).toBe(0);

    for (const component of [
      "scripts/pr-lib/merge.sh",
      "scripts/watch-pr-ci.mts",
      "scripts/verify-pr-hosted-gates.mts",
      "scripts/lib/local-check-runtime.mts",
    ]) {
      writeFileSync(join(linked, component), "# dirty linked\n");
      const dirtyResult = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
        cwd: linked,
        encoding: "utf8",
      });
      expect(dirtyResult.status, component).toBe(1);
      expect(dirtyResult.stderr, component).toContain(
        "scripts/pr wrapper files have uncommitted changes",
      );
      expect(git(linked, ["restore", component]).status).toBe(0);
    }

    writeFileSync(join(linked, "scripts", "tsx.mjs"), "// dirty preloader\n");
    const dirtyPreloaderResult = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
    });
    expect(dirtyPreloaderResult.status).toBe(1);
    expect(dirtyPreloaderResult.stderr).toContain(
      "scripts/pr wrapper files have uncommitted changes",
    );
    expect(git(linked, ["restore", "scripts/tsx.mjs"]).status).toBe(0);

    // A dirty canonical checkout no longer blocks a linked worktree whose
    // committed wrapper matches the origin/main trust anchor; without that
    // anchor it must still refuse.
    writeFileSync(join(repo, "scripts", "pr-lib", "merge.sh"), "# dirty canonical\n");
    const dirtyResult = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
    });
    expect(dirtyResult.status).toBe(1);
    expect(dirtyResult.stderr).toContain(
      "scripts/pr implementation differs between this worktree and the canonical checkout",
    );
    expect(git(repo, ["restore", "scripts/pr-lib/merge.sh"]).status).toBe(0);

    writeFileSync(join(linked, "scripts", "lib", "local-check-runtime.mts"), "// linked\n");
    expect(git(linked, ["add", "scripts/lib/local-check-runtime.mts"]).status).toBe(0);
    expect(git(linked, ["commit", "-m", "test: linked wrapper"]).status).toBe(0);

    const result = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
    });
    rmSync(dir, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "scripts/pr implementation differs between this worktree and the canonical checkout",
    );
    expect(result.stderr).toContain("scripts/lib/local-check-runtime.mts");
  });

  it("runs the local wrapper when it matches origin/main and the canonical checkout is parked elsewhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-wrapper-anchor-"));
    const repo = join(dir, "repo");
    const linked = join(dir, "linked");
    copyPrWrapperFixture(repo);
    writeFileSync(join(repo, "scripts", "pr-lib", "merge.sh"), "# canonical\n");
    chmodSync(join(repo, "scripts", "pr"), 0o755);

    const git = (cwd: string, args: string[]) =>
      spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    expect(git(repo, ["init", "-b", "main"]).status).toBe(0);
    expect(git(repo, ["config", "user.name", "OpenClaw Test"]).status).toBe(0);
    expect(git(repo, ["config", "user.email", "test@example.invalid"]).status).toBe(0);
    expect(git(repo, ["add", "scripts", ".github", "packages"]).status).toBe(0);
    expect(git(repo, ["commit", "-m", "test: canonical wrapper"]).status).toBe(0);
    // The linked worktree keeps main's wrapper; origin/main anchors trust.
    expect(git(repo, ["update-ref", "refs/remotes/origin/main", "main"]).status).toBe(0);
    expect(git(repo, ["worktree", "add", "-b", "feature", linked]).status).toBe(0);

    // Park the canonical checkout on a release-style branch with a different
    // wrapper revision, the exact contention that used to block landings.
    expect(git(repo, ["switch", "-c", "release/test-train"]).status).toBe(0);
    writeFileSync(join(repo, "scripts", "pr-lib", "merge.sh"), "# release drift\n");
    expect(git(repo, ["add", "scripts/pr-lib/merge.sh"]).status).toBe(0);
    expect(git(repo, ["commit", "-m", "test: release drift"]).status).toBe(0);

    const result = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
    });

    expect(result.stderr).not.toContain("Refusing to silently substitute");
    expect(result.stderr).not.toContain("scripts/pr implementation differs");
    expect(result.stderr).not.toContain("differing wrapper components vs origin/main");
    expect(result.stderr).not.toContain("uncommitted changes");

    // A local branch literally named "origin/main" must not spoof the trust
    // anchor: only the remote-tracking ref counts.
    expect(git(repo, ["update-ref", "-d", "refs/remotes/origin/main"]).status).toBe(0);
    expect(git(repo, ["update-ref", "refs/heads/origin/main", "main"]).status).toBe(0);
    const spoofed = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
    });
    rmSync(dir, { recursive: true, force: true });

    expect(spoofed.status).toBe(1);
    expect(spoofed.stderr).toContain(
      "scripts/pr implementation differs between this worktree and the canonical checkout",
    );
  });

  it("verifies local GitHub auth through GraphQL when REST quota is unavailable", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-auth-"));
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf 'monalisa\\n'
  exit 0
fi
exit 1
`,
    );
    chmodSync(gh, 0o755);

    const result = spawnSync(
      "bash",
      [
        "-c",
        "source scripts/lib/plain-gh.sh; source scripts/pr-lib/worktree.sh; ensure_gh_api_auth",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_GH_BIN: gh },
        encoding: "utf8",
      },
    );
    rmSync(dir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it.each(["default", "override"])(
    "resolves review writer identity through the selected protected gh (%s)",
    (route) => {
      const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-review-writer-"));
      const bin = join(dir, "bin");
      const calls = join(dir, "calls.log");
      mkdirSync(bin);
      const protectedGh = `#!/bin/sh
printf '%s\\n' "$*" >> "$OPENCLAW_TEST_CALLS"
case "$1 $2" in
  "api user") printf 'relay-reader\\n' ;;
  "api graphql") printf 'writer-maintainer\\n' ;;
  "pr edit") [ "$5" = writer-maintainer ] ;;
  *) exit 19 ;;
esac
`;
      const pathGh = join(bin, "gh");
      const overrideGh = join(dir, "selected-gh");
      writeFileSync(pathGh, route === "default" ? protectedGh : "#!/bin/sh\nexit 19\n");
      writeFileSync(overrideGh, protectedGh);
      chmodSync(pathGh, 0o755);
      chmodSync(overrideGh, 0o755);
      try {
        const result = spawnSync(
          "bash",
          [
            "-c",
            [
              "source scripts/lib/plain-gh.sh",
              "source scripts/pr-lib/common.sh",
              "source scripts/pr-lib/review.sh",
              'enter_worktree() { cd "$OPENCLAW_TEST_ROOT"; mkdir -p .local; }',
              "review_claim 42",
            ].join("\n"),
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
              HOME: dir,
              GH_TOKEN: "synthetic-writer-token",
              OPENCLAW_GH_BIN: route === "override" ? overrideGh : "",
              OPENCLAW_TEST_CALLS: calls,
              OPENCLAW_TEST_ROOT: dir,
              PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
            },
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("@writer-maintainer assigned to PR #42");
        expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
          expect.stringContaining("api graphql -f query=query { viewer { login } }"),
          "pr edit 42 --add-assignee writer-maintainer",
        ]);
        expect(readFileSync(join(dir, ".local/review-claim-user-attempt-1.log"), "utf8")).toBe(
          "writer-maintainer\n",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
