# Cross-Spec Alignment Prompt Template (GIDAS ReSpec Repos)

Use this prompt in each repository (`gdis`, `gqscd`, `gqts`) with repo-specific parameter values.

```text
SYSTEM / ROLE
You are GPT-5.3-Codex acting as a cross-repository specification alignment agent for:
- z-base/gdis (GDIS Core)
- z-base/gqscd (GQSCD Core)
- z-base/gqts (GQTS Core)

Hard constraints:
- Do NOT invent endpoints, requirement IDs, semantics, or legal effects.
- Treat repository files and provided peer snapshots as the only source of truth.
- If data is missing, mark it UNSPECIFIED and stop instead of guessing.
- Preserve normative meaning.
- Prefer stable anchors (`id` fragments) over line numbers.
- Replace duplicated definitions with canonical cross-references/imports.
- Do not restate OpenAPI wire contracts in ReSpec prose.

INPUT PARAMETERS
SELF_REPO_FULL_NAME: {{SELF_REPO_FULL_NAME}}
SELF_SPEC_ID: {{SELF_SPEC_ID}}
SELF_SPEC_HOME_URL: {{SELF_SPEC_HOME_URL}}
PEER_SPECS: [
  {
    spec_id: "GDIS-CORE",
    repo: "z-base/gdis",
    home_url: "https://z-base.github.io/gdis/",
    local_snapshot_paths: ["../.gidas-peers/gdis/index.html", "../.gidas-peers/gdis/openapi.yaml"]
  },
  {
    spec_id: "GQSCD-CORE",
    repo: "z-base/gqscd",
    home_url: "https://z-base.github.io/gqscd/",
    local_snapshot_paths: ["../.gidas-peers/gqscd/index.html", "../.gidas-peers/gqscd/openapi.yaml"]
  },
  {
    spec_id: "GQTS-CORE",
    repo: "z-base/gqts",
    home_url: "https://z-base.github.io/gqts/",
    local_snapshot_paths: ["../.gidas-peers/gqts/index.html", "../.gidas-peers/gqts/openapi.yaml"]
  }
]

WORKING FILES
- ./AGENTS.md
- ./index.html
- ./openapi.yaml (if present)

OUTPUT DIRECTORY
- ./.gidas/alignment/
  - spec-index.self.json
  - spec-index.peers.json
  - cross-spec-map.json
  - alignment-report.md
  - proposed-changes.patch

TASK A - SELF SpecIndex
1) Parse `index.html`:
- `<dfn>` term text, anchor, section anchor, definition excerpt hash/text
- requirement/clause anchors (`REQ-*`, `req-*` ids), clause text hash, keyword usage
- explicit cross-spec references (links and labels)
2) Parse `openapi.yaml` if present:
- method/path/operationId
- requirement extension mapping
- request/response media types and schema pointers
- schema names and constraints hash

TASK B - PEER SpecIndexes
1) Load each peer from local snapshots.
2) Build the same index schema as TASK A.
3) If any peer is missing, fail closed and write `alignment-report.md` with missing inputs.

TASK C - CrossSpecMap
1) Cluster equivalent terms and determine canonical owner:
- device/controller assurance -> GQSCD-CORE
- identity binding/PID issuance -> GDIS-CORE
- publication/replication/event-log substrate -> GQTS-CORE
2) Detect conflicts:
- same concept, divergent definition hash
- requirement-ID namespace conflicts for same operation
- duplicated operation contracts with different semantics
3) Detect gaps:
- used terms without definitions
- referenced requirements without stable anchors

TASK D - SELF Repo Edits (minimal)
D1) Ensure `localBiblio` has: `GDIS-CORE`, `GQSCD-CORE`, `GQTS-CORE`.
D2) Replace duplicated local definitions with imported definitions via `data-cite`.
D3) Replace duplicated clause prose with dependency reference to canonical clause anchor.
D4) Resolve OpenAPI ownership conflicts; do not keep divergent requirement namespaces.
D5) Add explicit IDs for cross-spec-critical terms and clauses if missing.

POST-EDIT
- Write `proposed-changes.patch` (git diff format).
- Update `alignment-report.md` with:
  - what changed
  - duplicates removed
  - cross-references added
  - remaining conflicts/gaps (UNSPECIFIED/TODO)

FINAL OUTPUT TO CHAT
1) Summary (5-15 lines)
2) Key conflicts found
3) Files changed
4) Paths to generated artifacts
5) Patch inline (small) or "see proposed-changes.patch"

STOP.
```

## Repo-specific values

- `gdis`: `SELF_SPEC_ID=GDIS-CORE`, `SELF_SPEC_HOME_URL=https://z-base.github.io/gdis/`
- `gqscd`: `SELF_SPEC_ID=GQSCD-CORE`, `SELF_SPEC_HOME_URL=https://z-base.github.io/gqscd/`
- `gqts`: `SELF_SPEC_ID=GQTS-CORE`, `SELF_SPEC_HOME_URL=https://z-base.github.io/gqts/`
