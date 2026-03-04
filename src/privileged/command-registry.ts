export type PrivilegedCommandSpec = {
  id: string;
  description: string;
  argv: string[];
  allowCwd?: boolean;
  dangerous: boolean;
};

export const PRIVILEGED_COMMANDS: Record<string, PrivilegedCommandSpec> = {
  "system.shutdown": {
    id: "system.shutdown",
    description: "Shutdown the host machine",
    argv: ["shutdown", "-h", "now"],
    dangerous: true,
  },
  "system.reboot": {
    id: "system.reboot",
    description: "Reboot the host machine",
    argv: ["reboot"],
    dangerous: true,
  },
  "git.status": {
    id: "git.status",
    description: "Run git status in a repository",
    argv: ["git", "status", "--short"],
    allowCwd: true,
    dangerous: false,
  },
  "git.pull.rebase": {
    id: "git.pull.rebase",
    description: "Run git pull --rebase in a repository",
    argv: ["git", "pull", "--rebase"],
    allowCwd: true,
    dangerous: true,
  },
  "pnpm.test": {
    id: "pnpm.test",
    description: "Run project tests",
    argv: ["pnpm", "test"],
    allowCwd: true,
    dangerous: false,
  },
  "pnpm.build": {
    id: "pnpm.build",
    description: "Run project build",
    argv: ["pnpm", "build"],
    allowCwd: true,
    dangerous: false,
  },
};

export function getPrivilegedCommandSpec(commandId: string): PrivilegedCommandSpec | null {
  return PRIVILEGED_COMMANDS[commandId] ?? null;
}
