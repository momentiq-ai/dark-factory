# @momentiq/dark-factory-schemas

TypeScript types and JSON Schemas for Dark Factory artifacts:

- `darkfactory.yaml` — declarative config consumed by the CLI
- per-SHA evidence (gate results, quality-gate evidence, finding cache)
- cycle-doc trailers (`Cycle: X.Y` line shape)
- review packet types shared between the CLI and any external integration

## Usage

```ts
import {
  parseAgentReviewConfig,
  parseCriticResult,
  type ReviewPacket,
  type CriticConfig,
} from "@momentiq/dark-factory-schemas";

const config = parseAgentReviewConfig(rawJson);
```

## Status

`0.1.0-alpha.0` — extracted from `momentiq-ai/sage3c:tools/agent-review/src/schema.ts` per cycle 331.1 Phase B. Stable schema content; package wrapper is alpha pending the Phase B-PUBLISH dogfood validation.

## License

Apache-2.0 — same license as `@momentiq/dark-factory-cli`. The OSS critic surface depends on these schemas.
