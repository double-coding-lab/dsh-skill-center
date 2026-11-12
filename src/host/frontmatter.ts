/** Minimal frontmatter parsing and skill-name normalization shared by the host and the tests. */

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
const MAX_KEBAB_LENGTH = 64

export interface ParsedSkillDoc {
  hasFrontmatter: boolean
  map: Record<string, string>
  body: string
}

function unquote(value: string): string {
  const text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

/** Parse the leading `---` block; the rest of the file is returned verbatim. */
export function parseSkillDoc(input: string): ParsedSkillDoc {
  const text = input.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { hasFrontmatter: false, map: {}, body: text.trim() }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { hasFrontmatter: false, map: {}, body: text.trim() }
  const header = text.slice(3, end)
  const bodyStart = text.indexOf('\n', end + 4)
  const body = bodyStart < 0 ? '' : text.slice(bodyStart + 1)
  const map: Record<string, string> = {}
  const lines = header.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue
    const rest = line.slice(colon + 1).trim()
    if (/^[|>][+-]?$/.test(rest)) {
      const captured: string[] = []
      let cursor = index + 1
      for (; cursor < lines.length; cursor += 1) {
        const next = lines[cursor] ?? ''
        if (next.trim() === '') {
          captured.push('')
          continue
        }
        if (!/^\s/.test(next)) break
        captured.push(next.replace(/^\s+/, ''))
      }
      index = cursor - 1
      const joined = rest.startsWith('>')
        ? captured.join(' ').replace(/\s+/g, ' ').trim()
        : captured.join('\n').trim()
      map[key] = joined
      continue
    }
    map[key] = unquote(rest)
  }
  return { hasFrontmatter: true, map, body: body.trim() }
}

/** Normalize arbitrary text to the kebab-case skill name the host accepts. */
export function normalizeSkillName(input: string): string {
  const ascii = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  const kebab = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_KEBAB_LENGTH)
    .replace(/-+$/g, '')
  return SKILL_NAME_RE.test(kebab) ? kebab : ''
}

export function isSkillName(value: string): boolean {
  return SKILL_NAME_RE.test(value)
}

function yamlScalar(value: string): string {
  const text = value.replace(/\r?\n/g, ' ').trim()
  return /^[A-Za-z0-9 _.,:;/()'!?-]+$/.test(text) && !text.startsWith('-')
    ? text
    : JSON.stringify(text)
}

export function buildSkillDocument(input: { name: string; description: string; body: string }): string {
  return `---\nname: ${yamlScalar(input.name)}\ndescription: ${yamlScalar(input.description)}\n---\n\n${input.body.trim()}\n`
}

/** `disable-model-invocation` / `user-invocable` default to true unless explicitly false. */
export function invocationOf(map: Record<string, string>): { modelInvocable: boolean; userInvocable: boolean } {
  const disabledModel = (map['disable-model-invocation'] ?? '').toLowerCase() === 'true'
  const disabledUser = (map['user-invocable'] ?? '').toLowerCase() === 'false'
  return { modelInvocable: !disabledModel, userInvocable: !disabledUser }
}
