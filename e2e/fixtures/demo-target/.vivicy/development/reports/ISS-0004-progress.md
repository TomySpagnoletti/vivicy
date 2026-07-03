# ISS-0004 — Categorize an expense by ordered keyword rules

Status: in_progress

The Categorizer is being implemented as a pure function that assigns a category
from an ordered keyword-rule list (first match wins, case-insensitive) and
defaults to the fixed uncategorized label. The rule table and case-insensitive
matching are in place; the default-label path and the CLI wiring are still being
finished under an active working session.
