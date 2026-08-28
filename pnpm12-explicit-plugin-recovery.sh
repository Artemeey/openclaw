#!/usr/bin/env bash
# Temporary manual proof, NOT a replacement for failed historical replay 33161133344.
# Run only on the parent's disposable Linux/Docker lease; see --help.
set -Eeuo pipefail
umask 077

HARNESS_SHA=6fec2bca44e5701f460ca331c0b5dc6bd5b52397
SOURCE_SHA=570ee21030ad2523baeac1d99e9e59829e1f1c05
CORE_SHA=cebada2e3a240cd4b7fa80ccf01783dcb4376fea3a1b5da55cf202e38a08a5f4
REGISTRY_SHA=c2838aba9b77664c1d93c26d95ce2ca247e5cbbf97b6a19ac900e46dc1858886
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

die() { echo "Explicit plugin recovery proof: $*" >&2; exit 1; }

# Private observations use only the existing read-only E2E index reader and Node.
# This never invokes inspect/list/registry against the failed fixture.
observe() {
  node --input-type=module - "$1" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readPluginInstallIndex} from './scripts/e2e/lib/plugin-index-sqlite.mjs';
const stage = process.argv[2], base = '/proof', state = process.env.OPENCLAW_STATE_DIR;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function read(file, limit = 1024 * 1024) {
  const root = [base, state].find(root => file.startsWith(`${root}/`));
  assert(root, 'observation outside fixture');
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    assert(part && part !== '..' && part !== '.');
    current = path.join(current, part);
    assert(!fs.lstatSync(current).isSymbolicLink(), 'symlink observation refused');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    assert(before.isFile() && before.nlink === 1 && before.size <= limit, 'unsafe observation');
    const bytes = Buffer.alloc(before.size + 1);
    assert.equal(fs.readSync(fd, bytes, 0, bytes.length, 0), before.size);
    const after = fs.fstatSync(fd);
    for (const key of ['dev','ino','size','nlink','mtimeMs','ctimeMs']) assert.equal(after[key], before[key]);
    return bytes.subarray(0, before.size);
  } finally { fs.closeSync(fd); }
}
const json = (file, limit) => JSON.parse(read(file, limit));
const expected = json(`${base}/expected.json`);
const original = json(`${base}/original/diagnostics/raw.json`, 8 * 1024 * 1024);
const summary = json(`${base}/original/summary.json`);
const originalExit = Number(read(`${base}/original.exit`).toString().trim());
assert(Number.isInteger(originalExit) && originalExit > 0 && originalExit <= 255);
assert.equal(summary.status, 'failed');
assert.equal(summary.failure?.phase, 'update-candidate');
assert.equal(summary.baseline?.version, '2026.7.1-2');
assert.equal(summary.candidate?.version, '2026.8.1');
assert.equal(summary.scenario, 'base');
assert.equal(summary.updateRestartMode, 'auto-auth');
assert.equal(json(`${base}/original/npm-prefix/lib/node_modules/openclaw/package.json`).version, '2026.8.1');
assert.equal(original.phase, 'update-candidate');
assert.equal(original.exitStatus, originalExit);
assert.equal(original.postCore?.availability, 'captured');
assert.equal(original.postCore.childExitCode, 0);
assert.equal(original.postCore.result.status, 'warning');
assert(original.postCore.result.npm.outcomes.some(outcome => outcome.pluginId === 'codex' &&
  outcome.status === 'error' && /requires capability consent/.test(outcome.message ?? '')));
assert(original.service.childExits.some(exit => exit.code === 1 && exit.signal === null));
assert(Object.values(original.logs).some(log => typeof log === 'string' && log.includes('AgentSelectionRequiredError')));
const old = original.pluginIdentity.plugins.find(plugin => plugin.pluginId === 'codex');
assert.equal(old?.enabled, true);
assert.equal(old.package.version, '2026.7.1-1');
assert.equal(old.doctor.sha256, 'ee3ea5451542044e44483be5991c45776f82d8df6af2e917c85e043577dd86f3');

