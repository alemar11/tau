export function createEventBus() {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(channel: string, handler: (payload: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(handler);
			listeners.set(channel, channelListeners);
			return () => {
				channelListeners.delete(handler);
				if (channelListeners.size === 0) listeners.delete(channel);
			};
		},
		emit(channel: string, payload: unknown) {
			for (const handler of listeners.get(channel) ?? []) handler(payload);
		},
	};
}

interface AgentConfig {
	name: string;
	aliases?: string[];
	description?: string;
	defaultContext?: "fresh" | "fork";
	systemPrompt?: string;
	model?: string;
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	skills?: string[];
	skillPath?: string[];
	filePath?: string;
	thinking?: string;
	systemPromptMode?: string;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	scope?: string;
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
	toolBudget?: { soft?: number; hard: number; block?: string[] | "*" };
	mcpDirectTools?: string[];
	maxSubagentDepth?: number;
}

export function makeAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `Test agent: ${name}`,
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritGlobalContext: false,
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}
