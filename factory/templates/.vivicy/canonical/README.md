# Canonical Documentation — Write Your Product Here

Document status: placeholder.

This directory is where **you, the project owner, write the product and architecture truth for {{PROJECT_NAME}}**. Nothing in the Vivicy factory decides what your product is — these documents do.

## What goes here

- One Markdown file per coherent product or architecture decision area (`.vivicy/canonical/01-<area>.md`, `.vivicy/canonical/02-<area>.md`, ...).
- One source of truth per fact. State each decision in exactly one canonical document and link to it from anywhere else; never duplicate it.
- When an executable contract exists (a schema, a migration, code), the doc summarizes and links to it instead of copying it.

## Spec-quality rules

These make your spec extract into complete, testable requirements instead of prose the factory has to guess at:

- **Document every lifecycle as a complete state machine.** When something has states (a job, an order, a session, a connection), give it an enumerated state list, an allowed-transitions table (`| From | To | Trigger |`), an explicit set of terminal states, and the rules that resolve racing transitions and require idempotent operations. A prose "it can be paused or cancelled" leaves the implementer guessing the matrix; a transition table extracts into exhaustive transition-coverage requirements.
- **For every known failure mode, pair a detection condition with a recovery procedure** so the behavior is an implementable obligation rather than improvisation.
- **State each normative obligation in its own sentence.** A `must` / `must not` / `required` / `never` rule buried inside an explanatory paragraph is easy to miss; lift it into its own atomic statement so it becomes its own requirement.

## How the factory uses these docs

1. You write canonical docs.
2. Vivicy **freezes and hashes** the doc set into a Doc Baseline Lock manifest.
3. The semantic extraction reads **only** `.vivicy/canonical/**/*.md` from that frozen baseline to produce the requirement catalog, traceability matrix, vertical issues, and the architecture-map issue index.
4. After freeze, every product change enters through Vivicy's controlled change flow and produces a new frozen baseline — never a silent edit.

## Until you write at least one canonical doc

There is nothing to extract: the requirement catalog is empty, no issues are generated, and the architecture map is empty. The factory cannot invent your product. Write your first canonical document, freeze a baseline, and run extraction.
