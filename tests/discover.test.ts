import { test, expect } from "bun:test"
import { FakeGitHubClient, type RepoMeta } from "../src/github"
import { discover, isEligible, SEARCH_QUERIES, toEntry } from "../src/discover"

function meta(id: string, over: Partial<RepoMeta> = {}): RepoMeta {
  return {
    id,
    stars: 100,
    pushed_at: "2026-08-01",
    archived: false,
    description: "A thing.",
    fork: false,
    ...over,
  }
}

test("rejects repos under the star bar", () => {
  expect(isEligible(meta("a/b", { stars: 24 }), new Set())).toBe(false)
  expect(isEligible(meta("a/b", { stars: 25 }), new Set())).toBe(true)
})

test("rejects archived repos", () => {
  expect(isEligible(meta("a/b", { archived: true }), new Set())).toBe(false)
})

test("rejects a fork even when it clears stars and is not archived", () => {
  expect(isEligible(meta("a/b", { fork: true, stars: 10_000, archived: false }), new Set())).toBe(false)
})

test("rejects a candidate whose pushed_at is 90+ days stale, accepts 89 days", () => {
  const now = new Date("2026-08-06T00:00:00Z")
  const stale = meta("a/b", { pushed_at: "2026-05-08" }) // 90 days before now
  const fresh = meta("a/b", { pushed_at: "2026-05-09" }) // 89 days before now
  expect(isEligible(stale, new Set(), now)).toBe(false)
  expect(isEligible(fresh, new Set(), now)).toBe(true)
})

test("rejects ids already known", () => {
  expect(isEligible(meta("a/b"), new Set(["a/b"]))).toBe(false)
})

test("rejects mirrors of leaked proprietary source", () => {
  expect(isEligible(meta("someone/claude-code-source-code"), new Set())).toBe(false)
  expect(isEligible(meta("someone/system-prompts-leaks"), new Set())).toBe(false)
})

test("rejects an id with underscore separators", () => {
  expect(isEligible(meta("someone/system_prompts_leaks"), new Set())).toBe(false)
})

test("rejects a keyword-only mirror id with no leak token", () => {
  expect(isEligible(meta("someone/claude-code-system-prompts"), new Set())).toBe(false)
})

test("rejects an innocuous id whose description identifies leaked/extracted content", () => {
  const m = meta("someone/prompt-vault", {
    description: "A mirror of Claude's leaked internal system prompt, extracted verbatim.",
  })
  expect(isEligible(m, new Set())).toBe(false)
})

test("accepts a legitimate prompt-engineering tool that is not a mirror", () => {
  const m = meta("someone/prompt-forge", {
    description: "Write, test, and version system prompts for any LLM agent, with built-in evals.",
  })
  expect(isEligible(m, new Set())).toBe(true)
})

// Descriptions that merely discuss, defend against, teach about, or compare
// "system prompt" + "claude"/"leak" are common and legitimate — the fix
// pins each of these against being caught by the retargeted, tighter
// description patterns. An id-only false positive was never reported, so
// each case here uses an innocuous id and puts the topical language only in
// the description, matching how a real search result would look.
test("accepts prompt-injection-defense tooling that discusses leaking, not leaked content", () => {
  const m = meta("someone/redteam-toolkit", {
    description:
      "A red-teaming toolkit to test whether your system prompt leaks to users under adversarial input",
  })
  expect(isEligible(m, new Set())).toBe(true)
})

test("accepts a prompt-injection guard that prevents leakage rather than causing it", () => {
  const m = meta("someone/injection-guard", {
    description: "Prompt injection guard: prevents system prompt leakage to end users",
  })
  expect(isEligible(m, new Set())).toBe(true)
})

test("accepts a Gandalf-style CTF game about making an LLM leak its prompt", () => {
  const m = meta("someone/prompt-ctf", {
    description: "Gandalf-style CTF game where you try to make the LLM leak its system prompt",
  })
  expect(isEligible(m, new Set())).toBe(true)
})

