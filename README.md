# mw-dx — Fail-closed TypeScript bridge client for the local Rocksoul daemons.

**Repository:** [`A-L-L-A-H/mw-dx`](https://github.com/A-L-L-A-H/mw-dx) · **Stack:** TypeScript · Bun

## What it does

Connects a desktop shell to gateway :4510, core :4520, mcp :4530, sandbox :4540, and mw-rid :4480 without ORM imports.

## Quick start

```bash
bun install
```

## Verify

```bash
bun run typecheck
bun test
```

## Configuration

- **Key configuration:** Local daemon URLs

## Notes

This repository contains the bridge client only; it does not include a Tauri/Rust application directory.
