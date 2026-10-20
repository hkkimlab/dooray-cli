#!/usr/bin/env node
import { run } from "./cli.js";
import type { Io } from "./core/app.js";

const io: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  stdin: process.stdin,
  env: process.env,
  fetch,
};

process.exitCode = await run(process.argv, io);
