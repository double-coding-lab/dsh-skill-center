import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'dist', 'client.js')
mkdirSync(dirname(outfile), { recursive: true })

const pluginId = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).name

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  sourcemap: true,
  logLevel: 'info',
  packages: 'external',
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})
