# Changelog

## [0.1.1-alpha.9](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v0.1.0-alpha.9...dark-factory-cli-v0.1.1-alpha.9) (2026-05-27)


### Features

* **331.1-B:** extract Critic Orchestrator + Policy Engine + Trusted-Surface Rebind into packages/cli/ ([#1](https://github.com/momentiq-ai/dark-factory/issues/1)) ([4314365](https://github.com/momentiq-ai/dark-factory/commit/4314365e69760356be06ad9948ee97aaa611b55f))
* **phase-c:** extract services [#4](https://github.com/momentiq-ai/dark-factory/issues/4)/[#5](https://github.com/momentiq-ai/dark-factory/issues/5)/[#7](https://github.com/momentiq-ai/dark-factory/issues/7)/[#9](https://github.com/momentiq-ai/dark-factory/issues/9) from sage3c ([#2](https://github.com/momentiq-ai/dark-factory/issues/2)) ([4d499b6](https://github.com/momentiq-ai/dark-factory/commit/4d499b6e17b6bb8cabd9e06879f3dd46618bc6d3))
* **phase-d:** extract services [#6](https://github.com/momentiq-ai/dark-factory/issues/6) (Merge Queue Admission) + [#8](https://github.com/momentiq-ai/dark-factory/issues/8) (Audit Trail) — final extraction phase ([#3](https://github.com/momentiq-ai/dark-factory/issues/3)) ([623ac93](https://github.com/momentiq-ai/dark-factory/commit/623ac93b4f4dbf9e15b4713aeab894089f882231))
* **phase-e:** reusable workflow shapes — ends chicken-and-egg ([#4](https://github.com/momentiq-ai/dark-factory/issues/4)) ([26a0a4f](https://github.com/momentiq-ai/dark-factory/commit/26a0a4fe405b20dc951b42539f420669387b2b72))
* **phase-f-local:** port hook-facing CLI subcommands — review/gate-push/doctor/gates/stats (subscription cost model) ([#9](https://github.com/momentiq-ai/dark-factory/issues/9)) ([e55495b](https://github.com/momentiq-ai/dark-factory/commit/e55495bcb5f2ef3bf55534d3c954c4284f1b3618))
* **phase-f:** dogfood — wire real critic + sentinel status-check; validate Phase E workflows end-to-end ([#5](https://github.com/momentiq-ai/dark-factory/issues/5)) ([01765a4](https://github.com/momentiq-ai/dark-factory/commit/01765a409d6e0c69bd2baccc882f74317d6794ae))


### Bug Fixes

* **adapters,workflows:** A2 retry-helpers + Cursor sqlite3 prebuilt (closes [#11](https://github.com/momentiq-ai/dark-factory/issues/11)) ([#13](https://github.com/momentiq-ai/dark-factory/issues/13)) ([dc60d87](https://github.com/momentiq-ai/dark-factory/commit/dc60d8768370bc0633279d356b0e864685005ba1))
* **agent-critic:** upload evidence artifact + surface per-critic errors + loud degradation warning ([#19](https://github.com/momentiq-ai/dark-factory/issues/19)) ([d4fac63](https://github.com/momentiq-ai/dark-factory/commit/d4fac635876f2972128cf25a33fba8beac01e0ca)), closes [#18](https://github.com/momentiq-ai/dark-factory/issues/18)
* **cli:** add adapters barrel so ./adapters subpath export resolves ([#23](https://github.com/momentiq-ai/dark-factory/issues/23)) ([#24](https://github.com/momentiq-ai/dark-factory/issues/24)) ([0d85974](https://github.com/momentiq-ai/dark-factory/commit/0d85974cb604120067d8652c47d7a5e8927ad373))
* **cli:** don't block consumer PRs that run no critic-side quality gates ([#32](https://github.com/momentiq-ai/dark-factory/issues/32)) ([aaf6d3c](https://github.com/momentiq-ai/dark-factory/commit/aaf6d3c95aed5533a0ddc04a3c863e746d9bf8ab))
* **phase-b-publish-pkg:** lazy-load vendor adapters so CLI runs under --ignore-scripts ([#8](https://github.com/momentiq-ai/dark-factory/issues/8)) ([f2d834b](https://github.com/momentiq-ai/dark-factory/commit/f2d834b2c8a9264d0b1d7ab54b58ba2420b21ce6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @momentiq/dark-factory-schemas bumped from * to 0.1.1-alpha.8
