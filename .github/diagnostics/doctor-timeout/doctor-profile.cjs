// Task-only preload: no listening port, app-module imports, or runtime mutations.
const fs = require("node:fs");
const path = require("node:path");
const { Worker, isMainThread, workerData } = require("node:worker_threads");

const PROFILE_LIMIT = 4 * 1024 * 1024;
const OBSERVATION_MS = 55_000;

if (isMainThread) {
  const args = process.argv.slice(2);
  if (args.join("\0") !== "doctor\0--fix\0--non-interactive") {
    throw new Error("Diagnostic preload received a different command");
  }
  const output = process.env.DOCTOR_DIAGNOSTIC_PRIVATE_DIR;
  if (!output || !path.isAbsolute(output)) {
    throw new Error("Diagnostic output directory is missing");
  }
  const facts = {
    pid: process.pid,
    shimPid: Number(fs.readFileSync(path.join(output, "shim-pid"), "utf8")),
    parentPid: process.ppid,
    startedAt: Date.now(),
    node: process.versions.node,
    cache: {
      nodeCompileCachePresent: Object.hasOwn(process.env, "NODE_COMPILE_CACHE"),
      nodeCompileCachePortablePresent: Object.hasOwn(process.env, "NODE_COMPILE_CACHE_PORTABLE"),
      nodeDisableCompileCache: process.env.NODE_DISABLE_COMPILE_CACHE ?? null,
    },
  };
  fs.writeFileSync(path.join(output, "doctor-start.json"), JSON.stringify(facts));
  // Same process/PID as the fixture child; its existing process-group SIGKILL
  // also destroys this unref'ed worker. A worker timer survives main-thread CPU work.
  const worker = new Worker(__filename, {
    execArgv: [],
    workerData: { output, facts },
  });
  worker.on("error", () => {
    fs.appendFileSync(path.join(output, "profiler-events.jsonl"), '{"event":"worker-error"}\n');
  });
  worker.unref();
} else {
  const { Session } = require("node:inspector");
  const { output, facts } = workerData;
  const writeEvent = (event) =>
    fs.appendFileSync(
      path.join(output, "profiler-events.jsonl"),
      JSON.stringify({ elapsedMs: Date.now() - facts.startedAt, ...event }) + "\n",
    );
  const sample = () => {
    try {
      const task = `/proc/${facts.pid}/task/${facts.pid}`;
      const raw = fs.readFileSync(`${task}/stat`, "utf8");
      const fields = raw
        .slice(raw.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      writeEvent({
        event: "main-thread",
        pid: facts.pid,
        state: fields[0],
        processGroup: Number(fields[2]),
        userTicks: Number(fields[11]),
        systemTicks: Number(fields[12]),
        startTicks: Number(fields[19]),
        rssPages: Number(fields[21]),
        schedstat: fs.readFileSync(`${task}/schedstat`, "utf8").trim(),
        waitChannel: fs.readFileSync(`${task}/wchan`, "utf8").trim(),
      });
    } catch (error) {
      writeEvent({ event: "sample-unavailable", code: error.code ?? "unknown" });
    }
  };
  sample();
  const samples = setInterval(sample, 500);
  const observationDeadline = setTimeout(() => clearInterval(samples), OBSERVATION_MS);
  const session = new Session();
  const post = (method) =>
    new Promise((resolve, reject) =>
      session.post(method, (error, result) => (error ? reject(error) : resolve(result))),
    );
  (async () => {
    session.connectToMainThread();
    await post("Profiler.enable");
    await post("Profiler.start");
    writeEvent({ event: "profiler-started" });
    // Save completed windows before the original 60-second SIGKILL; never wait
    // for graceful exit to flush a single --cpu-prof output.
    for (let window = 1; window <= 10; window++) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      if (Date.now() - facts.startedAt >= OBSERVATION_MS) break;
      writeEvent({ event: "profile-stop-requested", window });
      const { profile } = await post("Profiler.stop");
      const bytes = JSON.stringify(profile);
      if (Buffer.byteLength(bytes) > PROFILE_LIMIT) {
        writeEvent({ event: "profile-cap-exceeded", window });
        break;
      }
      const target = path.join(output, `doctor-${window}.cpuprofile`);
      fs.writeFileSync(`${target}.tmp`, bytes);
      fs.renameSync(`${target}.tmp`, target);
      writeEvent({ event: "profile-saved", window });
      await post("Profiler.start");
    }
  })()
    .catch(() => writeEvent({ event: "profiler-error" }))
    .finally(() => {
      clearInterval(samples);
      clearTimeout(observationDeadline);
      session.disconnect();
    });
}
