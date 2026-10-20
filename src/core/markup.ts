// Dooray markdown links for mentions and task links (format from jon890/dooray-cli utils/mention.ts,
// utils/task-link.ts; MIT). Only markdown bodies are supported: the HTML form is unconfirmed.
import { DAY, type Cache } from "./cache.js";
import type { Client } from "./client.js";

interface Me {
  id: string;
  name?: string;
  defaultOrganization?: { id: string };
}

export const me = (c: Client, cache: Cache): Promise<Me> => cache.get("me", DAY, () => c.call<Me>("GET", "/common/v1/members/me"));

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;");

export function memberMention(orgId: string, member: { id: string; name: string }, myId: string): string {
  return `[@${escapeText(member.name)}](dooray://${orgId}/members/${member.id} "${member.id === myId ? "me" : "member"}")`;
}

export function taskLink(orgId: string, post: { id: string; subject: string; taskNumber?: string }): string {
  return `[${escapeText(`${post.taskNumber ?? post.id} ${post.subject}`)}](dooray://${orgId}/tasks/${post.id})`;
}
