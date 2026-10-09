// Fails when the built code (dist/, electron/) imports a package that isn't in "dependencies". Installers and the
// npm package only include dependencies, so such an import works in development and tests but breaks for users:
// 1.0.0-alpha.1's desktop app couldn't start because express-rate-limit was a devDependency.
//   npm run build && node scripts/check-runtime-deps.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const allowed = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), pkg.name, 'electron'])
const builtin = new Set(builtinModules)

const files = []
const walk = dir => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(c|m)?js$/.test(f)) files.push(p) } }
walk('dist')
walk('electron')

const missing = new Map()
for (const file of files) {
  const code = readFileSync(file, 'utf8')
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"./][^'"]*)['"]/g)) {
    const spec = m[1]
    if (spec.startsWith('node:')) continue
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (builtin.has(name) || allowed.has(name)) continue
    // Words in strings that only look like imports aren't packages; anything installed is.
    if (!existsSync(join('node_modules', name, 'package.json'))) continue
    missing.set(name, [...(missing.get(name) ?? []), file])
  }
}
if (missing.size) {
  for (const [name, where] of missing) console.error(`✗ ${name} is used by ${[...new Set(where)].join(', ')} but isn't in "dependencies"`)
  process.exit(1)
}
console.log(`✓ every package the built code uses is in "dependencies" (${files.length} files checked)`)
