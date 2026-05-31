import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SECRET_PATTERNS_BASH_ERE,
  SECRET_PATTERNS_JS,
  scrubBody,
  scrubString,
} from "../../src/handoff/scrub.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "fixtures/secret-patterns.bash-ere");

describe("scrub — SECRET_PATTERNS SoT", () => {
  it("SECRET_PATTERNS_BASH_ERE is byte-equal to the DFP-vendored fixture", () => {
    const vendored = readFileSync(fixture, "utf8").replace(/\n$/, "");
    expect(SECRET_PATTERNS_BASH_ERE).toBe(vendored);
  });
});

describe("scrub — POSIX-class translation (must work, not just compile)", () => {
  it.each([
    ["env-var (api_key)",        "MY_API_KEY=secretvalue123"],
    ["env-var (password)",       "DB_PASSWORD: hunter2"],
    ["env-var (access_key)",     "AWS_ACCESS_KEY_ID=AKIAEXAMPLE12345678"],
    ["GitHub token",             "ghp_abcdefghijklmnopqrst1234567890"],
    ["Slack token",              "xoxb-FAKE-FAKE-FAKE"],
    ["AWS access key id",        "AKIAIOSFODNN7EXAMPLE"],
    ["OpenAI sk- key",           "sk-FAKEkeyvalue0123456789abcdef"],
    ["Anthropic sk-ant key",     "sk-ant-api03-FAKEvalue0123456789abcdef"],
    ["Google AIza key",          "AIzaSyFAKEvalueExample0123"],
    ["credentialed URL (postgres)", "postgres://admin:hunter2@db.internal:5432/app"],
    ["credential path .aws/credentials", "stored in ~/.aws/credentials on the box"],
    ["credential path .codex/auth.json", "see ~/.codex/auth.json"],
    ["PEM block",                "-----BEGIN RSA PRIVATE KEY-----"],
  ])("matches secret-shaped content: %s", (_label, sample) => {
    const re = new RegExp(SECRET_PATTERNS_JS.source, SECRET_PATTERNS_JS.flags);
    expect(re.test(sample)).toBe(true);
  });

  it.each([
    ["plain note text",          "I chose path 1 over path 2 because of X"],
    ["TODO note",                "TODO: remove the workaround after #42 lands"],
    ["technical word 'token'",   "the auth token-bucket algorithm"],
    ["URL without auth",         "https://github.com/momentiq-ai/dark-factory"],
  ])("does NOT match non-secret content: %s", (_label, sample) => {
    const re = new RegExp(SECRET_PATTERNS_JS.source, SECRET_PATTERNS_JS.flags);
    expect(re.test(sample)).toBe(false);
  });
});

describe("scrub — refusal contract (no value echo)", () => {
  it("scrubBody returns line numbers + filename only; never the matched content", () => {
    const body = "ok line 1\nleftover: AKIAIOSFODNN7EXAMPLE\nok line 3\n";
    const result = scrubBody(body, "/tmp/note.md");
    expect(result.ok).toBe(false);
    expect(result.refusal).toContain("/tmp/note.md");
    expect(result.refusal).toContain("2");
    expect(result.refusal).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("scrubBody returns ok=true on clean content", () => {
    const body = "all clean lines\nno secrets here\n";
    expect(scrubBody(body, "/tmp/note.md")).toEqual({ ok: true });
  });

  it("scrubString refuses on secret-shaped substring without echo", () => {
    const result = scrubString("leftover debug AKIAIOSFODNN7EXAMPLE", "PR #303 title");
    expect(result.ok).toBe(false);
    expect(result.refusal).toContain("PR #303 title");
    expect(result.refusal).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
