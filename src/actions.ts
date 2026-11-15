export const ACTIONS = ["join", "list", "whois", "feed", "send", "broadcast", "reserve", "release", "status", "task", "tasks", "plan", "resume", "swarm", "claim", "unclaim", "complete", "models", "team", "team.save", "team.charter", "team.note", "team.memory", "team.roles", "team.status", "approve", "reject", "decide", "advise"] as const;

// A model that has not read the enum guesses verb_noun names (list_models, get_status): map them instead of failing the call.
export const fixAction = (a: unknown) => {
	if (typeof a !== "string" || (ACTIONS as readonly string[]).includes(a)) return a;
	const s = a.toLowerCase().replace(/^(list|get|show)[_.-]?/, "").replace(/[_-]/g, ".");
	return (ACTIONS as readonly string[]).includes(s) ? s : a;
};
