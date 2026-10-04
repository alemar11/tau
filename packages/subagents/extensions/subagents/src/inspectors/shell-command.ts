function shellQuote(value: string, platform: NodeJS.Platform): string {
	if (platform === "win32") return `'${value.replaceAll("'", "''")}'`;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function isBareExecutable(value: string): boolean {
	return /^[\w./@:-]+$/.test(value);
}

export function formatShellCommand(exe: string, args: readonly string[], platform: NodeJS.Platform = process.platform): string {
	const quotedArgs = args.map((arg) => shellQuote(arg, platform));
	// Older PowerShell drops embedded quotes when invoking native executables.
	// Literal strings prevent expansion; Standard argument passing preserves argv.
	if (platform === "win32") return `& { if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Inspector commands require PowerShell 7.3+' }; $PSNativeCommandArgumentPassing = 'Standard'; & ${[shellQuote(exe, platform), ...quotedArgs].join(" ")} }`;
	// Nushell treats a leading quoted token as a string, so use a bare invoker for paths that need quoting.
	const invocation = isBareExecutable(exe) ? exe : `sh -c 'exec "$0" "$@"' ${shellQuote(exe, platform)}`;
	return [invocation, ...quotedArgs].join(" ");
}
