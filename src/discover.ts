import { daysBetween, STALE_DAYS } from "./reap"
import type { GitHubClient, RepoMeta } from "./github"
import type { Entry } from "./schema"

export const MIN_STARS = 25

// Topic search alone is structurally blind to any repo that carries no GitHub
// topics at all — an audit found 7 of 14 well-known misses in exactly that
// state. Name/description queries are the only way to reach those, so they
// are load-bearing here, not decorative: removing them silently regresses
// coverage back to topics-only with no test failure to catch it (see the
// "SEARCH_QUERIES contains both topic and name/description queries" shape
// test in discover.test.ts).
//
// Every query must stay anchored to a topic, a name, or a description.
// Nothing downstream re-checks relevance — isEligible() only screens health
// and leak-mirrors, and toEntry() stamps kind: "skill" unconditionally — so
// the query IS the relevance gate, and an unanchored one has nothing to
// catch it. `SKILL.md in:readme` was exactly that: full text over every
// README on GitHub, 1,364,363 results, which sorted by stars is public-apis,
// awesome-selfhosted, awesome-go, storybook. At the 1000-result cap below it
// alone proposed ~3,600 unrelated repos in one candidate PR.
//
// Finding repos that actually ship a SKILL.md is still worth doing; it just
// cannot be done from the repository-search endpoint, which has no filename
// qualifier. That needs the code-search API (`path:SKILL.md`), which is a
// different endpoint with its own auth and rate limits.
export const SEARCH_QUERIES = [
  "topic:claude-code",
  "topic:claude-skills",
  "topic:agent-skills",
  "topic:claude-code-plugin",
  "topic:claude-code-skills",
  "topic:claude-ai",
  "topic:agentic-coding",
  "topic:openskills",
  '"claude code" in:name,description',
  '"claude skills" in:name,description',
  '"agent skills" in:name,description',
  '"claude-code" in:name',
] as const

// A false NEGATIVE here is recoverable: discover() only feeds a PR that a human
// reviews before merge, so a mirror that slips through gets caught there. A
// false POSITIVE is silent and permanent: an ineligible repo is just skipped,
// with no log line and no PR comment, and nobody ever learns it happened. So
// the two pattern sets below are deliberately asymmetric, not symmetric:
//
// - BLOCKED_ID_PATTERNS (loose): a repo literally NAMED "system_prompts_leaks"
//   or "claude-code-system-prompts" is making the claim by naming itself that
//   — the id IS the diagnostic signal, so bare co-occurrence of the topical
//   tokens anywhere in the normalized id is enough to block it.
// - BLOCKED_DESCRIPTION_PATTERNS (tight): a free-text description merely
//   *mentioning* "system prompt" + "claude" or "leak" is common and mostly
//   legitimate — prompt-engineering guides, prompt-injection-defense tooling,
//   Gandalf-style CTF games, and posts comparing/analysing vendor prompts all
//   do this without being a mirror of anything. What's actually diagnostic of
//   a mirror is the description claiming to CONTAIN the artifact: an
//   extraction/publication verb (extracted, dumped, leaked, reverse
//   engineered, obtained, revealed) bound tightly to "system prompt(s)" or to
//   "Claude's source", not just present somewhere in the same sentence.
//
// Note the description pattern deliberately uses only the past-participle
// "leaked" (an artifact *state*: "the leaked prompt"), never bare "leak" /
// "leaks" / "leakage" (a security *property*: "prevents leakage", "test
// whether it leaks", "try to make it leak") — those describe risk or defense,
// not possession of the artifact.

// Lowercase and strip every non-alphanumeric character (hyphen, underscore, dot,
// whitespace, slash, ...) so "system-prompts_leaks", "system_prompts-leaks" and
// "systempromptsleaks" all collapse to the same comparable form before matching.
function normalizeId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

