import { checkPublication } from './check-publication.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const allowed = new Set([
  '.gitattributes',
  '.gitignore',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  '.github',
  'scripts',
  '.prettierignore',
  '.prettierrc.json',
  'contract',
  'eslint.config.mjs',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'src',
  'test',
  'tsconfig.browser.json',
  'tsconfig.build.json',
  'tsconfig.json',
  'tsconfig.node.json',
])
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
for (const file of new Set(files)) {
  assert.ok(allowed.has(file.split('/')[0]), `Unexpected distribution path: ${file}`)
  assert.ok(
    !/(^|\/)(?:node_modules|dist|coverage|\.env(?:\..*)?|\.dev|\.tools|\.actera|services|migrations|deployments|ent|gen)(?:\/|$)/i.test(
      file,
    ),
    `Private or generated state: ${file}`,
  )
  assert.ok(
    !/\.(?:pem|key|p12|pfx|log|tgz|zip|exe|dump|sql)$/i.test(file),
    `Unexpected credential, archive, or runtime file: ${file}`,
  )
  if (file.endsWith('.md')) {
    const body = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body), `Control character in ${file}`)
  }
}
console.log(`Distribution boundary checked: ${new Set(files).size} files`)

checkPublication()
