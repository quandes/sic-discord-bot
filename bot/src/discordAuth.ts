import { GuildMember, type APIInteractionGuildMember } from 'discord.js';

export function parseRoleIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function memberHasAnyRole(
  member: GuildMember | APIInteractionGuildMember | null | undefined,
  roleIds: string[],
): boolean {
  if (!roleIds.length) return true;
  if (!member) return false;
  if (member instanceof GuildMember) {
    return roleIds.some((id) => member.roles.cache.has(id));
  }
  return roleIds.some((id) => member.roles.includes(id));
}