// The same private fixture owns all index sources. SQLite SHM read marks may change.
for (const relative of ['state/openclaw.sqlite','state/openclaw.sqlite-wal','state/openclaw.sqlite-shm','plugins/installs.json']) {
  const file = path.join(state, relative);
  try {
    assert.equal(fs.realpathSync(path.dirname(file)), path.dirname(file), 'symlink index directory');
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && stat.nlink === 1 && stat.size <= 64 * 1024 * 1024, 'unsafe index source');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const index = readPluginInstallIndex({stateDir: state, configPath: null});
assert(Array.isArray(index.plugins) && index.plugins.length > 0 && index.plugins.length <= 128);
const selected = id => {
  const matches = index.plugins.filter(plugin => plugin.pluginId === id);
  assert(matches.length <= 1, 'ambiguous selected plugin');
  return matches[0];
};
function identity(id) {
  const entry = selected(id);
  assert(entry && entry.enabled === true && !entry.installOwnerAmbiguous, 'missing active plugin');
  assert(entry.rootDir.startsWith(`${state}/`), 'plugin outside state boundary');
  const record = index.installRecords[entry.installOwner ?? id];
  const pkg = json(path.join(entry.rootDir, 'package.json'));
  const manifestBytes = read(path.join(entry.rootDir, 'openclaw.plugin.json'));
  const manifest = JSON.parse(manifestBytes);
  const target = expected.find(item => item.id === id);
  assert.equal(pkg.name, target.name);
  assert.equal(pkg.version, target.version);
  assert.equal(entry.packageVersion, target.version);
  assert.equal(record.resolvedVersion ?? record.version, target.version);
  assert.equal(record.source, 'npm');
  assert.equal(record.spec, `${target.name}@${target.version}`);
  assert.equal(path.resolve(record.installPath), path.resolve(entry.rootDir));
  assert.equal(hash(manifestBytes), target.manifestSha256);
  assert.equal(entry.manifestHash, target.manifestSha256);
  assert.equal(manifest.id, id);
  let doctor;
  outer: for (const stem of ['doctor-contract-api','contract-api']) {
    for (const extension of ['.js','.mjs','.cjs','.ts','.mts','.cts']) {
      for (const dir of ['', 'dist']) {
        const relative = path.join(dir, `${stem}${extension}`);
        if (fs.existsSync(path.join(entry.rootDir, relative))) { doctor = relative; break outer; }
      }
    }
  }
  assert.equal(doctor, target.doctorPath);
  assert.equal(hash(read(path.join(entry.rootDir, doctor))), target.doctorSha256);
  assert.equal(entry.doctorContractHash, target.doctorSha256);
  assert.equal(record.integrity ?? record.npmIntegrity, target.integrity);
  assert.equal(record.acceptedSurfaceIntegrity, target.integrity);
  const groups = ['channels','providers','tools','contracts','hooks','mcpServers','cliCommands','cliBackends','skills','dangerousConfigFlags'];
  const canonical = Object.fromEntries(groups.map(group => {
    assert(Array.isArray(record.acceptedSurface?.[group]));
    return [group, record.acceptedSurface[group].toSorted()];
  }));
  assert.equal(hash(JSON.stringify(canonical)), target.surfaceHash);
  assert.equal(record.acceptedSurfaceHash, target.surfaceHash);
  assert(Number.isFinite(Date.parse(record.acceptedSurfaceAt)), 'missing consent timestamp');
  return {id, version: pkg.version, doctorSha256: target.doctorSha256,
    surfaceHash: target.surfaceHash, integrity: target.integrity, consentVerified: true};
}
const before = {
  originalExit, originalOutcome: 'failed', postCoreStatus: 'warning', postCoreChildExit: 0,
  retainedVersion: '2026.7.1-1', retainedDoctorSha256: old.doctor.sha256,
  originalRawSha256: hash(read(`${base}/original/diagnostics/raw.json`, 8 * 1024 * 1024)),
  originalSummarySha256: hash(read(`${base}/original/summary.json`)),
};
if (stage === 'original') {
  const current = selected('codex');
  assert.equal(current?.packageVersion, '2026.7.1-1');
  assert.equal(current.enabled, true);
  const config = json(process.env.OPENCLAW_CONFIG_PATH);
  const whatsapp = selected('whatsapp');
  const missingPayload = !whatsapp || !fs.existsSync(path.join(whatsapp.rootDir, 'package.json'));
  // Only the known configured, missing selected payload authorizes the second install.
  assert(missingPayload && config.channels?.whatsapp?.enabled === true,
    'WhatsApp state differs from the reviewed missing-payload recovery; stop for parent review');
  fs.writeFileSync(`${base}/original-proof.json`, JSON.stringify(before), {flag:'wx'});
} else {
  assert(['repair','recovered'].includes(stage));
  assert.deepEqual(before, json(`${base}/original-proof.json`), 'original evidence changed');
  const text = read(`${base}/recovery/repair.stdout`).toString();
  // Frozen writeJson emits a final pretty-printed document after Doctor panels.
  // Accept exactly one trailing line-start object with the finalization discriminator.
  const candidates = [];
  for (const match of text.matchAll(/^\{/gm)) {
    try { const value = JSON.parse(text.slice(match.index)); if (value.mode === 'finalize') candidates.push(value); } catch {}
  }
  assert.equal(candidates.length, 1, 'missing/unframed finalization payload');
  const repair = candidates[0];
  assert.equal(repair.status, 'ok');
  assert.equal(repair.restart, false);
  assert.equal(repair.postUpdate?.doctor?.status, 'ok');
  assert.equal(repair.postUpdate?.plugins?.status, 'ok');
  assert(!repair.phaseTimings.some(phase => ['failed','warning'].includes(phase.outcome)));
  const plugins = ['codex','whatsapp'].map(identity);
  if (stage === 'repair') process.exit(0);
  const status = json(`${base}/recovery/status.stdout`);
  assert.equal(status.rpc?.ok, true);
  assert.equal(status.rpc.version, '2026.8.1');
  assert.equal(status.gateway?.version, '2026.8.1');
  assert.equal(status.cli?.version, '2026.8.1');
  assert.equal(json(`${base}/recovery/healthz.json`).body?.status, 'live');
  assert.equal(json(`${base}/recovery/readyz.json`).body?.ready, true);
  fs.writeFileSync(`${base}/recovered-proof.json`, JSON.stringify({
    recoveryOutcome:'passed', repairStatus:'ok', authenticatedRpc:true, ready:true, plugins,
  }), {flag:'wx'});
}
NODE
}

fixture_environment() {
  export CI=true OPENCLAW_NO_ONBOARD=1 OPENCLAW_NO_PROMPT=1
  export OPENCLAW_SKIP_PROVIDERS=1 OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_DISABLE_BONJOUR=1
  export GATEWAY_AUTH_TOKEN_REF=upgrade-survivor-token
  export OPENAI_API_KEY=sk-openclaw-upgrade-survivor
  export DISCORD_BOT_TOKEN=upgrade-survivor-discord-token
  export TELEGRAM_BOT_TOKEN=123456:upgrade-survivor-telegram-token
  export HOME=/home/appuser USERPROFILE=/home/appuser
  export OPENCLAW_STATE_DIR="$HOME/.openclaw" OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json"
  export TMPDIR=/tmp/openclaw-upgrade-survivor-runtime/tmp
  export npm_config_prefix=/proof/original/npm-prefix NPM_CONFIG_PREFIX=/proof/original/npm-prefix
  export npm_config_cache=/tmp/openclaw-upgrade-survivor-runtime/npm-cache
  export NPM_CONFIG_CACHE="$npm_config_cache" npm_config_tmp="$TMPDIR"
  export npm_config_loglevel=error npm_config_fund=false npm_config_audit=false
  export PATH="$npm_config_prefix/bin:$PATH"
  unset OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD OPENCLAW_HOME
}

recover() {
  local registry_pid='' clawhub_pid='' phase=registry
  source scripts/lib/openclaw-e2e-instance.sh
  source scripts/e2e/lib/prepublish-plugin-registry.sh
  export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT=/proof/recovery
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG=/proof/recovery/systemctl-shim.log
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE=/proof/recovery/systemctl-shim.pid
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG=/proof/recovery/systemctl-shim-gateway.log
  # Invoked by EXIT, including failures inside this function's sourced helpers.
  # shellcheck disable=SC2329
  finish_recovery() {
    local result=$?
    trap - EXIT
    set +e
    printf '%s\n' "$result" > /proof/recovery.exit
    if [ "$result" -ne 0 ]; then
      node scripts/e2e/lib/upgrade-survivor/diagnostics.mjs capture /proof/recovery "$phase" "$result" ||
        echo 'Recovery diagnostics unavailable; original recovery failure preserved.' >&2
    fi
    systemctl --user stop openclaw-gateway.service >/dev/null 2>&1
    openclaw_e2e_stop_process "$registry_pid"
    openclaw_e2e_stop_process "$clawhub_pid"
    exit "$result"
  }
  trap 'finish_recovery' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  openclaw_prepublish_plugin_registry_start_mounted /proof/recovery/npm-registry registry_pid '["@openclaw/codex","@openclaw/whatsapp"]'
  mkdir /proof/recovery/clawhub
  node scripts/e2e/lib/clawhub-fixture-server.cjs prepublish-artifacts \
    /proof/recovery/clawhub/port "$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR/prepublish-plugin-registry.json" \
    >/proof/recovery/clawhub/server.log 2>&1 &
  clawhub_pid=$!
  for _ in $(seq 1 100); do
    [ -s /proof/recovery/clawhub/port ] && break
    openclaw_e2e_process_alive "$clawhub_pid" || break
    sleep 0.1
  done
  [ -s /proof/recovery/clawhub/port ] || die 'recovery ClawHub fixture did not start'
  OPENCLAW_CLAWHUB_URL="http://127.0.0.1:$(cat /proof/recovery/clawhub/port)"
  export OPENCLAW_CLAWHUB_URL
  run_step() {
    phase="$1"; shift
    local result=0
    openclaw_e2e_maybe_timeout 900s "$@" >"/proof/recovery/$phase.stdout" 2>"/proof/recovery/$phase.stderr" || result=$?
    printf '%s\n' "$result" >"/proof/recovery/$phase.exit"
    return "$result"
  }
  run_step install-codex openclaw plugins install npm:@openclaw/codex@2026.8.1 --force --accept-capabilities
  run_step install-whatsapp openclaw plugins install npm:@openclaw/whatsapp@2026.8.1 --force --accept-capabilities
  run_step repair openclaw update repair --yes --json
  phase=assert-repair
  observe repair
  run_step restart openclaw gateway restart --json
  phase=readiness
  node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs --base-url http://127.0.0.1:18789 --path /healthz --expect live --out /proof/recovery/healthz.json
  node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs --base-url http://127.0.0.1:18789 --path /readyz --expect ready --out /proof/recovery/readyz.json
  local status_started=$SECONDS
  run_step status openclaw gateway status --url ws://127.0.0.1:18789 --token "$GATEWAY_AUTH_TOKEN_REF" --require-rpc --timeout 30000 --json
  [ "$((SECONDS - status_started))" -le 30 ] || die 'status exceeded original 30-second budget'
  phase=assert-recovery
  observe recovered
}

case "${1:-}" in
  --help|-h|'')
    echo 'Usage: bash pnpm12-explicit-plugin-recovery.sh CORE_TGZ REGISTRY_DIR CANDIDATE_SOURCE_570_DIR NEW_OUTPUT_DIR'
    echo 'Linux/Docker only; trusted harness HEAD 6fec2bc, Node 24, installed harness dependencies.'
    echo 'Candidate source must be a separate clean 570ee21 checkout prepared by the parent.'
    echo 'Only NEW_OUTPUT_DIR/public is shareable. Original upgrade remains failed even if recovery passes.'
    exit 0 ;;
  --container)
    [ -f /.dockerenv ] && [ "$PWD" = /app ] && [ "$(id -un)" = appuser ] || die 'container boundary required'
    # Host-owned 0700 output parent keeps raw data private; capture files must be
    # readable by the host publisher even when appuser has a different uid.
    umask 022
    fixture_environment
    result=0
    timeout --kill-after=30s 1200s bash /tmp/openclaw-upgrade-survivor-run.sh \
      >/proof/original.stdout 2>/proof/original.stderr || result=$?
    printf '%s\n' "$result" > /proof/original.exit
    observe original >/proof/original-assert.stdout 2>/proof/original-assert.stderr
    # A second separately bounded manual phase; never retry or relabel the old update.
    result=0
    timeout --kill-after=30s 1200s bash "$SELF" --recover \
      >/proof/recovery.stdout 2>/proof/recovery.stderr || result=$?
    printf '%s\n' "$result" > /proof/recovery-driver.exit
    exit "$result" ;;
  --recover)
    [ -f /.dockerenv ] && [ "$PWD" = /app ] && [ -f /proof/original-proof.json ] || die 'validated disposable fixture required'
    umask 022
    fixture_environment
    recover
    exit 0 ;;
  --host) shift ;;
  *)
    # Do not inherit OpenClaw/provider/registry/Node overrides or host credentials.
    exec env -i PATH="$PATH" HOME="$HOME" CI=true bash "$SELF" --host "$@" ;;
