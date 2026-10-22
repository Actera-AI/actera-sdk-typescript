import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { inspectText, checkPublication } from './check-publication.mjs'

test('content checks identify paths and unreviewed repository links without disclosing content', () => {
  const marker = ['restricted', 'fixture'].join('_')
  const fingerprints = [createHash('sha256').update(marker).digest('hex')]
  assert.equal(inspectText(marker, fingerprints), 'restricted content fingerprint')
  assert.equal(inspectText(['https://github.com/', 'Actera-AI/', 'example-confidential'].join('')), 'unreviewed first-party repository')
  assert.equal(inspectText(['C:', 'Users', 'example', 'checkout'].join('\\')), 'developer absolute path')
  assert.equal(inspectText('https://github.com/Actera-AI/actera-sdk-typescript'), null)
})

test('history scanning catches a removed leak and leaves a clean current tree insufficient', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'publication-test-'))
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  try {
    git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(cwd, 'README.md'), ['https://github.com/', 'Actera-AI/', 'example-confidential'].join(''))
    git('add', '.'); git('commit', '-m', 'fixture')
    writeFileSync(join(cwd, 'README.md'), 'Reviewed public documentation')
    git('add', '.'); git('commit', '-m', 'clean current tree')
    assert.doesNotThrow(() => checkPublication({ cwd }))
    assert.throws(() => checkPublication({ cwd, history: true }), /unreviewed first-party repository/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
