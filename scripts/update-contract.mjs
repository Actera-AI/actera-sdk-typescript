import { copyFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const source = process.argv[2]
if (!source) throw new Error('Usage: node scripts/update-contract.mjs <actera-api-checkout>')
execFileSync(process.execPath, [resolve(source, 'scripts/check-contract.mjs')], { stdio: 'inherit' })
const manifest = JSON.parse(readFileSync(resolve(source, 'openapi/manifest.json')))
const tag = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
if (tag !== manifest.tag) throw new Error('Check out the exact contract release tag first')
if (execFileSync('git', ['status', '--porcelain', '--', 'openapi'], { cwd: source, encoding: 'utf8' }).trim()) throw new Error('Contract release has local edits')
const bytes = readFileSync(resolve(source, 'openapi/actera.openapi.json'))
if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('Contract checksum mismatch')
for (const file of ['actera.openapi.json', 'manifest.json']) copyFileSync(resolve(source, 'openapi', file), new URL(`../contract/${file}`, import.meta.url))
console.log(`Pinned contract ${tag}; regenerate types and review the diff before committing`)
