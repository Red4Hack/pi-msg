// Thin wrapper around createAgentSession: an in-process worker/planner/reviewer.
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Bus } from "./bus.ts";
import type { Guard } from "./presence.ts";

let runtime: Promise<any> | undefined;
const rt = () => (runtime ??= ModelRuntime.create());
// Registry of the live pi session: includes models from extension-registered providers (e.g. claude-code).
let registry: any;
export const setRegistry = (r: any) => void (registry = r);
const listModels = async (): Promise<any[]> => (registry ? registry.getAvailable() : [...(await (await rt()).getAvailable())]);

export async function availableModels(): Promise<string[]> {
	return (await listModels()).map((m: any) => `${m.provider}/${m.id}`);
}

/** "provider/id[:level]" → { model, thinkingLevel }. The error lists the valid ones. */
export async function resolveModel(spec?: string): Promise<{ model?: any; thinkingLevel?: string }> {
	if (!spec) return {};
	const [ref, level] = spec.split(/:(?=[a-z]+$)/);
	const model = (await listModels()).find((m: any) => `${m.provider}/${m.id}` === ref || m.id === ref);
	if (!model) throw new Error(`model "${spec}" unavailable. Valid: ${(await availableModels()).join(", ")}`);
	return { model, thinkingLevel: level };
}

export interface AgentOpts {
	cwd: string;
	prompt: string;
	model?: string;
	readOnly?: boolean;
	signal?: AbortSignal;
	guard?: Guard;
	bus?: Bus;
	name?: string;
}

export async function runAgent(o: AgentOpts): Promise<string> {
	const { model, thinkingLevel } = await resolveModel(o.model);
	const guardExt = (pi: any) => {
		// Workers can talk to peers: msg_send to a name or "all"; replies arrive as steering messages.
		if (o.bus && o.name) {
			pi.registerTool({
				name: "msg_send",
				label: "msg_send",
				description: "Send a message to another agent by name, or to \"all\". Replies arrive as [msg from X] steering messages.",
				parameters: Type.Object({ to: Type.String(), message: Type.String() }),
				async execute(_id: string, p: any) {
					const n = o.bus!.send(o.name!, p.to, p.message);
					return { content: [{ type: "text", text: `sent to ${n} agent(s)` }], details: undefined };
				},
			} as any);
		}
		if (!o.guard) return;
		pi.on("tool_call", (e: any) => o.guard!.call(e));
		pi.on("tool_result", (e: any) => o.guard!.result(e));
	};
	// noExtensions keeps the worker from loading pi-msg itself (recursion); inline factories still apply.
	const resourceLoader = new DefaultResourceLoader({ cwd: o.cwd, agentDir: getAgentDir(), noExtensions: true, extensionFactories: [guardExt] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: o.cwd,
		...(model ? { model } : {}),
		// reuse the live session runtime: it holds extension-registered providers and their auth
		modelRuntime: registry?.runtime ?? (await rt()),
		...(thinkingLevel ? { thinkingLevel } : {}),
		...(o.readOnly ? { tools: ["read", "grep", "find", "ls", ...(o.bus ? ["msg_send"] : [])] } : {}),
		sessionManager: SessionManager.inMemory(o.cwd),
		resourceLoader,
	} as any);
	const onAbort = () => void session.abort();
	o.signal?.addEventListener("abort", onAbort);
	// messages from peers come in as steering
	const poll = o.bus && o.name ? setInterval(() => {
			for (const m of o.bus!.drain(o.name!)) void session.steer(`[msg from ${m.from}] ${m.text}`);
		}, 1000) : undefined;
	const unsub = session.subscribe((ev: any) => {
		if ((ev.type === "tool_execution_end" || ev.type === "turn_end") && o.bus && o.name) o.bus.update(o.name, { tokens: session.getSessionStats().tokens.total });
	});
	try {
		if (o.signal?.aborted) throw new Error("aborted");
		await session.prompt(o.prompt);
		if (o.signal?.aborted) throw new Error("aborted");
		const last: any = [...session.messages].reverse().find((m: any) => m.role === "assistant");
		if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "model error");
		return session.getLastAssistantText() ?? "";
	} finally {
		if (poll) clearInterval(poll);
		unsub();
		o.signal?.removeEventListener("abort", onAbort);
		session.dispose();
	}
}
