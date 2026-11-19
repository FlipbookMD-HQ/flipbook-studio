import { hasNonChatName } from "../shared/chatModels";

/**
 * Why a saved model isn't in the server's list (US-19, US-21): the list is filtered to chat models
 * (D40), so a saved model whose name fails that rule is "not a chat model"; any other missing
 * model is "not on this server". null when it's listed, or when the list isn't known.
 */
export function modelMark(
  saved: string,
  listed: string[] | null,
): "not a chat model" | "not on this server" | null {
  if (!saved || !listed || listed.includes(saved)) return null;
  return hasNonChatName(saved) ? "not a chat model" : "not on this server";
}
