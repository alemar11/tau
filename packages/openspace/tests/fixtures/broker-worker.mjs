import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { ensureBroker } from "../../src/broker/spawn.ts";
import { resolvePaths } from "../../src/paths.ts";

const health = await ensureBroker(resolvePaths(), { brokerArgs: [] }, {
  launch(command, args, options) {
    appendFileSync(process.argv[2], `${JSON.stringify({ command, args, cwd: options.cwd })}\n`);
    return spawn(command, args, options);
  },
});
console.log(JSON.stringify(health));
