# 03 - Category Rules

Document status: stable contract.

## Purpose

The Categorizer assigns a category label to an expense based on a deterministic, ordered set of keyword rules applied to the expense description.

## Rule shape

A category rule has a `category` label and a list of lowercase `keywords`. A rule matches an expense when the lowercased description contains at least one of the rule's keywords as a substring.

## Evaluation order

Rules are evaluated in declaration order. The first matching rule wins; later rules are not consulted once a match is found. Evaluation is case-insensitive.

## Default category

When no rule matches, the Categorizer assigns the category `uncategorized`. The default category label is a fixed constant and is never configurable per call.

## Determinism

Categorization is a pure function of the description and the rule list. The same description and rule list must always produce the same category. The Categorizer holds no mutable state between calls.
