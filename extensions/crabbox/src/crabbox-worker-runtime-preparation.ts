import type { WorkerNodeRuntime, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function crabboxRuntimePaths(leaseId: string): string[] {
  return [
    `state_dir="$HOME/.openclaw/cloud-workers/${leaseId}"`,
    'runtime_dir="$state_dir/runtime"',
    'PATH="$runtime_dir/node/bin:$PATH"',
    "export PATH",
  ];
}

export function crabboxRuntimeVersionCheck(version: string): string {
  return `case "$("$openclaw_bin" --version 2>/dev/null)" in ${shellQuote(`OpenClaw ${version}`)}|${shellQuote(`OpenClaw ${version} `)}*) ;; *) exit 1 ;; esac`;
}

// Keep the native launcher check: @openai/codex's npm wrapper loads a platform
// optional dependency (or bundled vendor tree); having package.json alone proves nothing.
function codexInspection(version: string): string {
  return [
    'const fs=require("node:fs"),path=require("node:path"),module=require("node:module");',
    'const inspection=JSON.parse(fs.readFileSync(0,"utf8")),plugin=inspection.plugin;',
    `const version=${JSON.stringify(version)};`,
    'if(plugin?.id!=="codex"||plugin.packageName!=="@openclaw/codex"||plugin.packageVersion!==version||(plugin.origin!=="bundled"&&(plugin.trustedOfficialInstall!==true||inspection.install?.source!=="npm"))){',
    'throw new Error("Codex remote-exec requires the exact official plugin matching the Gateway")}',
    "const root=fs.realpathSync(plugin.rootDir);",
    'const manifest=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));',
    'const requirePlugin=module.createRequire(path.join(root,"package.json"));',
    'const runtime=requirePlugin("@openai/codex/package.json");',
    'if(manifest.name!==plugin.packageName||manifest.version!==version||runtime.version!==manifest.dependencies?.["@openai/codex"]){',
    'throw new Error("Codex remote-exec requires the plugin and its exact pinned native runtime")}',
    'const launcher=requirePlugin.resolve("@openai/codex/bin/codex.js");',
    'const probe=require("node:child_process").spawnSync(process.execPath,[launcher,"--version"],{encoding:"utf8",timeout:10000,stdio:["ignore","pipe","pipe"]});',
    "if(probe.status!==0||probe.stdout?.trim()!==`codex-cli ${runtime.version}`){",
    'throw new Error("Codex remote-exec requires the exact executable platform-native Codex binary")}',
  ].join("");
}

export function crabboxPreparedCodexCheck(version: string): string {
  return `OPENCLAW_STATE_DIR="$state_dir" "$openclaw_bin" plugins inspect codex --json | node -e ${shellQuote(codexInspection(version))}`;
}

function prepareCodex(version: string): string[] {
  const project = [
    'if(plugin.origin!=="bundled"){',
    'const project=path.join(process.argv[1],"npm","projects","codex");',
    'const packageRoot=path.join(project,"node_modules","@openclaw");',
    "fs.mkdirSync(packageRoot,{recursive:true,mode:0o700});",
    'fs.writeFileSync(path.join(project,"package.json"),JSON.stringify({name:"openclaw-cloud-codex",private:true,dependencies:{"@openclaw/codex":version}})+"\\n",{mode:0o600});',
    'const projected=path.join(packageRoot,"codex");',
    "try{const existing=fs.lstatSync(projected);",
    'if(!existing.isSymbolicLink()||fs.realpathSync(projected)!==root){throw new Error("Codex node plugin path is occupied")}',
    '}catch(error){if(error.code!=="ENOENT"){throw error}fs.symlinkSync(root,projected)}',
    "}",
  ].join("");
  return [
    `if ! (${crabboxPreparedCodexCheck(version)}) >/dev/null 2>&1; then`,
    // Reuse a trusted image-installed plugin before installing into the private lease state.
    `  if ! ("$openclaw_bin" plugins inspect codex --json | node -e ${shellQuote(codexInspection(version) + project)} "$state_dir") >/dev/null 2>&1; then`,
    `    OPENCLAW_STATE_DIR="$state_dir" "$openclaw_bin" plugins install ${shellQuote(`npm:@openclaw/codex@${version}`)} --pin || { echo "Could not prepare the exact official Codex plugin. Check registry access; unpublished source builds require a trusted exact plugin and native runtime prepared by settings.setup." >&2; exit 1; }`,
    "  fi",
    "fi",
    crabboxPreparedCodexCheck(version),
    'OPENCLAW_STATE_DIR="$state_dir" "$openclaw_bin" plugins enable codex',
  ];
}

export function createCrabboxRuntimePreparation(params: {
  runtime: WorkerNodeRuntime;
  executionMode?: NonNullable<WorkerProvider["supportedExecutionModes"]>[number];
  leaseId: string;
}): string {
  const { runtime, executionMode, leaseId } = params;
  if (!runtime.packageSpecs.length) {
    throw new Error("Worker runtime has no OpenClaw package source");
  }
  // Matches the Gateway package's supported Node engines. The bootstrap itself pins one
  // official Linux build, verified against nodejs.org/dist/v24.19.0/SHASUMS256.txt.
  const supportedNode =
    'if(!/^\\d+\\.\\d+\\.\\d+$/.test(process.versions.node))process.exit(1);const [a,b,c]=process.versions.node.split(".").map(Number);process.exit((a===22&&(b>22||(b===22&&c>=3)))||(a===24&&b>=15)||(a===25&&b>=9)||a>25?0:1)';
  const nodeHashes = {
    x64: "f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4",
    arm64: "d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f",
  };
  return [
    "set -eu",
    "umask 077",
    ...crabboxRuntimePaths(leaseId),
    'mkdir -p "$runtime_dir"',
    'chmod 700 "$state_dir" "$runtime_dir"',
    `if ! node -e ${shellQuote(supportedNode)} >/dev/null 2>&1; then`,
    '  [ "$(uname -s)" = Linux ] || { echo "Install a supported Node runtime using profile setup on this platform" >&2; exit 1; }',
    '  case "$(uname -m)" in',
    `    x86_64) node_arch=x64; node_hash=${nodeHashes.x64} ;;`,
    `    aarch64|arm64) node_arch=arm64; node_hash=${nodeHashes.arm64} ;;`,
    '    *) echo "Automatic Node preparation supports Linux x64 and arm64 only" >&2; exit 1 ;;',
    "  esac",
    '  for utility in curl sha256sum tar mktemp; do command -v "$utility" >/dev/null || { echo "Node preparation requires $utility in the Linux snapshot" >&2; exit 1; }; done',
    '  [ ! -e "$runtime_dir/node" ] && [ ! -L "$runtime_dir/node" ] || { echo "Private Node runtime is unusable; repair it with profile setup before retrying" >&2; exit 1; }',
    '  stage="$(mktemp -d "$runtime_dir/.node-XXXXXX")"',
    "  trap 'rm -rf \"$stage\"' EXIT HUP INT TERM",
    '  node_archive="node-v24.19.0-linux-$node_arch.tar.gz"',
    '  curl --fail --silent --show-error --proto "=https" --tlsv1.2 --max-time 180 --max-filesize 134217728 "https://nodejs.org/dist/v24.19.0/$node_archive" -o "$stage/node.tar.gz"',
    '  printf "%s  %s\\n" "$node_hash" "$stage/node.tar.gz" | sha256sum -c -',
    '  tar -xzf "$stage/node.tar.gz" -C "$stage"',
    '  [ "$("$stage/node-v24.19.0-linux-$node_arch/bin/node" --version)" = v24.19.0 ] || { echo "The official Node runtime cannot run in this snapshot. Select Linux with glibc >=2.28 and libstdc++ >=6.0.25, or prepare supported Node using settings.setup." >&2; exit 1; }',
    '  mv "$stage/node-v24.19.0-linux-$node_arch" "$runtime_dir/node"',
    "  hash -r",
    '  rm -rf "$stage"',
    "  trap - EXIT HUP INT TERM",
    "fi",
    "find_runtime() {",
    '  for openclaw_bin in "$(command -v openclaw || true)" "$runtime_dir/openclaw/node_modules/.bin/openclaw"; do',
    `    if [ -n "$openclaw_bin" ] && [ -x "$openclaw_bin" ] && (${crabboxRuntimeVersionCheck(runtime.openclawVersion)}); then return 0; fi`,
    "  done",
    "  return 1",
    "}",
    "if ! find_runtime; then",
    // npm rejects one source path shared by two config layers. Keep both layers empty
    // without inheriting host settings; this private external-tool file lasts only for preparation.
    '  npm_global_config="$(mktemp "$runtime_dir/.npm-global-XXXXXX")"',
    "  trap 'rm -f \"$npm_global_config\"' EXIT",
    "  trap 'exit 1' HUP INT TERM",
    // npm verifies registry tarball integrity; suppress registry diagnostics that may include
    // operator environment details. Enrollment never invokes npm or an installing npx command.
    `  for package_candidate in ${runtime.packageSpecs.map(shellQuote).join(" ")}; do`,
    '    if (cd "$runtime_dir" && NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG="$npm_global_config" npm install --prefix "$runtime_dir/openclaw" --cache "$runtime_dir/npm-cache" --registry https://registry.npmjs.org --no-audit --no-fund --no-package-lock --save=false "$package_candidate") >/dev/null 2>&1 && find_runtime; then break; fi',
    "  done",
    '  rm -f "$npm_global_config"',
    "  trap - EXIT HUP INT TERM",
    "fi",
    `find_runtime || { printf "%s\\n" ${shellQuote(`Could not prepare exact OpenClaw ${runtime.openclawVersion} from the Gateway package sources. Check npm connectivity. An unpublished source build requires the exact locally packed candidate installed by settings.setup; it is not a released npm package.`)} >&2; exit 1; }`,
    ...(executionMode === "remote-exec" ? prepareCodex(runtime.openclawVersion) : []),
    'printf "%s\\n" "$openclaw_bin" >"$runtime_dir/openclaw-bin"',
  ].join("\n");
}
