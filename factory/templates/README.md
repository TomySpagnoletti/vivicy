# {{PROJECT_NAME}}

{{PROJECT_NAME}} is built with **Vivicy**, an autonomous development factory. You write the product intention as a canonical spec; Vivicy freezes it into a hashed baseline, extracts a traceable set of issues, and runs a two-agent loop — one agent implements each slice, an independent agent reviews it — verifying every change against a real test gate and drawing the result live on an architecture map.

**Vivi** is the governess of this repository: she grills your idea into that canonical spec, drives the pipeline, keeps the architecture map tidy, and turns any later ask into a change request. You talk to her; she runs the build. Approving or rejecting a change request is the one human decision the loop waits for — everything else is autonomous.

## The project's truth lives in `.vivicy/`

`.vivicy/` is to autonomous development what `.git` is to version control: the single home for this project's intention, plan, and proof. Vivicy operates on this repository from the outside — it is never vendored in.

- `.vivicy/canonical/**` — **the product truth you write.** One Markdown file per decision area; nothing is built until at least one canonical doc is frozen into a baseline.
- `.vivicy/development/` — the extracted issues, progress ledger, and reports the factory produces.
- `.vivicy/uploads/` — source documents you imported as raw material for the spec.
- `vivicy.json` — the gate config; `gateCommand` is the test command Vivicy runs to verify every issue.
- `AGENTS.md` — the technical operating guide for any development agent working in this repo.

The code in this repository is the *result* of the build, never its reference. The reference is always the frozen canonical spec plus accepted change requests.
