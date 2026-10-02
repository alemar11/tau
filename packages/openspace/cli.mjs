#!/usr/bin/env node
import { register } from "tsx/esm/api";

register();
const { runMain } = await import("./cli.ts");
process.exitCode = await runMain();
