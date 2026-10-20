import { describe, expect, it } from "vitest";
import { apiError, DoorayError, notFound } from "../../src/core/errors.js";
import { createPrinter, parseFormat, renderCsv, renderTable } from "../../src/core/output.js";

describe("parseFormat", () => {
  it("accepts table/json/csv", () => {
    expect(parseFormat("csv")).toBe("csv");
  });
  it("rejects others with usage exit", () => {
    expect(() => parseFormat("xml")).toThrow(DoorayError);
    try {
      parseFormat("xml");
    } catch (e) {
      expect((e as DoorayError).exit).toBe(2);
      expect((e as DoorayError).message).toBe("invalid format: xml (table|json|csv)");
    }
  });
});

describe("renderTable", () => {
  it("aligns columns using display width (Korean is double width)", () => {
    const s = renderTable({ columns: ["ID", "NAME"], rows: [["1", "회의록"], ["22", "a"]] });
    expect(s).toBe(["ID  NAME", "1   회의록", "22  a"].join("\n") + "\n");
  });
  it("prints only the header for empty rows", () => {
    expect(renderTable({ columns: ["A"], rows: [] })).toBe("A\n");
  });
});

describe("renderCsv", () => {
  it("quotes fields with commas, quotes and newlines", () => {
    const s = renderCsv({ columns: ["a", "b"], rows: [["x,y", 'say "hi"'], ["line\nbreak", "plain"]] });
    expect(s).toBe('a,b\n"x,y","say ""hi"""\n"line\nbreak",plain\n');
  });
});

function capture(format: "table" | "json" | "csv", quiet = false) {
  const buf = { out: "", err: "" };
  const p = createPrinter(format, { out: (s) => (buf.out += s), err: (s) => (buf.err += s) }, quiet);
  return { p, buf };
}

describe("printer", () => {
  const table = { columns: ["ID"], rows: [["1"]] };

  it("json mode prints the json value", () => {
    const { p, buf } = capture("json");
    p.emit({ id: "1" }, table);
    expect(JSON.parse(buf.out)).toEqual({ id: "1" });
  });

  it("csv mode prints the table as csv", () => {
    const { p, buf } = capture("csv");
    p.emit({}, table);
    expect(buf.out).toBe("ID\n1\n");
  });

  it("info goes to stderr unless quiet", () => {
    const loud = capture("table");
    loud.p.info("saved");
    expect(loud.buf.err).toBe("saved\n");
    const quiet = capture("table", true);
    quiet.p.info("saved");
    expect(quiet.buf.err).toBe("");
  });

  it("error writes to stderr and, in json mode, an error object to stdout", () => {
    const { p, buf } = capture("json");
    p.error(apiError(42, "boom"));
    expect(buf.err).toBe("error: boom\n");
    expect(JSON.parse(buf.out)).toEqual({ error: { code: 5, message: "boom", apiCode: 42 } });
  });

  it("error in table mode does not touch stdout", () => {
    const { p, buf } = capture("table");
    p.error(notFound("gone"));
    expect(buf.out).toBe("");
    expect(buf.err).toBe("error: gone\n");
  });

  it("non-Dooray errors map to exit 1", () => {
    const { p, buf } = capture("json");
    p.error(new Error("weird"));
    expect(JSON.parse(buf.out).error.code).toBe(1);
  });
});
