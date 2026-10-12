// Throwaway "harness" for runner tests: replays an events file to stdout, optionally writes a result, exits.
// argv: <eventsFile> <resultPath|-> <exitCode> [sleepMs] [resultJson]
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [eventsFile, resultPath, exitCode, sleepMs, resultJson] = process.argv.slice(2);
for (const line of readFileSync(eventsFile, "utf8").split("\n")) if (line.trim()) process.stdout.write(line + "\n");
if (resultPath && resultPath !== "-" && resultJson) writeFileSync(resultPath, resultJson);
if (process.env.SPAWN_GRANDCHILD === "1") {
  // a grandchild that ignores SIGTERM, to prove process-group kill (AC-23)
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.GRANDCHILD_PID_FILE ?? "/dev/null", String(child.pid));
}
const ms = Number(sleepMs ?? 0);
if (ms > 0) setTimeout(() => process.exit(Number(exitCode)), ms);
else process.exit(Number(exitCode));
