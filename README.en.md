# dsh-skill-center

English | [中文](./README.md)

A local skill manager plugin for DeepSeek Harness: inspect, enable, create and upload skills in one panel, and install them from ClawHub.

<details>
<summary>Architecture</summary>

```text
@double-coding/dsh-skill-center
├── host apply(ctx)
│   ├── skills.registerProvider              disabled overlay (rank 298) + bundled creator (rank 350)
│   ├── agent/created → register again       shadows preset-scoped skills
│   ├── tools.register("skill_center_create") writes generated SKILL.md into ~/.dsh/skills
│   ├── webServer.register("/dsh-skill-center") panel API
│   └── storageDomain.open("dsh_skill_center")  policy and install ledger
└── client
    ├── slots "main" + "sidebar.panellist"    the skill center panel
    └── uiWorkspace.startSession({ prompt })  prefill a session for creation
```

</details>

## What it does

| | |
| --- | --- |
| Installed | Lists `~/.dsh/skills`, `~/.agents/skills` and agent-preset skills; same-name copies collapse to one row |
| Toggle | Never edits `SKILL.md`; the policy lives in a local ledger and is applied as a lower-rank override |
| Detail | Paths, every copy, the Markdown-rendered `SKILL.md` body, catalog version and local modification state |
| Delete | Works for local and shared skill roots; symlinks and preset skills are refused |
| Create | One sentence in the panel → a new session runs `skill-center-creator` → the tool writes the skill |
| Upload | `.zip`, a folder, or a single `SKILL.md`; path, file-count and size checks; conflicts require confirmation |
| Market | ClawHub popular list, search, body preview, install / update / uninstall |

## Install

The plugin requires the `skills` service. Missing `tools`, `webServer` or `storageDomain` degrades that surface only.

```bash
# From npm (DSH Desktop / web profile)
dsh plugin --profile web add @double-coding/dsh-skill-center

# Local development
npm install
npm run build
dsh plugin --profile web add link:.
```

Restart DSH; a "Skill Center" entry appears in the sidebar.

## Why toggling does not edit files

The same `SKILL.md` is shared with Codex, Qoder and editors. Rewriting its frontmatter leaks state into user files and cannot be reverted after uninstalling the plugin. Instead the plugin publishes a candidate for each disabled name with `modelInvocable=false`, `userInvocable=false` and `rank=298`, which beats the native providers (user roots 400/450, presets 299). File bytes stay untouched.

Agent presets mount their skill provider in a nearer preset layer, which a global registration cannot shadow, so the plugin also registers itself inside every live agent context.

## Creation flow

1. "Add → Create skill" takes a short goal.
2. The panel calls `uiWorkspace.startSession(undefined, { prompt, clearPreviousDraft: true })` with `/skill-center-creator …` as the draft.
3. `skill-center-creator` asks about purpose, triggers and constraints, then names and writes the skill.
4. The model calls `skill_center_create`; the host validates and writes `~/.dsh/skills/<name>/SKILL.md`.
5. The panel refreshes and shows the new skill.

DSH defaults to the `workspace-write` sandbox, so the model's own file tools cannot write to the home directory; the host tool performs the write.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | Writable root `$DSH_HOME/skills` |
| `DSH_AGENTS_HOME` | `~/.agents` | Shared skill root `$DSH_AGENTS_HOME/skills` (list, toggle and delete; no new skills written here) |

## Security boundaries

- Routes live on the host web server; no extra port. Mutations check same-origin.
- The server rebuilds all paths; the client only sends skill names and `owner`/`slug`.
- Archives: relative paths only, depth ≤ 8, files ≤ 500, unpacked size ≤ 64 MiB.
- Catalog content is third-party prompt text: preview before install, never auto-install, never execute bundled scripts.
- If policy storage is unreadable the plugin fails closed: everything counts as disabled and writes are refused.

## Development

```bash
npm run typecheck   # host + client
npm run build       # tsc + esbuild
npm test            # names, frontmatter, archives, policy, provider candidates
npm run check       # all of the above
```

The reference implementation was used only to verify host contracts and interaction patterns; its repository subscriptions and backup/rollback modules are not included.

## Third-party

`skills/skill-center-creator` is taken from [`skill-creator` in anthropics/skills](https://github.com/anthropics/skills), used under Apache-2.0; see `LICENSE.txt` in that directory. Changes are limited to the frontmatter name and a short DeepSeek Harness section about where skills are written and how the tests run.

## License

MIT