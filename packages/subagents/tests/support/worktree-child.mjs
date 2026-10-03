import { createWorktrees } from "../../extensions/subagents/src/runs/shared/worktree.ts";
const { cwd, runId, options } = JSON.parse(process.argv[2]);
try {
  const setup = await createWorktrees(cwd, runId, 1, options);
  console.log(JSON.stringify({ setup }));
} catch (error) {
  console.log(JSON.stringify({ error: String(error) }));
  process.exitCode = 1;
}
