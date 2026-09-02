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

/**
 * Build the message list for the Workers AI fallback path: exactly one
 * server-controlled leading system turn, client history filtered down to
 * user/assistant via toAnthropicTurns (so a client-injected `system` turn
 * or an assistant-first history can never reach the model), and the
 * server-built final user turn trailing.
 */
export function buildFallbackMessages(
  systemPrompt: string,
  history: ChatTurn[],
  finalUserContent: string,
  maxTurns: number,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  return [
    { role: "system", content: systemPrompt },
    ...toAnthropicTurns(history, maxTurns),
    { role: "user", content: finalUserContent },
  ];
}
