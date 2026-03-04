import type { Command } from "commander";
import { loadConfig } from "../config/config.js";
import { resolvePrivilegedGatePaths } from "../privileged/gate-paths.js";
import { startPrivilegedGateServer } from "../privileged/gate-server.js";
import { defaultRuntime } from "../runtime.js";

type PrivilegedCliOpts = {
  json?: boolean;
};

function describePrivilegedGateOwnership(cfg: ReturnType<typeof loadConfig>) {
  return cfg.privileged?.enabled === true ? "managed_by_gateway" : "manual_or_disabled";
}

export function registerPrivilegedCli(program: Command) {
  const privileged = program
    .command("privileged")
    .description("Privileged gate daemon and diagnostics");
  const gate = privileged.command("gate").description("Privileged gate daemon controls");

  privileged
    .command("paths")
    .description("Show the privileged gate socket/token paths")
    .option("--json", "Output JSON", false)
    .action(async (opts: PrivilegedCliOpts) => {
      const cfg = loadConfig();
      const paths = resolvePrivilegedGatePaths(cfg);
      const ownership = describePrivilegedGateOwnership(cfg);
      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ ...paths, ownership }, null, 2));
        return;
      }
      defaultRuntime.log(`socket: ${paths.socketPath}`);
      defaultRuntime.log(`token: ${paths.tokenPath}`);
      defaultRuntime.log(`audit: ${paths.auditLogPath}`);
      defaultRuntime.log(
        ownership === "managed_by_gateway"
          ? "mode: managed by gateway (starts/stops with `openclaw gateway run`)"
          : "mode: manual or disabled (use `openclaw privileged gate run` only for standalone debugging)",
      );
    });

  gate
    .command("run")
    .description("Run the privileged gate daemon on the configured Unix socket")
    .action(async () => {
      const cfg = loadConfig();
      const server = await startPrivilegedGateServer({
        cfg,
        log: (message) => defaultRuntime.log(message),
      });
      const stop = () => {
        server.close();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await new Promise<void>((resolve) => {
        server.once("close", () => resolve());
      });
    });
}
