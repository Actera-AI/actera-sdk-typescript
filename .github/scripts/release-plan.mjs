import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const tagPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const shaPattern = /^[a-f0-9]{40}$/

export function trustedRun(run, sha, repo) {
  return (
    run.head_sha === sha &&
    run.head_branch === 'main' &&
    run.head_repository?.full_name === repo &&
    ['push', 'workflow_dispatch'].includes(run.event) &&
    run.path === '.github/workflows/ci.yml'
  )
}

export function readiness(runs, jobs, sha, repo) {
  // A newer failure or in-progress rerun must not be hidden by an older success.
  const run = runs.filter((item) => trustedRun(item, sha, repo)).sort((a, b) => b.id - a.id)[0]
  if (!run) throw new Error('No main-branch CI exists for this exact commit. Run full CI on main before releasing.')
  if (run.status !== 'completed') return 'pending'
  if (run.conclusion !== 'success') throw new Error('Latest CI for this exact commit did not succeed.')
  const proof = jobs.find((job) => job.name === 'release-ready')
  if (!proof || proof.conclusion !== 'success')
    throw new Error(
      'Full CI coverage is required: docs-only, skipped, or legacy CI is not release evidence. Run ci manually on main.',
    )
  if (jobs.some((job) => !['success', 'skipped'].includes(job.conclusion)))
    throw new Error('CI contains an incomplete or failed job.')
  return 'ready'
}

async function api(path, allowMissing = false) {
  const response = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/${path}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30000),
  })
  if (allowMissing && response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status}): ${path}`)
  return response.json()
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 30000 }).trim()

async function checkTag(repo, tag, sha) {
  if (!tagPattern.test(tag) || !shaPattern.test(sha)) throw new Error('Invalid release tag or SHA.')
  const commit = await api(`repos/${repo}/commits/${encodeURIComponent(tag)}`)
  if (commit.sha !== sha) throw new Error('Release tag moved after CI validation; refusing to publish.')
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY
  if (process.argv.includes('--check-tag')) {
    await checkTag(repo, process.env.RELEASE_TAG, process.env.RELEASE_SHA)
    const existing = await api(`repos/${repo}/releases/tags/${encodeURIComponent(process.env.RELEASE_TAG)}`, true)
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${!existing}\n`)
    return
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const kind = process.env.GITHUB_EVENT_NAME
  let sha
  let tags
  if (kind === 'workflow_run') {
    sha = event.workflow_run.head_sha
    if (!trustedRun(event.workflow_run, sha, repo)) throw new Error('Untrusted CI completion event.')
    if (!shaPattern.test(sha)) throw new Error('Invalid CI commit SHA.')
    tags = git('tag', '--points-at', sha)
      .split('\n')
      .filter((tag) => tagPattern.test(tag))
  } else {
    const tag = kind === 'workflow_dispatch' ? event.inputs?.tag : event.ref?.replace(/^refs\/tags\//, '')
    if (!tagPattern.test(tag || '')) throw new Error('Expected a version tag.')
    sha = git('rev-parse', `refs/tags/${tag}^{commit}`)
    // A pending run can be superseded by another event for this same commit.
    // Include all its version tags so none is lost when events arrive together.
    tags =
      kind === 'workflow_dispatch'
        ? [tag]
        : git('tag', '--points-at', sha)
            .split('\n')
            .filter((item) => tagPattern.test(item))
  }
  if (!shaPattern.test(sha)) throw new Error('Invalid release commit SHA.')
  // main is fetched by checkout; tag-only commits must never bypass main CI.
  git('merge-base', '--is-ancestor', sha, 'origin/main')
  const unpublished = []
  for (const tag of tags) {
    if (!(await api(`repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, true))) unpublished.push(tag)
  }
  const releases = []
  if (unpublished.length) {
    const response = await api(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&per_page=100`)
    const runs = response.workflow_runs
    const run = runs.filter((item) => trustedRun(item, sha, repo)).sort((a, b) => b.id - a.id)[0]
    const jobs = []
    if (run?.status === 'completed' && run.conclusion === 'success') {
      for (let page = 1; ; page++) {
        // Only the latest attempt: old successful attempts must not authorize a rerun.
        const result = await api(
          `repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
        )
        jobs.push(...result.jobs)
        if (result.jobs.length < 100) break
      }
    }
    if (readiness(runs, jobs, sha, repo) === 'pending') {
      console.log(
        'CI is still running. Its completion event will publish these tags; no runner waits and no tests are repeated.',
      )
    } else {
      for (const tag of unpublished) {
        await checkTag(repo, tag, sha)
        releases.push({ tag, sha })
      }
    }
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `publish=${releases.length > 0}\nmatrix=${JSON.stringify({ include: releases })}\n`,
  )
  console.log(JSON.stringify({ releases }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
