import { withHerdrPaneAllocationLock } from "../../extensions/subagents/src/runs/shared/herdr-placed-run.ts";

try {
  await withHerdrPaneAllocationLock(process.argv[2], async () => {
    process.send({ state: "locked" });
    await new Promise((resolve) => process.once("message", resolve));
  }, { timeoutMs: Number(process.argv[3]), pollMs: 5 });
  process.send({ state: "released" });
} catch (error) {
  process.send({ state: "error", message: String(error) });
  process.exitCode = 2;
} finally {
  process.disconnect();
}
