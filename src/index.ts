/** @dsh-external/dsh-codex-composer Host half: registers persistent composer settings. */
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const name = '@dsh-external/dsh-codex-composer'
export const inject = ['settings']
export const Config = z.object({})

export function apply(ctx: Context): void {
  ctx.settings.register(settingsNamespace('dsh-codex-composer'), z.object({
    enabled: z.boolean().default(true),
    archiveShortcut: z.string().default('Ctrl+Shift+K'),
  }))
}
