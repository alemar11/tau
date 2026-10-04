import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isParallelGroup,
	flattenSteps,
	mapConcurrent,
	aggregateParallelOutputs,
	MAX_PARALLEL_CONCURRENCY,
	DEFAULT_GLOBAL_CONCURRENCY_LIMIT,
	Semaphore,
	type RunnerSubagentStep,
	type ParallelStepGroup,
	type RunnerStep,
} from "../../extensions/subagents/src/runs/shared/parallel-utils.ts";

function barrier() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => { open = resolve; });
	return { promise, open };
}

describe("isParallelGroup", () => {
	it("returns true for a parallel step group", () => {
		const step: ParallelStepGroup = {
			parallel: [
				{ agent: "a", task: "do stuff" },
				{ agent: "b", task: "do other stuff" },
			],
		};
		assert.equal(isParallelGroup(step), true);
	});

	it("returns false for a sequential step", () => {
		const step: RunnerSubagentStep = { agent: "a", task: "do stuff" };
		assert.equal(isParallelGroup(step), false);
	});

	it("returns false when parallel is not an array", () => {
		const step = { parallel: "not-an-array", agent: "a", task: "x" } as unknown as RunnerStep;
		assert.equal(isParallelGroup(step), false);
	});
});

describe("flattenSteps", () => {
	it("returns sequential steps unchanged", () => {
		const steps: RunnerStep[] = [
			{ agent: "a", task: "t1" },
			{ agent: "b", task: "t2" },
		];
		const flat = flattenSteps(steps);
		assert.equal(flat.length, 2);
		assert.equal(flat[0].agent, "a");
		assert.equal(flat[1].agent, "b");
	});

	it("expands parallel groups into individual steps", () => {
		const steps: RunnerStep[] = [
			{ agent: "scout", task: "find info" },
			{
				parallel: [
					{ agent: "reviewer-a", task: "review part 1" },
					{ agent: "reviewer-b", task: "review part 2" },
				],
			},
			{ agent: "summarizer", task: "combine" },
		];
		const flat = flattenSteps(steps);
		assert.equal(flat.length, 4);
		assert.deepEqual(
			flat.map((s) => s.agent),
			["scout", "reviewer-a", "reviewer-b", "summarizer"],
		);
	});

	it("handles empty steps array", () => {
		assert.deepEqual(flattenSteps([]), []);
	});

	it("handles empty parallel group", () => {
		const steps: RunnerStep[] = [
			{ agent: "before", task: "x" },
			{ parallel: [] },
			{ agent: "after", task: "y" },
		];
		const flat = flattenSteps(steps);
		assert.equal(flat.length, 2);
		assert.deepEqual(flat.map((s) => s.agent), ["before", "after"]);
	});
});

