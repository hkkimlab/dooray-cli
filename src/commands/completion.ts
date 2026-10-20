// Shell completion: tiny per-shell scripts that ask `dooray __complete <words…>` for candidates,
// so new commands never need regenerated scripts.
import type { Command, Option } from "commander";
import type { Ctx } from "../core/app.js";
import { oneOf } from "./common.js";

const SCRIPTS: Record<string, string> = {
  bash: `# bash: source <(dooray completion bash)
_dooray() {
  local IFS=$'\\n'
  COMPREPLY=( $(compgen -W "$(dooray __complete "\${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null)" -- "\${COMP_WORDS[COMP_CWORD]}") )
}
complete -F _dooray dooray
`,
  zsh: `#compdef dooray
# zsh: source <(dooray completion zsh)   or save as _dooray in your $fpath
_dooray() {
  local -a candidates
  candidates=("\${(@f)$(dooray __complete \${words[2,CURRENT-1]} 2>/dev/null)}")
  compadd -a candidates
}
compdef _dooray dooray
`,
  fish: `# fish: dooray completion fish > ~/.config/fish/completions/dooray.fish
complete -c dooray -f -a '(dooray __complete (commandline -opc)[2..-1] 2>/dev/null)'
`,
};

const takesValue = (opts: readonly Option[], flag: string) => opts.some((o) => (o.long === flag || o.short === flag) && (o.required || o.optional));

/** Walks the command tree along the typed words and lists what can come next. */
export function candidates(program: Command, words: string[]): string[] {
  let cmd = program;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith("-")) {
      if (!w.includes("=") && takesValue([...cmd.options, ...program.options], w)) i++;
      continue;
    }
    const sub = cmd.commands.find((c) => c.name() === w || c.aliases().includes(w));
    if (!sub) break; // a positional argument
    cmd = sub;
  }
  const subs = cmd.commands.map((c) => c.name()).filter((n) => !n.startsWith("__"));
  const flags = [...cmd.options, ...(cmd === program ? [] : program.options)].flatMap((o) => (o.long ? [o.long] : []));
  return [...subs, ...flags];
}

export function registerCompletion(program: Command, ctx: Ctx): void {
  program
    .command("completion <shell>")
    .description("print a completion script: bash | zsh | fish")
    .action((shell: string) => {
      ctx.io.out(SCRIPTS[oneOf("shell", Object.keys(SCRIPTS), shell)!]!);
    });

  program
    .command("__complete [words...]", { hidden: true })
    .helpOption(false)
    .allowUnknownOption()
    .action((words: string[] | undefined, _o: unknown, self: Command) => {
      // Unknown options are left in self.args alongside the words.
      const typed = self.args.length ? self.args : (words ?? []);
      ctx.io.out(candidates(program, typed).join("\n") + "\n");
    });
}
