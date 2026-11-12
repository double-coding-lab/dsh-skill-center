import { CREATE_TOOL_NAME } from '../shared/types.js'
import { createSkill } from './ops.js'
import type { OpsDeps } from './ops.js'

interface ToolsFace {
  register(definition: unknown): () => void
}

export interface ToolHost {
  get?: (name: string) => unknown
}

interface ToolRunContext {
  signal?: AbortSignal
}

function text(value: unknown): { type: 'text'; text: string }[] {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return [{ type: 'text', text: body }]
}

export function registerCreateTool(ctx: ToolHost, deps: OpsDeps): () => void {
  let tools: ToolsFace | undefined
  try {
    tools = typeof ctx.get === 'function' ? (ctx.get('tools') as ToolsFace | undefined) : undefined
  } catch {
    tools = undefined
  }
  if (!tools || typeof tools.register !== 'function') {
    console.warn('[dsh-skill-center] tools service unavailable; skill_center_create disabled')
    return () => {}
  }
  const definition = {
    name: CREATE_TOOL_NAME,
    description:
      'Create a new reusable skill in the local DSH skills directory (~/.dsh/skills). ' +
      'Call only when the user explicitly asks to create or save a skill. ' +
      'Writes <name>/SKILL.md with frontmatter built from the given name and description; ' +
      'optional supporting files (references/, scripts/) are written next to it. ' +
      'The name is normalized to kebab-case and an existing skill with the same name is rejected.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Skill name; normalized to kebab-case.' },
        description: {
          type: 'string',
          description: 'Third-person summary of what the skill does and when to use it (one or two sentences).',
        },
        body: {
          type: 'string',
          description: 'Markdown body of SKILL.md: goal, numbered steps, boundaries, examples.',
        },
        files: {
          type: 'array',
          description:
            'Optional supporting files such as references/<topic>.md or scripts/<name>.py. ' +
            'Use only when the body would otherwise exceed a few hundred lines.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: 'Relative path inside the skill directory.' },
              content: { type: 'string', description: 'Full UTF-8 text content.' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['name', 'description', 'body'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['name', 'path'],
      },
      render: (_args: unknown, value: { name?: string; path?: string }) =>
        text(`已创建技能 ${value?.name ?? ''}\n${value?.path ?? ''}`),
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<{ name: string; path: string }> {
      exec.signal?.throwIfAborted()
      const input = (args ?? {}) as {
        name?: unknown
        description?: unknown
        body?: unknown
        files?: { path?: unknown; content?: unknown }[]
      }
      return createSkill(deps, {
        name: String(input.name ?? ''),
        description: String(input.description ?? ''),
        body: String(input.body ?? ''),
        files: Array.isArray(input.files)
          ? input.files.map(file => ({
              path: String(file?.path ?? ''),
              content: String(file?.content ?? ''),
            }))
          : [],
      })
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'write'; rawInput: string } {
      const input = (args ?? {}) as { name?: unknown }
      return {
        card: 'generic',
        title: `创建技能 ${String(input.name ?? '')}`.trim(),
        kind: 'write',
        rawInput: String(input.name ?? ''),
      }
    },
  }
  return tools.register(definition)
}
