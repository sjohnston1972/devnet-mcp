export interface ChatTurn {
  role: string;
  content: string;
}

/**
 * Shape client-sent history into a valid Anthropic messages prefix:
 * only user/assistant roles, capped to the last maxTurns, and never
 * starting with an assistant turn (the API requires user first).
 */
export function toAnthropicTurns(
  messages: ChatTurn[],
  maxTurns: number,
): Array<{ role: "user" | "assistant"; content: string }> {
  const turns = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-maxTurns) as Array<{ role: "user" | "assistant"; content: string }>;
  while (turns.length > 0 && turns[0].role !== "user") {
    turns.shift();
  }
  return turns;
}
