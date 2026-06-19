# Rendering reference (v2)

- `scripts/render-digest.mjs`:
  - `renderDigest({ generatedAt, since, repos, now }) => string` — one self-contained
    HTML page: header, an empty `<!--ATTENTION-SLOT-->`, a **New PRs to review**
    section, and a **Tasks** section (`<details><summary>#num · state · title</summary>
    <pre class="taskbody">raw verbatim, escaped, pre-wrap</pre></details>`). Inline CSS
    + inline PTR script; no external asset loads. `repos: [{ slug, newPrs:[{number,
    title,url,createdAt,summary}], tasks:[{num,state,title,raw}], prError }]`.
  - `renderAttention(items) => string` — just the `<section class="attn">…</section>`
    for Job B's slot splice; `[]` → `''`.
  - `renderArchiveIndex(dates)` — the `/archive/` list page (still imported by
    write-digest — keep it exported).
  - helpers: `escapeHtml`, `richText`, `relTime`.
- `scripts/write-digest.mjs` → `writeDigest({siteDir,date,generatedAt,html,status,
  url,error,lastScheduledRunAt})`.
- The old `render-card.mjs` / `imgDataUri` / card visuals / `captures.mjs` are
  **unused** in v2 (left on disk). No screenshots in the digest.
