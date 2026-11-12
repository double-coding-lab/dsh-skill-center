import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { strToU8, zipSync } from 'fflate'

import {
  buildSkillDocument,
  isSkillName,
  normalizeSkillName,
  parseSkillDoc,
} from '../dist/host/frontmatter.js'
import { createSkill, deleteSkill, normalizeArchivePath, unpackPayload } from '../dist/host/ops.js'
import { createProvider } from '../dist/host/provider.js'
import { SkillStore } from '../dist/host/store.js'

let passed = 0
const failures = []

async function test(name, run) {
  try {
    await run()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}

await test('normalizeSkillName builds kebab-case names', () => {
  assert.equal(normalizeSkillName('My Skill'), 'my-skill')
  assert.equal(normalizeSkillName('  --Foo__Bar-- '), 'foo-bar')
  assert.equal(normalizeSkillName('PPT 助手'), 'ppt')
  assert.equal(normalizeSkillName('!!!'), '')
  assert.equal(isSkillName('ppt-export'), true)
  assert.equal(isSkillName('PPT-Export'), false)
})

await test('parseSkillDoc reads frontmatter and body', () => {
  const doc = parseSkillDoc('---\nname: demo\ndescription: "A demo: skill"\nuser-invocable: false\n---\n\n# Body\n')
  assert.equal(doc.hasFrontmatter, true)
  assert.equal(doc.map.name, 'demo')
  assert.equal(doc.map.description, 'A demo: skill')
  assert.equal(doc.map['user-invocable'], 'false')
  assert.equal(doc.body, '# Body')
  assert.equal(parseSkillDoc('# no frontmatter').hasFrontmatter, false)
})

await test('parseSkillDoc folds YAML block scalars', () => {
  const folded = parseSkillDoc('---\nname: demo\ndescription: >\n  line one\n  line two\n---\nbody')
  assert.equal(folded.map.description, 'line one line two')
  const literal = parseSkillDoc('---\nname: demo\ndescription: |\n  line one\n  line two\n---\nbody')
  assert.equal(literal.map.description, 'line one\nline two')
})

await test('buildSkillDocument round-trips through parseSkillDoc', () => {
  const built = buildSkillDocument({ name: 'demo', description: 'Use when testing', body: 'Step 1' })
  const parsed = parseSkillDoc(built)
  assert.equal(parsed.map.name, 'demo')
  assert.equal(parsed.map.description, 'Use when testing')
  assert.equal(parsed.body, 'Step 1')
})

await test('normalizeArchivePath rejects escapes and accepts nested paths', () => {
  assert.equal(normalizeArchivePath('skill\\refs\\a.txt'), 'skill/refs/a.txt')
  assert.equal(normalizeArchivePath('./skill/SKILL.md'), 'skill/SKILL.md')
  assert.equal(normalizeArchivePath('../evil.md'), null)
  assert.equal(normalizeArchivePath('/abs/SKILL.md'), null)
  assert.equal(normalizeArchivePath('C:/x/SKILL.md'), null)
  assert.equal(normalizeArchivePath('a/../../b.md'), null)
})

await test('unpackPayload strips a single wrapper directory', () => {
  const zip = zipSync({
    'my-skill/SKILL.md': strToU8('---\nname: my-skill\ndescription: demo\n---\nbody'),
    'my-skill/references/a.txt': strToU8('hello'),
  })
  const archive = unpackPayload({ kind: 'zip', zip: Buffer.from(zip).toString('base64') })
  assert.equal(archive.name, 'my-skill')
  assert.deepEqual([...archive.files.keys()].sort(), ['SKILL.md', 'references/a.txt'])
})

await test('unpackPayload rejects missing or duplicate SKILL.md', () => {
  const missing = zipSync({ 'a/readme.md': strToU8('x') })
  assert.throws(
    () => unpackPayload({ kind: 'zip', zip: Buffer.from(missing).toString('base64') }),
    error => error.code === 'archive_invalid',
  )
  const duplicate = zipSync({ 'a/SKILL.md': strToU8('x'), 'b/SKILL.md': strToU8('y') })
  assert.throws(
    () => unpackPayload({ kind: 'zip', zip: Buffer.from(duplicate).toString('base64') }),
    error => error.code === 'archive_invalid',
  )
})

await test('unpackPayload rejects unsafe zip paths', () => {
  const unsafe = zipSync({ '../SKILL.md': strToU8('x') })
  assert.throws(
    () => unpackPayload({ kind: 'zip', zip: Buffer.from(unsafe).toString('base64') }),
    error => error.code === 'path_unsafe',
  )
})

await test('provider publishes 298 overrides and the bundled creator', async () => {
  const store = { failClosed: false, disabledSet: () => new Set(['legacy-skill']) }
  const provider = createProvider({}, store)
  const candidates = await provider.list()
  const disabled = candidates.find(item => item.name === 'legacy-skill')
  assert.ok(disabled)
  assert.equal(disabled.rank, 298)
  assert.equal(disabled.invocation.modelInvocable, false)
  assert.equal(disabled.invocation.userInvocable, false)
  const creator = candidates.find(item => item.name === 'skill-center-creator')
  assert.ok(creator)
  assert.equal(creator.rank, 350)
  assert.equal(creator.invocation.modelInvocable, true)
})

await test('provider fails closed over every known name when storage is unreadable', async () => {
  const store = { failClosed: true, disabledSet: () => new Set() }
  const provider = createProvider({}, store)
  const names = (await provider.list()).map(item => item.name)
  assert.ok(names.includes('skill-center-creator'))
})

await test('store refuses writes when storage is missing', async () => {
  const store = new SkillStore({})
  await store.ready()
  assert.equal(store.writable, false)
  assert.equal(store.failClosed, true)
  await assert.rejects(store.setEnabled('demo', false), error => error.code === 'policy_unavailable')
})

await test('store persists a sorted disabled policy', async () => {
  const tables = { policy: new Map(), catalog_installs: new Map() }
  const table = name => ({
    get: key => tables[name].get(key),
    entries: () => tables[name].entries(),
    put: async (key, value) => {
      tables[name].set(key, value)
    },
    delete: async key => tables[name].delete(key),
  })
  const ctx = { get: name => (name === 'storageDomain' ? { open: async () => ({ table }) } : undefined) }
  const store = new SkillStore(ctx)
  await store.ready()
  assert.equal(store.writable, true)
  await store.setEnabled('b-skill', false)
  await store.setEnabled('a-skill', false)
  assert.deepEqual(store.policy().disabled, ['a-skill', 'b-skill'])
  await store.setEnabled('a-skill', true)
  assert.deepEqual(store.disabledSet(), new Set(['b-skill']))
})

function memoryDeps() {
  const tables = { policy: new Map(), catalog_installs: new Map() }
  const table = name => ({
    get: key => tables[name].get(key),
    entries: () => tables[name].entries(),
    put: async (key, value) => {
      tables[name].set(key, value)
    },
    delete: async key => tables[name].delete(key),
  })
  const ctx = { get: name => (name === 'storageDomain' ? { open: async () => ({ table }) } : undefined) }
  return { ctx, store: new SkillStore(ctx) }
}

await test('createSkill writes supporting files and rejects escaped paths', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsc-create-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, store } = memoryDeps()
    const deps = { ctx, store }
    await assert.rejects(
      createSkill(deps, {
        name: 'demo',
        description: 'demo skill',
        body: '# body',
        files: [{ path: '../escape.md', content: 'x' }],
      }),
      error => error.code === 'path_unsafe',
    )
    const result = await createSkill(deps, {
      name: 'demo',
      description: 'demo skill',
      body: '# body',
      files: [{ path: 'references/topic.md', content: 'detail' }],
    })
    assert.equal(readFileSync(join(dirname(result.path), 'references', 'topic.md'), 'utf8'), 'detail')
  } finally {
    process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

await test('deleteSkill removes an agents-root copy when no dsh copy exists', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsc-dsh-'))
  const agentsHome = mkdtempSync(join(tmpdir(), 'dsc-agents-'))
  const previousDsh = process.env.DSH_HOME
  const previousAgents = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = dshHome
  process.env.DSH_AGENTS_HOME = agentsHome
  try {
    const target = join(agentsHome, 'skills', 'shared-skill')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), '---\nname: shared-skill\ndescription: shared\n---\nbody')
    const { ctx, store } = memoryDeps()
    const result = await deleteSkill({ ctx, store }, 'shared-skill')
    assert.equal(result.removed, target)
  } finally {
    process.env.DSH_HOME = previousDsh
    process.env.DSH_AGENTS_HOME = previousAgents
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(agentsHome, { recursive: true, force: true })
  }
})

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\n${passed} test(s) passed`)