test("accepts a curated list of example Claude system prompts for prompt engineering practice", () => {
  const m = meta("someone/prompt-examples", {
    description:
      "A curated list of example system prompts for Claude, written by the community for prompt engineering practice",
  })
  expect(isEligible(m, new Set())).toBe(true)
})

test("accepts best-practice templates for writing a Claude system prompt", () => {
  const m = meta("someone/prompt-templates", {
    description: "Best practices and templates for writing a system prompt for Claude",
  })
  expect(isEligible(m, new Set())).toBe(true)
})

test("accepts a comparison of system prompt strategies across vendors including Claude", () => {
  const m = meta("someone/prompt-compare", {
    description: "Compare system prompt strategies across Claude, GPT-4, and Gemini",
  })
  expect(isEligible(m, new Set())).toBe(true)
})

test("accepts a blog post analysing how Claude's system prompt changed over time", () => {
  const m = meta("someone/prompt-blog", {
    description: "A blog post analysing why Claude's system prompt changed between versions",
  })
  expect(isEligible(m, new Set())).toBe(true)
})

test("toEntry truncates a long description to 120 characters", () => {
  const e = toEntry(meta("a/b", { description: "x".repeat(400) }), "2026-08-06")
  expect(e.summary.length).toBeLessThanOrEqual(120)
})

test("toEntry falls back when description is null", () => {
  expect(toEntry(meta("a/b", { description: null }), "2026-08-06").summary).toBe(
    "No description provided upstream.",
  )
})

test("toEntry marks the entry as active discovery with today's date", () => {
  const e = toEntry(meta("a/b"), "2026-08-06")
  expect(e.status).toBe("active")
  expect(e.source).toBe("discovery")
  expect(e.added).toBe("2026-08-06")
  expect(e.metrics.stars).toBe(100)
})

test("discover deduplicates across queries", async () => {
  const gh = new FakeGitHubClient([meta("a/b"), meta("c/d")])
  const found = await discover(gh, new Set(), "2026-08-06", 10)
  expect(found.map((e) => e.id).sort()).toEqual(["a/b", "c/d"])
})

test("discover excludes ids already known", async () => {
  const gh = new FakeGitHubClient([meta("a/b"), meta("c/d")])
  const found = await discover(gh, new Set(["a/b"]), "2026-08-06", 10)
  expect(found.map((e) => e.id)).toEqual(["c/d"])
})

// Pins the shape of SEARCH_QUERIES so a future edit cannot silently collapse
// it back to topics-only: topic search is structurally blind to any repo
// that carries no GitHub topics at all, which is how the largest misses in
// the audit went unindexed.
test("SEARCH_QUERIES contains both topic-qualified and name/description queries", () => {
  const topicQueries = SEARCH_QUERIES.filter((q) => q.startsWith("topic:"))
  const nameOrDescriptionQueries = SEARCH_QUERIES.filter(
    (q) => q.includes("in:name") || q.includes("in:description"),
  )
  expect(topicQueries.length).toBeGreaterThanOrEqual(4)
  expect(nameOrDescriptionQueries.length).toBeGreaterThan(0)
})

// Relevance is carried by WHICH query matched, not by anything on the repo:
// `isEligible` deliberately has no topical check, and plenty of correct
// entries (agent-sprite-forge, humanizer-cli, ratchet) say neither "claude"
// nor "skill" anywhere in their id or description -- they are in the index
// because a `topic:` query found them. That makes every query load-bearing
// as the ONLY relevance gate, so each one has to be anchored to a short
// curated field: a topic, a name, or a description.
//
// `in:readme` is not such a field. It is full text over every README on
// GitHub, so `SKILL.md in:readme` matched 1,364,363 repos -- sorted by stars
// that is public-apis, awesome-selfhosted, awesome-go, storybook -- and with
// perQuery at the 1000-result API cap it pushed ~3,600 unrelated repos into
// a single candidate PR, every one of them stamped kind: "skill".
test("every search query is anchored to a topic, name, or description field", () => {
  const unanchored = SEARCH_QUERIES.filter(
    (q) => !q.startsWith("topic:") && !q.includes("in:name") && !q.includes("in:description"),
  )
  expect(unanchored).toEqual([])
})
