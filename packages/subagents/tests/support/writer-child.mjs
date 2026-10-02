import { admitWriter } from "../../extensions/subagents/src/runs/shared/writer-admission.ts";
const options = JSON.parse(process.argv[2]);
const lease = await admitWriter({ ...options, onWait: (owner, position) => process.send?.({ state: "queued", owner, position }) });
process.send?.({ state: "admitted", token: lease.token });
process.once("message", async () => { await lease.release(); process.disconnect?.(); });