esac

[ "$#" -eq 4 ] || die 'expected four paths; use --help'
[ "$(uname -s)" = Linux ] || die 'parent must run this on the disposable Linux lease'
[ "$(node -p 'process.versions.node.split(".")[0]')" = 24 ] || die 'Node 24 required on host'
for tool in docker git tar sha256sum timeout; do command -v "$tool" >/dev/null || die "missing $tool"; done
HARNESS_ROOT_DIR="$(dirname "$SELF")"
export DOCKER_E2E_HARNESS_ROOT_DIR="$HARNESS_ROOT_DIR"
cd "$HARNESS_ROOT_DIR"
[ "$(git rev-parse HEAD)" = "$HARNESS_SHA" ] || die 'trusted harness SHA mismatch'
if ! git diff --quiet || ! git diff --cached --quiet; then die 'tracked harness changes present'; fi
CORE="$(realpath -e "$1")" REGISTRY="$(realpath -e "$2")" ROOT_DIR="$(realpath -e "$3")"
OUT="$(realpath -m "$4")"
for input_path in "$CORE" "$REGISTRY" "$ROOT_DIR" "$OUT"; do
  case "$input_path" in *$'\n'*|*,*|*:*) die 'newline/comma/colon paths unsupported' ;; esac
done
[ ! -e "$OUT" ] && [ ! -L "$4" ] || die 'output must be a new task-owned directory'
for input_root in "$HARNESS_ROOT_DIR" "$REGISTRY" "$ROOT_DIR"; do
  case "$OUT/" in "$input_root/"*) die 'output must be outside source and immutable registry directories' ;; esac
