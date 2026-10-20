import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { confirm, readLine, readSecret } from "../../src/core/prompt.js";

function io(input: string, tty: boolean) {
  const stdin = Readable.from([input]) as Readable & { isTTY?: boolean };
  stdin.isTTY = tty;
  let err = "";
  return { stdin, err: (s: string) => (err += s), get errText() { return err; } };
}

describe("confirm", () => {
  it("--yes skips the prompt", async () => {
    const i = io("", false);
    expect(await confirm(i, "delete?", true)).toBe(true);
    expect(i.errText).toBe("");
  });
  it("non-TTY without --yes is a usage error", async () => {
    await expect(confirm(io("", false), "delete?", false)).rejects.toMatchObject({ exit: 2 });
  });
  it("TTY answer y confirms, anything else declines", async () => {
    expect(await confirm(io("y\n", true), "delete?", false)).toBe(true);
    const n = io("\n", true);
    expect(await confirm(n, "delete?", false)).toBe(false);
    expect(n.errText).toContain("delete? [y/N] ");
  });
});

describe("readLine / readSecret", () => {
  it("reads a piped line (non-TTY) and trims it", async () => {
    expect(await readLine(io("  abc  \nrest", false), "id: ")).toBe("abc");
  });
  it("readSecret reads piped input without echo prompt noise", async () => {
    const i = io("tok\n", false);
    expect(await readSecret(i, "token: ")).toBe("tok");
  });
  it("readSecret on a TTY does not echo the typed characters", async () => {
    const i = io("s3cr3t\r", true);
    const stdin = i.stdin as Readable & { setRawMode?: (b: boolean) => void };
    stdin.setRawMode = () => {};
    expect(await readSecret(i, "pw: ")).toBe("s3cr3t");
    expect(i.errText).not.toContain("s3cr3t");
  });
  it("readSecret keeps surrounding spaces (they can be part of a password)", async () => {
    expect(await readSecret(io(" pass word \n", false), "")).toBe(" pass word ");
  });
  it("empty input resolves to empty string", async () => {
    expect(await readLine(io("", false), "x")).toBe("");
  });
});

describe("piped input with several prompts", () => {
  it("each readLine gets its own line", async () => {
    const i = io("first\nsecond\n", false);
    expect(await readLine(i, "")).toBe("first");
    expect(await readSecret(i, "")).toBe("second");
    expect(await readLine(i, "")).toBe("");
  });
});
