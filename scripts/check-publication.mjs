import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const policy = JSON.parse(readFileSync(new URL('./publication-policy.json', import.meta.url)))
const digest = value => createHash('sha256').update(value.toLowerCase()).digest('hex')

// Fingerprints are maintained outside the distributed source. Never add confidential
// names or paths as examples, error messages or regression fixtures here.
export function inspectText(source, fingerprints = policy.deniedTokenDigests) {
  const denied = new Set(fingerprints)
  const seen = new Set(source.match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? [])
  if ([...seen].some(token => denied.has(digest(token)))) return 'restricted content fingerprint'
  if (/(?:[A-Z]:[\\/]Users[\\/][^\s"']+|\/(?:Users|home)\/[^/\s]+\/(?!runner\/))/i.test(source))
    return 'developer absolute path'
  for (const match of source.matchAll(/(?:github\.com[:/]|api\.github\.com\/repos\/)([\w.-]+\/[\w.-]+)/g)) {
    const repo = match[1].replace(/\.git$/, '')
    if (repo.startsWith(policy.owner + '/') && !policy.repositories.includes(repo))
      return 'unreviewed first-party repository'
  }
  return null
}

export function checkPublication({ history = false, cwd = root } = {}) {
  const git = args => execFileSync('git', args, { cwd, maxBuffer: 512 * 1024 * 1024 })
  const failures = []
  const inspect = (label, bytes) => {
    if (bytes.includes(0)) return // Bundle integrity/provenance is checked separately.
    const issue = inspectText(bytes.toString('utf8'))
    if (issue) failures.push(`${label}: ${issue}`)
  }
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)
  for (const file of new Set(files)) if (existsSync(resolve(cwd, file))) inspect(file, readFileSync(resolve(cwd, file)))
  let objects = 0
  if (history) {
    if (git(['rev-parse', '--is-shallow-repository']).toString().trim() !== 'false') throw new Error('Publication history check requires fetch-depth: 0')
    const ids = git(['rev-list', '--objects', '--all']).toString().trim().split('\n').filter(Boolean).map(line => line.split(' ')[0])
    const batch = execFileSync('git', ['cat-file', '--batch'], { cwd, input: ids.join('\n') + '\n', maxBuffer: 512 * 1024 * 1024 })
    let offset = 0
    while (offset < batch.length) {
      const end = batch.indexOf(10, offset)
      const [oid, type, length] = batch.subarray(offset, end).toString().split(' ')
      const size = Number(length)
      if (!Number.isSafeInteger(size)) throw new Error('Invalid Git object response')
      const bytes = batch.subarray(end + 1, end + 1 + size)
      if (['blob', 'commit', 'tag'].includes(type)) { inspect(`object ${oid}`, bytes); objects++ }
      offset = end + 2 + size
    }
  }
  if (failures.length) throw new Error(`Publication boundary failed:\n${failures.join('\n')}`)
  console.log(`Publication content checked: ${new Set(files).size} files, ${objects} historical objects`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  checkPublication({ history: process.argv.includes('--history') })
