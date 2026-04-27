# Contributing to vapor-idx

Thank you for your interest in contributing. vapor-idx is a community-driven
project. All skill authors, runtime implementors, and documentation writers are
welcome.

---

## Project overview

vapor-idx is a pure RAM, per-skill indexing framework for AI skill authors. It
enables Claude skills to build structured, queryable knowledge stores from any
modality — code, pixels, 3D vertices, design elements, audio frames — without
ML models or external dependencies.

The library grew out of research into modality-based graph systems for AGI
architecture. The core insight: any modality can be decomposed into typed records
with relationships and traversed by a zero-shot reasoning model. This is a
standalone, dependency-free demonstration of that concept.

---

## What we need

### High priority
- **New modality SKILL.md files** — schema + step-by-step instructions for a
  modality not yet covered (audio waveform, video frame, geospatial, EEG, etc.)
- **Skill testing reports** — run the existing skills on real data and report
  edge cases, failures, or surprising results
- **Python 3.12+ compatibility validation**
- **Browser ESM smoke test** — validate the npm package loads and runs in a
  browser without a bundler

### Medium priority
- **Spatial index for pixel/vertex data** — R-tree or k-d tree implementation
  so range queries on x/y/z scale to millions of records
- **Local LLM API bridge** — optional module that enriches indexed relationships
  using a local Ollama / llamacpp call (no API key required)
- **Hybrid persistent mode** — optional SQLite or DuckDB backend that survives
  skill invocations while keeping the same query API

### Lower priority
- **WASM build target** — compile the Rust package to WASM for browser-native
  skills that don't need Node.js
- **Cross-skill snapshot transport** — serialise/deserialise snapshots so two
  skills can share an indexed state via a file or pipe

---

## Development setup

### Python

```bash
cd python
python -m venv .venv
source .venv/bin/activate
pip install -e .
python ../smoke_test.py   # all 10 tests must pass
```

### TypeScript

```bash
cd typescript
npm install
npx tsc -p tsconfig.json
node smoke.mjs            # all 9 tests must pass
```

### Rust

```bash
cd rust
cargo build
cargo test                # all 10 tests must pass, 0 warnings
```

---

## Adding a new modality skill

1. Create `skills/<modality-name>/SKILL.md`
2. Follow the structure of an existing skill (`skills/pixel-analyzer/SKILL.md`)
3. Include: purpose, when to trigger, schema declaration, step-by-step code,
   memory guidelines, output description
4. Open a PR with the new file and a brief test log showing the skill working
   against real data

---

## Submitting a fix

1. Fork the repository
2. Create a branch: `git checkout -b fix/<description>`
3. Make your change
4. Run all three smoke tests (Python, TypeScript, Rust)
5. Open a PR with: what broke, why, how you fixed it, test output

---

## Code style

**Python:** PEP 8, type hints on all public functions, no third-party dependencies.

**TypeScript:** `strict: true`, no `any` escapes, exports via `index.ts` only.

**Rust:** `cargo clippy` zero warnings, `cargo fmt`, no `unsafe` except where
absolutely required (prefix trie uses raw pointers with single-threaded safety
comments).

---

## Scope boundaries

vapor-idx is **not** a generative model. Contributions that require generating
data that was not in the original source (image synthesis, 3D model generation,
audio synthesis) are out of scope for the core library.

They are in scope for optional bridge modules in a `bridges/` directory — e.g.,
`bridges/image-gen/` could connect vapor-idx to a local Stable Diffusion API,
allowing a skill to: index existing pixels → query spatial gaps → request
generated fill from the bridge → index the generated pixels → reconstruct.

---

## Future architecture directions

### Local LLM API bridge (Phase 2)

```
vapor-idx (pure RAM) ──► bridge module ──► Ollama / llamacpp local API
                                           ↓
                              semantic enrichment of relationships
                              (no cloud API key required)
```

### Hybrid persistent mode (Phase 2)

```
vapor-idx query API (unchanged)
         │
         ├── in-memory backend  (current, default)
         └── SQLite/DuckDB backend (optional, persistent across skills)
```

### Full local graph mode (Phase 4)

A full local graph database backend inspired by ZSEI-style modality graph
architecture — where each modality has its own graph container and cross-modal
edges are indexed in a dedicated CrossModalIndex. This is the long-term vision
for skills that need to maintain context across invocations without cloud state.

---

## Discord

Join the community at **https://discord.gg/vapor-idx**.
