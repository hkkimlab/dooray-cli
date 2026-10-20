import { describe, expect, it } from "vitest";
import { runCli } from "../helpers.js";

describe("completion", () => {
  it.each([
    ["bash", "complete -F _dooray dooray"],
    ["zsh", "compdef _dooray dooray"],
    ["fish", "complete -c dooray"],
  ])("%s script", async (shell, marker) => {
    const r = await runCli(["completion", shell]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(marker);
    expect(r.out).toContain("__complete");
  });

  it("rejects unknown shells", async () => {
    expect((await runCli(["completion", "tcsh"])).code).toBe(2);
  });

  it("__complete lists nouns, then subcommands, then options; needs no config", async () => {
    const top = (await runCli(["__complete"])).out.split("\n");
    expect(top).toEqual(expect.arrayContaining(["drive", "post", "wiki", "mail", "--format"]));
    expect(top).not.toContain("__complete");
    const post = (await runCli(["__complete", "post"])).out.split("\n");
    expect(post).toEqual(expect.arrayContaining(["list", "get", "comment"]));
    const list = (await runCli(["__complete", "post", "list"])).out.split("\n");
    expect(list).toEqual(expect.arrayContaining(["--project", "--status", "--format"]));
    const alias = (await runCli(["__complete", "task", "comment"])).out.split("\n");
    expect(alias).toEqual(expect.arrayContaining(["add", "latest"]));
    const skipOpts = (await runCli(["__complete", "--profile", "gov", "drive", "--drive", "x"])).out.split("\n");
    expect(skipOpts).toEqual(expect.arrayContaining(["pull", "push"]));
  });
});
