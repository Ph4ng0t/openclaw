import { describe, expect, it } from "vitest";
import { isPrivilegedHostExecCommand } from "./bash-tools.host-exec-privilege.js";

describe("isPrivilegedHostExecCommand", () => {
  it("flags rm commands with delete targets", () => {
    expect(isPrivilegedHostExecCommand({ command: "rm -rf ./tmp" })).toBe(true);
    expect(isPrivilegedHostExecCommand({ command: "/bin/rm -- ./tmp" })).toBe(true);
  });

  it("ignores rm invocations without delete targets", () => {
    expect(isPrivilegedHostExecCommand({ command: "rm --help" })).toBe(false);
    expect(isPrivilegedHostExecCommand({ command: "echo rm -rf ./tmp" })).toBe(false);
  });
});
