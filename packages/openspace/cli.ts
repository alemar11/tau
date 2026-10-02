import { readFileSync } from "node:fs";

export function runMain(args: string[] = process.argv.slice(2)): number {
  if (args.length === 1 && args[0] === "--version") {
    const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    console.log(`openspace ${manifest.version}`);
    return 0;
  }
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
    console.log("Usage: openspace [--help | --version]\n\nPackage foundation only. Messaging commands (list/send/ask) are not implemented yet.");
    return 0;
  }
  console.error("Openspace messaging is not implemented yet. Only --help and --version are available.");
  return 2;
}