done
[ ! -e "$(dirname "$CORE")/.openclaw-docker-e2e-generated-package" ] || die 'input is marked for helper deletion; provide the preserved downloaded artifact'
[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" = "$SOURCE_SHA" ] || die 'candidate source SHA mismatch'
if ! git -C "$ROOT_DIR" diff --quiet || ! git -C "$ROOT_DIR" diff --cached --quiet; then die 'candidate tracked files modified'; fi
[ -f node_modules/tsx/dist/loader.mjs ] || die 'parent must provision trusted harness dependencies'
[ "$(sha256sum "$CORE" | cut -d' ' -f1)" = "$CORE_SHA" ] || die 'core hash mismatch'
node scripts/prepublish-plugin-registry-artifact.mjs verify --artifact-dir "$REGISTRY" \
  --source-sha "$SOURCE_SHA" --candidate-version 2026.8.1 --manifest-sha256 "$REGISTRY_SHA" \
  --required-packages-json '["@openclaw/codex","@openclaw/whatsapp"]' >/dev/null
mkdir "$OUT"
mkdir "$OUT/private" "$OUT/public"
mkdir "$OUT/private/original" "$OUT/private/recovery"
chmod 777 "$OUT/private" "$OUT/private/original" "$OUT/private/recovery"
node --import ./scripts/tsx.mjs --input-type=module - "$CORE" "$REGISTRY" "$OUT/private/expected.json" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildPluginCapabilitySummary, computeDeclaredSurfaceHash} from './src/plugins/capability-summary.ts';
const [core, registry, out] = process.argv.slice(2);
const digest = (bytes, algorithm='sha256', encoding='hex') => createHash(algorithm).update(bytes).digest(encoding);
const member = (tgz, name) => execFileSync('tar', ['-xOf', tgz, `package/${name}`], {maxBuffer:1024*1024});
assert.equal(JSON.parse(member(core, 'package.json')).version, '2026.8.1');
const manifest = JSON.parse(fs.readFileSync(path.join(registry, 'prepublish-plugin-registry.json')));
const expected = ['codex','whatsapp'].map(id => {
  const entry = manifest.packages.find(entry => entry.name === `@openclaw/${id}`);
  assert(entry && entry.version === '2026.8.1');
  const tgz = path.join(registry, entry.tarball), bytes = fs.readFileSync(tgz);
  if (id === 'codex') assert.equal(digest(bytes), 'a1fbe3bfc52483d55f92b981650cab5a185da0ffe02d971d4ec1866b108a2d20');
  const pluginBytes = member(tgz, 'openclaw.plugin.json'), plugin = JSON.parse(pluginBytes);
  const inventory = new Set(execFileSync('tar',['-tzf',tgz],{encoding:'utf8',maxBuffer:8*1024*1024}).trim().split('\n'));
  let doctorPath;
  outer: for (const stem of ['doctor-contract-api','contract-api']) for (const ext of ['.js','.mjs','.cjs','.ts','.mts','.cts']) for (const dir of ['', 'dist']) {
    const file = path.posix.join(dir, stem+ext);
    if (inventory.has(`package/${file}`)) { doctorPath=file; break outer; }
  }
  assert(doctorPath, 'expected packaged doctor missing');
  const doctorSha256 = digest(member(tgz, doctorPath));
  if (id === 'codex') assert.equal(doctorSha256, 'd657c040808ad2833734161bc7cf65dc04eb03d7f471f2eb7affe14ffc1492b6');
  return {id, name:entry.name, version:entry.version, tarballSha256:entry.sha256,
    manifestSha256:digest(pluginBytes), doctorPath, doctorSha256,
    integrity:`sha512-${digest(bytes,'sha512','base64')}`,
    surfaceHash:computeDeclaredSurfaceHash(buildPluginCapabilitySummary({manifest:plugin,origin:'global'}).declared)};
});
fs.writeFileSync(out, JSON.stringify(expected), {flag:'wx',mode:0o644});
NODE
chmod 444 "$OUT/private/expected.json"

