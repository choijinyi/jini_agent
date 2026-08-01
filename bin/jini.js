#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error('\x1b[31m[jini] 치명적 오류:\x1b[0m', err?.stack || err?.message || err);
  process.exit(1);
});