// Lowercase and unify separators to single spaces, but keep spacing and
// punctuation, so word-boundary and gap-bounded regexes still work.
function normalizeDescription(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Mirrors of leaked or proprietary Claude source. Several market themselves as
// open source. Tested against the normalized repo id only — see block comment
// above for why id vocabulary can stay loose.
export const BLOCKED_ID_PATTERNS = [
  // "system prompt(s) leak(ed)" in either order, any separator or none at all.
  /systemprompt.*leak|leak.*systemprompt/,
  // Repo names built from "claude" + "system prompt(s)" with no "leak" token
  // at all, e.g. claude-code-system-prompts.
  /claude.*systemprompt|systemprompt.*claude/,
  // Mirrors of Claude('s/ Code's) proprietary source, e.g. "claude-code-source",
  // "claude-code-source-code", "source-code-of-claude".
  /claudecodesource|sourcecodeofclaude/,
] as const

// Extraction/publication verbs that claim POSSESSION of an artifact, as
// opposed to discussing, defending against, or teaching about it.
const EXTRACTION_VERB =
  "(?:extract(?:ed|ion)?|dump(?:ed|s)?|leaked|reverse[- ]engineer(?:ed)?|obtain(?:ed)?|reveal(?:ed)?)"
// Bound the verb to the artifact within a short span (~40 chars) so
// co-occurrence anywhere in a longer description doesn't count — this is the
// "constrain the gap" half of the fix.
const GAP = ".{0,40}"

// Mirrors described in free text rather than named outright. Tested against
// the normalized description only — see block comment above for why
// description vocabulary must stay tight (a description is prose that can
// legitimately discuss the same topic without being a mirror of it).
export const BLOCKED_DESCRIPTION_PATTERNS = [
  new RegExp(
    `\\b${EXTRACTION_VERB}\\b${GAP}\\bsystem\\s*prompts?\\b` +
      `|\\bsystem\\s*prompts?\\b${GAP}\\b${EXTRACTION_VERB}\\b`,
  ),
  new RegExp(
    `\\b${EXTRACTION_VERB}\\b${GAP}\\bclaude(?:'s)?(?:\\s*code)?\\s*source\\b` +
      `|\\bclaude(?:'s)?(?:\\s*code)?\\s*source\\b${GAP}\\b${EXTRACTION_VERB}\\b`,
  ),
] as const

export function isEligible(meta: RepoMeta, known: Set<string>, now: Date = new Date()): boolean {
  if (known.has(meta.id)) return false
  if (meta.archived) return false
  if (meta.fork) return false
  if (meta.stars < MIN_STARS) return false
  // Admitting a repo the reaper would flag `stale` on its very next run is
  // incoherent: it would land as status "active" and then flip within days,
  // briefly inflating a "0 dead entries" badge with something already dead.
  if (daysBetween(meta.pushed_at, now) >= STALE_DAYS) return false
  const normalizedId = normalizeId(meta.id)
  if (BLOCKED_ID_PATTERNS.some((re) => re.test(normalizedId))) return false
  const normalizedDescription = normalizeDescription(meta.description ?? "")
  if (BLOCKED_DESCRIPTION_PATTERNS.some((re) => re.test(normalizedDescription))) return false
  return true
}

export function toEntry(meta: RepoMeta, today: string): Entry {
  const name = meta.id.split("/")[1] ?? meta.id
  const raw = (meta.description ?? "").trim()
  const summary = raw === "" ? "No description provided upstream." : raw.slice(0, 120)
  return {
    id: meta.id,
    kind: "skill",
    name,
    url: `https://github.com/${meta.id}`,
    summary,
    tags: [],
    added: today,
    source: "discovery",
    status: "active",
    metrics: {
      stars: meta.stars,
      pushed_at: meta.pushed_at,
      archived: meta.archived,
      last_checked: `${today}T00:00:00Z`,
    },
  }
}

export async function discover(
  gh: GitHubClient,
  known: Set<string>,
  today: string,
  // GitHub's Search API hard-caps any single query at 1000 results
  // (10 pages of 100). RealGitHubClient.searchRepos already paginates that
  // far, so this is the real ceiling, not an arbitrary default.
  perQuery = 1000,
): Promise<Entry[]> {
  const now = new Date(`${today}T00:00:00Z`)
  const seen = new Set(known)
  const out: Entry[] = []
  for (const query of SEARCH_QUERIES) {
    for (const meta of await gh.searchRepos(query, perQuery)) {
      if (!isEligible(meta, seen, now)) continue
      seen.add(meta.id)
      out.push(toEntry(meta, today))
    }
  }
  return out
}