source "$HARNESS_ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$HARNESS_ROOT_DIR/scripts/e2e/lib/prepublish-plugin-registry.sh"
export OPENCLAW_DOCKER_E2E_SELECTED_SHA="$SOURCE_SHA"
export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION=2026.8.1
export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256="$REGISTRY_SHA"
IMAGE_NAME="openclaw-pnpm12-manual-recovery:$(node -e 'console.log(require("node:crypto").randomBytes(8).toString("hex"))')"
image_built=0
# The EXIT trap owns this image's cleanup; Docker container cleanup stays in its helper.
# shellcheck disable=SC2329
cleanup_host() {
  local result=$?
  trap - EXIT
  set +e
  if [ "$image_built" = 1 ]; then docker_e2e_docker_cmd image rm "$IMAGE_NAME" >"$OUT/private/image-cleanup.log" 2>&1; fi
  echo "Explicit recovery driver exit=$result; original upgrade remains a separate failure. Output: $OUT"
  exit "$result"
}
trap 'cleanup_host' EXIT
docker_e2e_build_or_reuse "$IMAGE_NAME" pnpm12-manual-recovery "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" bare 0 \
  >"$OUT/private/image-build.log" 2>&1
image_built=1
IMAGE_ID="$(docker_e2e_docker_cmd image inspect --format '{{.Id}}' "$IMAGE_NAME")"
# Test-state function belongs to the trusted harness, not the frozen candidate.
OPENCLAW_TEST_STATE_FUNCTION_B64="$(ROOT_DIR="$HARNESS_ROOT_DIR" docker_e2e_test_state_function_b64)"
docker_e2e_package_mount_args "$CORE"
openclaw_prepublish_plugin_registry_configure_docker_args "$REGISTRY"
driver_exit=0
docker_e2e_run_with_harness --init \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_TEST_STATE_FUNCTION_B64="$OPENCLAW_TEST_STATE_FUNCTION_B64" \
  -e OPENCLAW_UPGRADE_SURVIVOR_BASELINE=openclaw@2026.7.1-2 \
  -e OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_KIND=tarball \
  -e OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC=/tmp/openclaw-current.tgz \
  -e OPENCLAW_UPGRADE_SURVIVOR_SCENARIO=base \
  -e OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE=auto-auth \
  -e OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON=/proof/original/summary.json \
  -e OPENCLAW_UPGRADE_SURVIVOR_TSX_IMPORT=/tmp/openclaw-release-harness/node_modules/tsx/dist/loader.mjs \
  -v "$OUT/private:/proof" \
  -v "$OUT/private/expected.json:/proof/expected.json:ro" \
  -v "$HARNESS_ROOT_DIR/node_modules:/tmp/openclaw-release-harness/node_modules:ro" \
  -v "$HARNESS_ROOT_DIR/scripts/e2e/lib/upgrade-survivor/run.sh:/tmp/openclaw-upgrade-survivor-run.sh:ro" \
  -v "$SELF:/tmp/pnpm12-explicit-plugin-recovery.sh:ro" \
  "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DOCKER_ARGS[@]}" "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "$IMAGE_NAME" bash /tmp/pnpm12-explicit-plugin-recovery.sh --container \
  >"$OUT/private/container.stdout" 2>"$OUT/private/container.stderr" || driver_exit=$?
