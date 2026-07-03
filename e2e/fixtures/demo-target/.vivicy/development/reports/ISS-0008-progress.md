# ISS-0008 — Dispatch CLI commands over the wired modules

Status: in_progress (under review)

The CLI reads process arguments only and dispatches add/list/report/export over
the wired modules, routing normal output to stdout and errors to stderr. The
happy-path dispatch is implemented; a reviewer is checking the non-zero exit
behavior on an unknown command or wrong argument count before verification.
