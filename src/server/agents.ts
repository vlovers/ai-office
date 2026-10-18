import { z } from 'zod';
import type { AgentProfile } from '../shared/types.js';
import { AppError } from './errors.js';

export const agentIdSchema = z.union([z.enum(['codex-1', 'codex-2']), z.string().uuid()]);
const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u);
export const agentSettingsSchema = z
  .object({
    name: singleLine(80),
    role: singleLine(160),
    description: z.string().max(2000).default(''),
    instructions: z.string().max(12000).default(''),
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)
      .nullable()
      .default(null),
    maximumMode: z.enum(['read-only', 'write']).default('read-only'),
  })
  .strict();
export type AgentSettings = Pick<
  AgentProfile,
  'name' | 'role' | 'description' | 'instructions' | 'model' | 'maximumMode'
>;
export function validateAgentSettings(input: unknown, secret?: string): AgentSettings {
  const settings = agentSettingsSchema.parse(input);
  const text = Object.values(settings).join('\n');
  if (
    (secret && text.includes(secret)) ||
    /sk-[A-Za-z0-9_-]{12,}|-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S{8,}/i.test(
      text,
    )
  )
    throw new AppError(400, 'Remove credentials from agent settings before saving.');
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
      settings.description + settings.instructions,
    )
  )
    throw new AppError(400, 'Agent text contains unsupported control characters.');
  return settings;
}
