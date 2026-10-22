import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Only explicitly informational files may skip tests. Markdown in plugin skills,
// test fixtures, or source directories can be executable input and is not docs.
export function documentation(path) {
  return (
    /^(README|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT)\.md$/.test(path) ||
    /^docs\/.*\.(md|mdx|png|jpe?g|gif|svg|webp)$/.test(path)
  )
}

export function classify(files, force = false) {
  // Only an explicitly informational change can skip the repository's tests.
  return { code: force || !files || files.length === 0 || files.some((file) => !documentation(file)) }
}

export function changedFiles(
  eventName,
  event,
  sha,
  git = (...args) => execFileSync('git', args, { encoding: 'utf8' }),
) {
  if (!['push', 'pull_request'].includes(eventName)) return null
  let base = eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before
  if (![base, sha].every((ref) => /^[a-f0-9]{40}$/.test(ref || '') && !/^0+$/.test(ref))) return null
  try {
    if (eventName === 'pull_request') base = git('merge-base', base, sha).trim()
    // No rename detection: both the old and new path must affect the plan.
    return git('diff', '--name-only', '--no-renames', '-z', base, sha, '--').split('\0').filter(Boolean)
  } catch {
    console.warn('Change base unavailable; running all checks.')
    return null
  }
}

export async function lastSuccessfulBase(repo, workflow, request) {
  try {
    const data = await request(
      `repos/${repo}/actions/workflows/${workflow}/runs?branch=main&event=push&status=success&per_page=100`,
    )
    return (
      data.workflow_runs.find(
        (run) =>
          run.head_branch === 'main' &&
          run.event === 'push' &&
          run.conclusion === 'success' &&
          run.head_repository?.full_name === repo,
      )?.head_sha || null
    )
  } catch {
    console.warn('Successful CI baseline unavailable; running all checks.')
    return null
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    // Comparing just event.before would lose code coverage when a newer docs
    // push cancels an older code run. Include everything since the last green CI.
    const workflow = process.env.GITHUB_WORKFLOW_REF?.split('@')[0].split('/').at(-1)
    const base = await lastSuccessfulBase(process.env.GITHUB_REPOSITORY, workflow, async (path) => {
      const response = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/${path}`, {
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`GitHub API: ${response.status}`)
      return response.json()
    })
    event = { ...event, before: base }
    try {
      if (!base) throw new Error('No successful baseline')
      execFileSync('git', ['merge-base', '--is-ancestor', base, process.env.GITHUB_SHA])
    } catch {
      event.before = null
    }
  }
  const files = changedFiles(process.env.GITHUB_EVENT_NAME, event, process.env.GITHUB_SHA)
  const plan = classify(files)
  for (const [key, value] of Object.entries(plan)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  appendFileSync(process.env.GITHUB_OUTPUT, `base=${event.before || ''}\n`)
  console.log(JSON.stringify({ files, plan }, null, 2))
}
