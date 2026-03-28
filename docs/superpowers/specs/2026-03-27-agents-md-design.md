# AGENTS.md Design Spec

## Goal

Create an `AGENTS.md` at project root that helps AI agents (primarily Claude Code) orient quickly when starting a new session. Optimized for the first 10 seconds — scan the map, find the relevant entry point, start working.

## Audience

Claude Code sessions on this project. Complements existing CLAUDE.md files (which handle behavioral rules like timestamps, commit preferences). AGENTS.md covers project structure and navigation only.

## Approach

Map-First: lead with an annotated directory tree, then a component lookup table, then how-to recipes, then key file references. No narrative — just scannable structure.

## Sections

### 1. Directory Map

Annotated tree of every meaningful directory and file. Format: path + inline comment explaining purpose. Covers roe-search, roe-pipeline, scripts, schema, local data dirs, and docs.

### 2. Component Quick Reference

Single table with columns: Component, Entry Point, Purpose, Infra. Rows for roe-search, roe-pipeline, scripts, D1, R2, Vectorize. Lets agent quickly understand what talks to what.

### 3. How-To Recipes

Copy-paste command blocks for common operations:
- Run/deploy roe-search
- Run/deploy/test roe-pipeline
- Process single episode (local)
- Batch process episodes (local)
- Apply schema to D1
- Regenerate summaries
- Backfill guests

### 4. Key Files

Table mapping important files to what they contain: schema.sql, wrangler configs, .env, r2-cors.json, batch-progress.json, docs directories.

## What This File Does NOT Cover

- Behavioral rules (timestamps, commit style) — that's CLAUDE.md
- Workflow preferences (plan mode, subagents) — that's ~/CLAUDE.md
- Deep implementation details — read the actual source files
- Human onboarding — this is agent-optimized
