# Security policy

## Supported versions

Vivicy is pre-1.0 and moves fast. Only `main` is supported: security fixes land there and are never backported to an earlier tag.

## Reporting a vulnerability

Report privately — [open a draft security advisory](https://github.com/TomySpagnoletti/vivicy/security/advisories/new) on this repository. Never open a public issue for a vulnerability.

Vivicy is a local single-user tool: it runs the agent CLIs and git as you, on your machine, against the target project you point it at. Anything that escapes that boundary is in scope; anything that assumes a shared or internet-exposed deployment is not.
