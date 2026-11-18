#!/usr/bin/env node
import { main } from '../src/cli.js';

process.title = 'hasty';

main(process.argv.slice(2)).catch((error) => {
  const message = error?.stack || error?.message || String(error);
  process.stderr.write(`\nhasty: fatal error\n${message}\n`);
  process.exitCode = 1;
});
