import { createRequire } from "node:module";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { createCtx, type Globals, type Io } from "./core/app.js";
import { EXIT_USAGE, exitCode } from "./core/errors.js";
import { createPrinter } from "./core/output.js";
import { registerAuth } from "./commands/auth.js";
import { registerCompletion } from "./commands/completion.js";
import { registerConfig } from "./commands/config.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerCalendar } from "./commands/calendar.js";
import { registerDrive } from "./commands/drive.js";
import { registerMail } from "./commands/mail.js";
import { registerMember } from "./commands/member.js";
import { registerMessenger } from "./commands/messenger.js";
import { registerMisc } from "./commands/misc.js";
import { registerPost } from "./commands/post.js";
import { registerProject } from "./commands/project.js";
import { registerReservation } from "./commands/reservation.js";
import { registerWiki } from "./commands/wiki.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

function parseLimit(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return n;
}

export function buildProgram(io: Io): Command {
  const program = new Command("dooray")
    .description("Dooray collaboration CLI (gov-dooray by default)")
    .version(version, "-v, --version")
    .option("--profile <name>", "config profile name (default: default_profile, or $DOORAY_PROFILE)")
    .option("--env <env>", "host preset override: gov|commercial")
    .option("-o, --format <format>", "output format: table|json|csv", "table")
    .option("--limit <n>", "max rows for list commands", parseLimit)
    .option("--quiet", "suppress non-essential output")
    .option("--no-color", "disable color")
    .option("--debug", "print request/response trace lines (never the token)")
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .showHelpAfterError(false);

  const ctx = createCtx(io, () => program.opts<Globals>());
  registerAuth(program, ctx);
  registerConfig(program, ctx);
  registerDoctor(program, ctx);
  registerDrive(program, ctx);
  registerCalendar(program, ctx);
  registerReservation(program, ctx);
  registerMember(program, ctx);
  registerProject(program, ctx);
  registerPost(program, ctx);
  registerWiki(program, ctx);
  registerMessenger(program, ctx);
  registerMail(program, ctx);
  registerMisc(program, ctx);
  registerCompletion(program, ctx);
  return program;
}

const HELP_CODES = new Set(["commander.helpDisplayed", "commander.version", "commander.help"]);

/** Runs the CLI and returns the process exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return HELP_CODES.has(e.code) ? 0 : EXIT_USAGE;
    // The format flag itself may be invalid, so don't reuse ctx.printer() here.
    createPrinter(program.opts<Globals>().format === "json" ? "json" : "table", io).error(e);
    return exitCode(e);
  }
}
