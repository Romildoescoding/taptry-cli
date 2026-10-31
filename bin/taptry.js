#!/usr/bin/env node
const { main } = require("../lib/cli");

main(process.argv.slice(2)).then(
  (code) => {
    // null: a long-running command (the MCP server) that exits on its own.
    if (code !== null) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`taptry crashed: ${err.stack || err}\n`);
    process.exitCode = 1;
  },
);
