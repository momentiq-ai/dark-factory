# Changelog

## [0.12.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-schemas-v0.11.0...dark-factory-schemas-v0.12.0) (2026-06-21)


### Features

* **objectives:** 2c — source-criterion binding ratchet ([#221](https://github.com/momentiq-ai/dark-factory/issues/221)) ([3cc2612](https://github.com/momentiq-ai/dark-factory/commit/3cc26121af9c2e4646451c8c6d744d6c0a651fdc))

## [0.11.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-schemas-v0.10.0...dark-factory-schemas-v0.11.0) (2026-06-20)


### Features

* df prove — closeout proof readout (CLI + df_prove MCP) ([#215](https://github.com/momentiq-ai/dark-factory/issues/215)) ([cdff677](https://github.com/momentiq-ai/dark-factory/commit/cdff67776cb2b3b91ceb3393d4c41c07c02dcbd0))

## [0.10.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-schemas-v0.9.0...dark-factory-schemas-v0.10.0) (2026-06-20)


### Features

* verifiable-objectives Phase 2a — df publish + Cerebe storage facade ([#212](https://github.com/momentiq-ai/dark-factory/issues/212)) ([e2f3c13](https://github.com/momentiq-ai/dark-factory/commit/e2f3c13b8af8024f357b5d1b4bc93d814ea91c2d))

## [0.9.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-schemas-v0.8.0...dark-factory-schemas-v0.9.0) (2026-06-20)


### Features

* verifiable-objectives Phase 1 — Objective contract + manifest validator ([#208](https://github.com/momentiq-ai/dark-factory/issues/208)) ([4f53313](https://github.com/momentiq-ai/dark-factory/commit/4f53313de2da5a0ce169bb3350e5efd9fb3f2bda))


### Bug Fixes

* address Copilot review — tighten Objective id regex (kind pairing + dotted cycles), normalize cycle ids, harden manifest parsing ([#210](https://github.com/momentiq-ai/dark-factory/issues/210)) ([58f3239](https://github.com/momentiq-ai/dark-factory/commit/58f32394ec4e8b656c957c19d6bce65ff49b4220))

## [0.8.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-schemas-v0.7.0...dark-factory-schemas-v0.8.0) (2026-06-12)


### Features

* **cli:** graduate verification-route runner to `df verify` + enforce diffHash content-binding ([#195](https://github.com/momentiq-ai/dark-factory/issues/195)) ([18a7990](https://github.com/momentiq-ai/dark-factory/commit/18a79901150f8b7143382cab6ee1b5fc7e5a7e77)), closes [#192](https://github.com/momentiq-ai/dark-factory/issues/192) [#194](https://github.com/momentiq-ai/dark-factory/issues/194)

## [0.7.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-schemas-v0.6.1...dark-factory-schemas-v0.7.0) (2026-06-08)


### Features

* **gate-core:** evidence-gated validation routes — schema + additive planner + route-runner + diffHash binding — Cycle 21 ([#187](https://github.com/momentiq-ai/dark-factory/issues/187)) ([1623bd5](https://github.com/momentiq-ai/dark-factory/commit/1623bd53eb56cd5cc5e202df415e97a7343b6de2))

## [0.6.1](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-schemas-v0.6.0...dark-factory-schemas-v0.6.1) (2026-06-06)


### Bug Fixes

* **adapters/codex-sdk:** narrow [#109](https://github.com/momentiq-ai/dark-factory/issues/109) bwrap detection — filter findings, don't discard the run (closes [#148](https://github.com/momentiq-ai/dark-factory/issues/148)) ([#149](https://github.com/momentiq-ai/dark-factory/issues/149)) ([b04468a](https://github.com/momentiq-ai/dark-factory/commit/b04468a8fe5e8393714c53794c204c609a9d50cb))

## [0.6.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-schemas-v0.5.0...dark-factory-schemas-v0.6.0) (2026-06-03)


### Features

* **331.1-B:** extract Critic Orchestrator + Policy Engine + Trusted-Surface Rebind into packages/cli/ ([#1](https://github.com/momentiq-ai/dark-factory/issues/1)) ([4314365](https://github.com/momentiq-ai/dark-factory/commit/4314365e69760356be06ad9948ee97aaa611b55f))
* **adapters/codex-sdk:** expose sandbox_mode for trusted-container contexts ([#98](https://github.com/momentiq-ai/dark-factory/issues/98)) ([ada1ab2](https://github.com/momentiq-ai/dark-factory/commit/ada1ab2982670734bb7e5e2f6c9fb078c43482bc)), closes [#68](https://github.com/momentiq-ai/dark-factory/issues/68)
* **aggregator:** self-consistency probe + requireCorroborationFor policy — implements consumer dark-factory-platform[#112](https://github.com/momentiq-ai/dark-factory/issues/112) ([#118](https://github.com/momentiq-ai/dark-factory/issues/118)) ([31345c1](https://github.com/momentiq-ai/dark-factory/commit/31345c1d60a54ce1841f573101a17f1e1dbc8447))
* **cli:** bounded lockfile strategy for review-packet ([#104](https://github.com/momentiq-ai/dark-factory/issues/104)) ([891ff30](https://github.com/momentiq-ai/dark-factory/commit/891ff303e12324566254eb04fba84a69da6129ed)), closes [#67](https://github.com/momentiq-ai/dark-factory/issues/67)
* **critics:** consume .git/agent-reviews/_dockerbuild-evidence.json — implements consumer dark-factory-platform[#141](https://github.com/momentiq-ai/dark-factory/issues/141) upstream half ([#115](https://github.com/momentiq-ai/dark-factory/issues/115)) ([d43527e](https://github.com/momentiq-ai/dark-factory/commit/d43527e50c48f64d49191fa6d735d7d1d21b6f6c))
* **doctor:** per-critic auth probe + cloud-env detection + --json — implements consumer issue dark-factory-platform[#56](https://github.com/momentiq-ai/dark-factory/issues/56) ([#114](https://github.com/momentiq-ai/dark-factory/issues/114)) ([27bce85](https://github.com/momentiq-ai/dark-factory/commit/27bce854d5f1158079a089ca2f8a80d8f911cf4f))
* **schemas+adapters:** add CliReviewFinding.requiresHumanJudgment LLM self-flag ([#111](https://github.com/momentiq-ai/dark-factory/issues/111)) ([7041549](https://github.com/momentiq-ai/dark-factory/commit/7041549b569798d2d31a484930a5b1c785bceb0a)), closes [#106](https://github.com/momentiq-ai/dark-factory/issues/106)
* **schemas+adapters:** per-critic token + retries telemetry — Cycle 6.3 Stage 1 ([#65](https://github.com/momentiq-ai/dark-factory/issues/65)) ([4e99467](https://github.com/momentiq-ai/dark-factory/commit/4e99467ea8d944e37fc96ec28d3b799c454b9630))
* **skills:** df skills install command + bundled chief-engineer-review/blitz skills — implements consumer dark-factory-platform[#192](https://github.com/momentiq-ai/dark-factory/issues/192) ([#119](https://github.com/momentiq-ai/dark-factory/issues/119)) ([986c47c](https://github.com/momentiq-ai/dark-factory/commit/986c47c353fdad28314130f85edcd7a82a92cd67))

## [0.4.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-schemas-v0.3.0...dark-factory-schemas-v0.4.0) (2026-06-02)


### Features

* **adapters/codex-sdk:** expose sandbox_mode for trusted-container contexts ([#98](https://github.com/momentiq-ai/dark-factory/issues/98)) ([ada1ab2](https://github.com/momentiq-ai/dark-factory/commit/ada1ab2982670734bb7e5e2f6c9fb078c43482bc)), closes [#68](https://github.com/momentiq-ai/dark-factory/issues/68)
* **cli:** bounded lockfile strategy for review-packet ([#104](https://github.com/momentiq-ai/dark-factory/issues/104)) ([891ff30](https://github.com/momentiq-ai/dark-factory/commit/891ff303e12324566254eb04fba84a69da6129ed)), closes [#67](https://github.com/momentiq-ai/dark-factory/issues/67)
* **schemas+adapters:** add CliReviewFinding.requiresHumanJudgment LLM self-flag ([#111](https://github.com/momentiq-ai/dark-factory/issues/111)) ([7041549](https://github.com/momentiq-ai/dark-factory/commit/7041549b569798d2d31a484930a5b1c785bceb0a)), closes [#106](https://github.com/momentiq-ai/dark-factory/issues/106)

## [0.3.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-schemas-v0.2.0...dark-factory-schemas-v0.3.0) (2026-05-31)


### Features

* **331.1-B:** extract Critic Orchestrator + Policy Engine + Trusted-Surface Rebind into packages/cli/ ([#1](https://github.com/momentiq-ai/dark-factory/issues/1)) ([4314365](https://github.com/momentiq-ai/dark-factory/commit/4314365e69760356be06ad9948ee97aaa611b55f))
* **schemas+adapters:** per-critic token + retries telemetry — Cycle 6.3 Stage 1 ([#65](https://github.com/momentiq-ai/dark-factory/issues/65)) ([4e99467](https://github.com/momentiq-ai/dark-factory/commit/4e99467ea8d944e37fc96ec28d3b799c454b9630))

## [0.2.0-alpha.8](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-schemas-v0.1.1-alpha.8...dark-factory-schemas-v0.2.0-alpha.8) (2026-05-31)


### Features

* **schemas+adapters:** per-critic token + retries telemetry — Cycle 6.3 Stage 1 ([#65](https://github.com/momentiq-ai/dark-factory/issues/65)) ([4e99467](https://github.com/momentiq-ai/dark-factory/commit/4e99467ea8d944e37fc96ec28d3b799c454b9630))

## [0.1.1-alpha.8](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-schemas-v0.1.0-alpha.8...dark-factory-schemas-v0.1.1-alpha.8) (2026-05-27)


### Features

* **331.1-B:** extract Critic Orchestrator + Policy Engine + Trusted-Surface Rebind into packages/cli/ ([#1](https://github.com/momentiq-ai/dark-factory/issues/1)) ([4314365](https://github.com/momentiq-ai/dark-factory/commit/4314365e69760356be06ad9948ee97aaa611b55f))