describe("mapConcurrent", () => {
	it("preserves input order when workers finish out of order and starts without staggering", { timeout: 5000 }, async () => {
		const items = [10, 20, 30, 40], gates = items.map(() => barrier());
		const fourthStarted = barrier(), laterItemsFinished = barrier();
		const started: number[] = [], finished: number[] = [];
		const run = mapConcurrent(items, 3, async (item, i) => {
			started.push(i);
			if (i === 3) fourthStarted.open();
			await gates[i]!.promise;
			finished.push(i);
			if (finished.length === 3) laterItemsFinished.open();
			return item * 2;
		});
		try {
			assert.deepEqual(started, [0, 1, 2], "all initial workers start in the same turn, but the fourth waits");
			gates[1]!.open();
			await fourthStarted.promise;
			assert.deepEqual(finished, [1], "one free slot starts the fourth item without waiting for item zero");
			gates[2]!.open(); gates[3]!.open();
			await laterItemsFinished.promise;
			assert.deepEqual(finished, [1, 2, 3]);
			gates[0]!.open();
			assert.deepEqual(await run, [20, 40, 60, 80]);
			assert.deepEqual(finished, [1, 2, 3, 0]);
		} finally {
			for (const gate of gates) gate.open();
			await run;
		}
	});

	it("fills but never exceeds the requested concurrency", async () => {
		let running = 0, maxRunning = 0;
		const gate = barrier();
		const run = mapConcurrent([1, 2, 3, 4, 5, 6], 2, async (item) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await gate.promise;
			running--;
			return item;
		});
		try {
			assert.equal(running, 2, "both available slots must be used before either finishes");
			gate.open();
			assert.deepEqual(await run, [1, 2, 3, 4, 5, 6]);
			assert.equal(maxRunning, 2);
			assert.equal(running, 0);
		} finally { gate.open(); await run; }
	});

	it("handles empty input", async () => {
		const results = await mapConcurrent([], 4, async (item: number) => item);
		assert.deepEqual(results, []);
	});

	it("clamps limit=0 to 1 (sequential execution)", async () => {
		let running = 0;
		let maxRunning = 0;
		const items = [1, 2, 3];
		await mapConcurrent(items, 0, async (item) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 10));
			running--;
			return item * 10;
		});
		assert.equal(maxRunning, 1, "should run sequentially with limit=0");
	});

	it("clamps limit=-1 to 1 (sequential execution)", async () => {
		let running = 0;
		let maxRunning = 0;
		const items = [1, 2, 3];
		await mapConcurrent(items, -1, async (item) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 10));
			running--;
			return item * 10;
		});
		assert.equal(maxRunning, 1, "should run sequentially with limit=-1");
	});

	it("notifies scheduling settlement only after workers outliving an early rejection stop", { timeout: 5000 }, async () => {
		const gate = barrier(), settled = barrier();
		const started: number[] = [];
		let settlementCalls = 0;
		const run = mapConcurrent([0, 1, 2], 2, async (item) => {
			started.push(item);
			if (item === 0) throw new Error("early rejection");
			await gate.promise;
			return item;
		}, undefined, () => { settlementCalls++; settled.open(); });

		try {
			await assert.rejects(run, /early rejection/);
			assert.equal(settlementCalls, 0);
			gate.open();
			await settled.promise;
			assert.equal(settlementCalls, 1);
			assert.deepEqual(started, [0, 1, 2]);
		} finally { gate.open(); await run.catch(() => {}); }
	});

	it("respects a shared global semaphore across simultaneous calls", async () => {
		const globalSemaphore = new Semaphore(2);
		let running = 0;
		let maxRunning = 0;
		const run = (items: number[]) => mapConcurrent(items, items.length, async (item) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 10));
			running--;
			return item;
		}, globalSemaphore);

		const results = await Promise.all([
			run([1, 2, 3]),
			run([4, 5, 6]),
		]);

		assert.deepEqual(results, [[1, 2, 3], [4, 5, 6]]);
		assert.equal(maxRunning, 2, "simultaneous calls share the full capacity, not independent or serial pools");
	});

	it("returns a global permit after rejection so an already queued call can finish", { timeout: 5000 }, async () => {
		const globalSemaphore = new Semaphore(1), entered = barrier(), gate = barrier();
		const first = mapConcurrent([0], 1, async () => {
			entered.open();
			await gate.promise;
			throw new Error("worker failed");
		}, globalSemaphore);
		const rejected = assert.rejects(first, /worker failed/);
		await entered.promise;
		let successorStarted = false;
		const successor = mapConcurrent([42], 1, async (item) => { successorStarted = true; return item; }, globalSemaphore);
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(successorStarted, false);
			gate.open();
			await rejected;
			assert.deepEqual(await successor, [42]);
			assert.equal(successorStarted, true);
		} finally { gate.open(); await Promise.allSettled([rejected, successor]); }
	});

	it("clamps invalid global semaphore limits to 1", async () => {
		const globalSemaphore = new Semaphore(0);
		let running = 0;
		let maxRunning = 0;

		await mapConcurrent([1, 2, 3], 3, async (item) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 10));
			running--;
			return item;
		}, globalSemaphore);

		assert.equal(maxRunning, 1);
	});
});

describe("DEFAULT_GLOBAL_CONCURRENCY_LIMIT", () => {
	it("is 20", () => {
		assert.equal(DEFAULT_GLOBAL_CONCURRENCY_LIMIT, 20);
	});
});

describe("aggregateParallelOutputs", () => {
	it("aggregates successful outputs with headers", () => {
		const result = aggregateParallelOutputs([
			{ agent: "reviewer-a", output: "Looks good", exitCode: 0 },
			{ agent: "reviewer-b", output: "Needs fixes", exitCode: 0 },
		]);
		assert.ok(result.includes("=== Parallel Task 1 (reviewer-a) ==="));
		assert.ok(result.includes("Looks good"));
		assert.ok(result.includes("=== Parallel Task 2 (reviewer-b) ==="));
		assert.ok(result.includes("Needs fixes"));
	});

	it("marks failed tasks", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "partial output", exitCode: 1 },
		]);
		assert.ok(result.includes("FAILED (exit code 1)"));
	});

	it("marks empty output", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "", exitCode: 0 },
		]);
		assert.ok(result.includes("EMPTY OUTPUT"));
	});

	it("treats whitespace-only output as empty", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "   \n  ", exitCode: 0 },
		]);
		assert.ok(result.includes("EMPTY OUTPUT"));
	});

	it("marks skipped tasks (exitCode=-1) distinctly from failed", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "done", exitCode: 0 },
			{ agent: "agent-b", output: "(skipped — fail-fast)", exitCode: -1 },
		]);
		assert.ok(result.includes("SKIPPED"), "skipped task should show SKIPPED");
		assert.ok(!result.includes("FAILED"), "skipped task should not show FAILED");
	});
});

describe("MAX_PARALLEL_CONCURRENCY", () => {
	it("is 4", () => {
		assert.equal(MAX_PARALLEL_CONCURRENCY, 4);
	});
});
