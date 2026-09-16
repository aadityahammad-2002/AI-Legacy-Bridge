# analysis-engine

Browser-side code analysis engine. Runs entirely client-side — no source code
leaves the browser during analysis; only the final structured JSON result is
sent to the backend's ingest API.

## Files

- **`parser.js`** — Ported from [CodeFlow](https://github.com/braedonsaunders/codeflow)
  (MIT License). This is CodeFlow's `Parser` object plus its `calcBlast` /
  `calcHealth` helpers, with the CodeFlow UI/React app removed. Handles:
  - Function/method extraction (real AST via `acorn` + `@babel/standalone` for JS/TS;
    regex-based for Java, Go, Rust, Python, PHP, C/C++, Kotlin, Swift, Scala, Ruby, etc.)
  - Design pattern detection (Singleton, Factory, Observer, custom hooks, etc.)
  - Security scanning (hardcoded secrets, `eval()`, SQL injection patterns, debug flags)
  - Duplicate code detection
  - Blast-radius / impact analysis (`calcBlast`)
  - Health score / grade (`calcHealth`)

  Do not hand-edit the ported logic itself unless fixing a bug — keep it as a
  faithful port so future CodeFlow improvements can be re-ported later.

- **`orchestrator.js`** — Code we wrote. Combines `parser.js`'s pieces into a
  single `analyzeRepository(repoMeta, files)` call, adds class/annotation
  extraction (JVM-family languages) and file-level import-graph resolution,
  and shapes the final output into the JSON contract our backend's
  `POST /api/repository/ingest` endpoint expects (see
  `PROJECT_DOCUMENTATION.md`, section 5).

## Usage

```js
import { configureAnalysisEngine, analyzeRepository } from './analysis-engine/orchestrator.js';
import * as acorn from 'acorn';
import * as Babel from '@babel/standalone';

// Call once at app startup
configureAnalysisEngine({ acorn, Babel });

// files: [{ path: 'src/UserService.java', content: '...' }]
const result = await analyzeRepository(
  { name: 'my-repo', source: 'github', url: 'https://github.com/user/repo' },
  files,
  (progress) => console.log(progress.phase, progress.current, '/', progress.total)
);

// result is ready to POST to the backend ingest endpoint as-is
await fetch('/api/repository/ingest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(result),
});
```

## Dependencies

- `acorn` — AST parser for JS/TS
- `@babel/standalone` — JSX + TypeScript transform (so acorn can parse them)

Both are optional at runtime — if not configured, JS/TS extraction falls back
to the regex-based extractor (same one used for all other languages).

## Not yet wired up (next steps)

- Repository input sources (GitHub API fetch / JSZip / File System Access API)
  that produce the `files` array this module expects
- Call-graph edges (`Parser.findCalls` / `resolveCallGraphImportPath`) are
  ported and available but not yet wired into `orchestrator.js`'s output —
  currently only the simpler file-level import graph is included
- Dead-code detection (`stats.dead` is currently hardcoded to 0)
