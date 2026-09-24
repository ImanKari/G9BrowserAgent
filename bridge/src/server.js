#!/usr/bin/env node
/**
 * v1 entry point, kept so existing MCP configs keep working (ARCHITECTURE §0).
 * Every QA machine's config written by v1's install.ps1 points here; in v2 this
 * simply starts the MCP shim, which talks to the g9d daemon. Point new configs
 * at mcp/shim.mjs. stdout belongs to MCP, so the note goes to stderr.
 */
process.stderr.write('[g9] bridge/src/server.js is the v1 entry point; starting the v2 MCP shim (mcp/shim.mjs). Update your MCP config to mcp/shim.mjs.\n');
await import('../../mcp/shim.mjs');
