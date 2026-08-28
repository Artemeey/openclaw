#!/usr/bin/env python3
"""One-shot, task-owned observer around the unchanged built-CLI fixture."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

TARGET_SHA = "b5c8a9ec85a54c53db5e1f857ef568128eb6a233"
TEST = "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts"
LOG_LIMIT = 2 * 1024 * 1024
PROFILE_LIMIT = 4 * 1024 * 1024
CACHE_ENV = {
    "NODE_COMPILE_CACHE": "/var/tmp/openclaw-node-compile-cache",
    "NODE_COMPILE_CACHE_PORTABLE": "1",
    "OPENCLAW_NODE_COMPILE_CACHE_WRITER": "0",
    "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH": "/var/tmp/openclaw-vitest-fs-cache",
    "OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER": "0",
}
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
SYNTHETIC_TOKEN = re.compile(r"(?:gateway|token)-sqlite-sessions-transcripts-flip-[A-Za-z0-9-]+")
TOKEN_VALUE = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}")
CREDENTIAL_FIELD = re.compile(
    r"(?i)((?:[\"']?(?:apiKey|api_key|access_token|refresh_token|password|token)[\"']?)\s*[:=]\s*[\"'])([^\"'\r\n]+)"
)


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def sanitize(value, source, scratch):
    if isinstance(value, str):
        value = ANSI.sub("", value)
        value = value.replace(str(source), "$REPO").replace(str(scratch), "$DIAGNOSTIC_TMP")
        value = SYNTHETIC_TOKEN.sub("[REDACTED_SYNTHETIC_TOKEN]", value)
        value = value.replace("sk-openclaw-e2e-mock", "[REDACTED_MOCK_KEY]")
        value = TOKEN_VALUE.sub(r"\1[REDACTED]", value)
        return CREDENTIAL_FIELD.sub(r"\1[REDACTED]", value)
    if isinstance(value, list):
        return [sanitize(item, source, scratch) for item in value]
    if isinstance(value, dict):
        return {key: sanitize(item, source, scratch) for key, item in value.items()}
    return value


def write_json(file, value):
    file.write_text(json.dumps(value, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    args = parser.parse_args()
    source, node = args.source.resolve(), args.node.resolve()
    output, scratch = args.output.resolve(), args.scratch.resolve()
    if sys.platform != "linux":
        raise SystemExit("Disposable Linux runner required; no local app/doctor execution")
    for name, expected in CACHE_ENV.items():
        if os.environ.get(name) != expected:
            raise SystemExit(f"Failed-job cache envelope not preserved: {name}")
    scratch.mkdir(parents=True, exist_ok=False)
    output.mkdir(parents=True, exist_ok=True)
    home, temporary, private, shim_dir = (scratch / name for name in ("home", "tmp", "private", "bin"))
    for directory in (home, temporary, private, shim_dir):
        directory.mkdir()

    # Construct an empty environment rather than inheriting any runner/token/profile state.
    # The unchanged run-vitest owner removes these inherited cache keys and sets
    # NODE_DISABLE_COMPILE_CACHE=1; the exact Doctor child records that fact below.
    env = {
        "PATH": f"{shim_dir}:{node.parent}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": str(home),
        "USERPROFILE": str(home),
        "OPENCLAW_HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local/share"),
        "XDG_STATE_HOME": str(home / ".local/state"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "TMPDIR": str(temporary), "TMP": str(temporary), "TEMP": str(temporary),
        "CI": "1", "LANG": "C.UTF-8", "TZ": "UTC",
        "DOCTOR_DIAGNOSTIC_PRIVATE_DIR": str(private),
        "OPENCLAW_E2E_USE_PREBUILT_DIST": "1",
        "OPENCLAW_E2E_VERBOSE": "1",
        "OPENCLAW_DIAGNOSTICS": "plugin.load-profile",
        "OPENCLAW_PLUGIN_LIFECYCLE_TRACE": "1",
        "OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS": "660000",
        **CACHE_ENV,
    }
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, env=env, text=True).strip()
    if revision != TARGET_SHA:
        raise SystemExit("Source does not match the failed synthetic merge")
    subprocess.run(["git", "diff", "--exit-code", "HEAD", "--"], cwd=source, env=env, check=True, stdout=subprocess.DEVNULL)
    version = subprocess.check_output([str(node), "--version"], env=env, text=True).strip()
    if version != "v24.19.0":
        raise SystemExit("Node 24.19.0 required")
    stamp_files = [source / "dist" / name for name in ("index.js", ".buildstamp", ".runtime-postbuildstamp")]
    runtime_hashes = {file.name: digest(file) for file in stamp_files}
    probe = Path(__file__).resolve().with_name("doctor-profile.cjs")
    # Exec, do not spawn: the fixture still owns the exact Node PID/process group.
    shim = "\n".join([
        "#!/bin/sh",
        'if [ "$#" -eq 4 ] && { [ "$1" = dist/index.js ] || [ "$1" = dist/index.mjs ]; } &&',
        '   [ "$2" = doctor ] && [ "$3" = --fix ] && [ "$4" = --non-interactive ]; then',
        f'  printf "%s\\n" "$$" > {shlex.quote(str(private / "shim-pid"))}',
        f'  exec {shlex.quote(str(node))} --require {shlex.quote(str(probe))} "$@"',
        "fi",
        f'exec {shlex.quote(str(node))} "$@"',
        "",
    ])
    (shim_dir / "node").write_text(shim)
    (shim_dir / "node").chmod(0o700)
    command = [str(node), "scripts/run-vitest.mjs", "run", "--config", "test/vitest/vitest.e2e.config.ts", TEST]
    identity = {
        "sourceSha": revision,
        "diagnosticWorkflowSha": os.environ.get("DIAGNOSTIC_WORKFLOW_SHA"),
        "diagnosticRunId": os.environ.get("DIAGNOSTIC_RUN_ID"),
        "node": version,
        "packageManager": json.loads((source / "package.json").read_text())["packageManager"],
        "runtimeFileSha256": runtime_hashes,
        "originalDoctorTimeoutMs": 60000,
        "fixture": TEST,
        "cacheEnvelope": CACHE_ENV,
        "cpuClockTicksPerSecond": os.sysconf("SC_CLK_TCK"),
        "memoryPageBytes": os.sysconf("SC_PAGE_SIZE"),
        "logicalCpus": os.cpu_count(),
        "parentEnvironmentNames": sorted(env),
        "diagnosticOnly": True,
        "overhead": "One exec shim plus an unref'ed inspector worker; no runtime source edits",
    }
    write_json(output / "execution-identity.json", identity)
    print("[doctor-diagnostic] starting unchanged fixture once; Doctor deadline remains 60000ms", flush=True)
    started = time.monotonic()
    child = subprocess.Popen(command, cwd=source, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    retained = bytearray()
    total_bytes = 0
    assert child.stdout is not None
    for chunk in iter(lambda: child.stdout.read1(65536), b""):
        total_bytes += len(chunk)
        retained.extend(chunk)
        if len(retained) > LOG_LIMIT:
            del retained[:-LOG_LIMIT]
    exit_code = child.wait()
    log = sanitize(retained.decode("utf-8", errors="replace"), source, scratch)
    if total_bytes > LOG_LIMIT:
        log = f"[diagnostic retained last {LOG_LIMIT} of {total_bytes} bytes]\n" + log
    (output / "fixture.log").write_text(log)

    profiles = 0
    for file in sorted(private.iterdir()):
        if file.name == "doctor-start.json" or re.fullmatch(r"doctor-(?:[1-9]|10)\.cpuprofile", file.name):
            if file.stat().st_size > PROFILE_LIMIT:
                raise SystemExit("Diagnostic profile exceeded its bound")
            value = sanitize(json.loads(file.read_text()), source, scratch)
            (output / file.name).write_text(json.dumps(value, separators=(",", ":")) + "\n")
            profiles += file.suffix == ".cpuprofile"
        elif file.name == "profiler-events.jsonl":
            if file.stat().st_size > LOG_LIMIT:
                raise SystemExit("Diagnostic event stream exceeded its bound")
            rows = [sanitize(json.loads(line), source, scratch) for line in file.read_text().splitlines()]
            (output / file.name).write_text("".join(json.dumps(row) + "\n" for row in rows))
    start_file = output / "doctor-start.json"
    doctor = json.loads(start_file.read_text()) if start_file.exists() else None
    correct_cache = bool(doctor and doctor["cache"] == {
        "nodeCompileCachePresent": False,
        "nodeCompileCachePortablePresent": False,
        "nodeDisableCompileCache": "1",
    })
    same_pid = bool(doctor and doctor["pid"] == doctor["shimPid"])
    unchanged_runtime = runtime_hashes == {file.name: digest(file) for file in stamp_files}
    summary = {
        "fixtureExitCode": exit_code,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "doctorObserved": doctor is not None,
        "execPreservedFixtureChildPid": same_pid,
        "failedChildCacheBehaviorPreserved": correct_cache,
        "savedCpuWindows": profiles,
        "runtimeEntrypointAndStampsUnchanged": unchanged_runtime,
        "fixtureLogTruncated": total_bytes > LOG_LIMIT,
        "notARepairOrUninstrumentedPerformanceProof": True,
    }
    write_json(output / "summary.json", summary)
    print(json.dumps(summary), flush=True)
    if exit_code != 0:
        return exit_code if exit_code > 0 else 128 - exit_code
    return 0 if doctor and same_pid and correct_cache and unchanged_runtime else 2


if __name__ == "__main__":
    sys.exit(main())