printf '%s\n' "$driver_exit" >"$OUT/private/container.exit"

# Only trusted host code writes public output, after the container has been removed.
publication_exit=0
mkdir "$OUT/public/original"
node --import ./scripts/tsx.mjs scripts/upgrade-survivor-diagnostics.mjs publish \
  "$OUT/private/original" "$OUT/public/original" >"$OUT/private/publication.log" 2>&1 || publication_exit=$?
if [ -f "$OUT/private/recovery/diagnostics/raw.json" ]; then
  mkdir "$OUT/public/recovery"
  node --import ./scripts/tsx.mjs scripts/upgrade-survivor-diagnostics.mjs publish \
    "$OUT/private/recovery" "$OUT/public/recovery" >>"$OUT/private/publication.log" 2>&1 || publication_exit=$?
fi
summary_exit=0
node --import ./scripts/tsx.mjs --input-type=module - "$OUT" "$driver_exit" "$publication_exit" "$IMAGE_ID" <<'NODE' || summary_exit=$?
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {redactSensitiveText} from './src/logging/redact.ts';
const [out, driver, publication, imageId] = process.argv.slice(2);
function read(relative) {
  const file = path.join(out, 'private', relative);
  let current = path.join(out, 'private');
  assert(!fs.lstatSync(current).isSymbolicLink());
  for (const part of relative.split(path.sep)) {
    assert(part && part !== '..' && part !== '.');
    current = path.join(current, part);
    assert(!fs.lstatSync(current).isSymbolicLink());
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    assert(before.isFile() && before.nlink === 1 && before.size <= 64*1024);
    const bytes = Buffer.alloc(before.size+1);
    assert.equal(fs.readSync(fd,bytes,0,bytes.length,0),before.size);
    const after = fs.fstatSync(fd);
    for (const key of ['dev','ino','size','nlink','mtimeMs','ctimeMs']) assert.equal(after[key],before[key]);
    return bytes.subarray(0,before.size).toString();
  } finally {fs.closeSync(fd);}
}
const optional = relative => { try {return JSON.parse(read(relative));} catch {return null;} };
const original = optional('original-proof.json'), recovery = optional('recovered-proof.json');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const code = value => Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
const report = {
  label:'manual-explicit-plugin-recovery-not-original-upgrade-success',
  originalRun:33161133344, harnessSha:'6fec2bca44e5701f460ca331c0b5dc6bd5b52397',
  packageSourceSha:'570ee21030ad2523baeac1d99e9e59829e1f1c05',
  baseline:'2026.7.1-2', coreSha256:'cebada2e3a240cd4b7fa80ccf01783dcb4376fea3a1b5da55cf202e38a08a5f4',
  registrySha256:'c2838aba9b77664c1d93c26d95ce2ca247e5cbbf97b6a19ac900e46dc1858886',
  imageId, imageBuild:'fresh bare runner from frozen source; not original CI image',
  driverExit:code(Number(driver)), publicationExit:code(Number(publication)),
  original:{outcome:original ? 'expected-failure-asserted':'unverified', exit:code(optional('original.exit')),
    postCoreChildExit:original ? 0:null, postCoreStatus:original ? 'warning':null,
    retainedVersion:original ? '2026.7.1-1':null, doctorSha256:sha(original?.retainedDoctorSha256)},
  recovery:{outcome:recovery?.recoveryOutcome === 'passed' && Number(driver) === 0 ? 'passed':'not-proven',
    driverExit:code(optional('recovery-driver.exit')), childExit:code(optional('recovery.exit')),
    steps:Object.fromEntries(['install-codex','install-whatsapp','repair','restart','status'].map(step => [step,code(optional(`recovery/${step}.exit`))])),
    ready:recovery?.ready === true, authenticatedRpc:recovery?.authenticatedRpc === true,
    plugins:['codex','whatsapp'].map(id => {
      const plugin = recovery?.plugins?.find(plugin => plugin.id === id);
      return {id,version:plugin?.version === '2026.8.1' ? plugin.version:null,
        doctorSha256:sha(plugin?.doctorSha256),surfaceHash:sha(plugin?.surfaceHash),consentVerified:plugin?.consentVerified === true};
    })},
};
assert(/^sha256:[a-f0-9]{64}$/.test(report.imageId));
const text = redactSensitiveText(JSON.stringify(report,null,2),{mode:'tools'});
assert(Buffer.byteLength(text) <= 64*1024);
fs.writeFileSync(path.join(out,'public','summary.json'),text+'\n',{flag:'wx',mode:0o600});
NODE
if [ "$publication_exit" -ne 0 ] || [ "$summary_exit" -ne 0 ]; then
  echo 'Safe publication incomplete; consult private publication log. No raw fallback.' >&2
  [ "$driver_exit" -ne 0 ] || driver_exit=1
fi
exit "$driver_exit"
