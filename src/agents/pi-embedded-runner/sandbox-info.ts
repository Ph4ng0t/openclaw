import type { ExecElevatedDefaults } from "../bash-tools.js";
import type { resolveSandboxContext } from "../sandbox.js";
import { buildSandboxFsMounts } from "../sandbox/fs-paths.js";
import type { EmbeddedSandboxInfo } from "./types.js";

export function buildEmbeddedSandboxInfo(
  sandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>,
  execElevated?: ExecElevatedDefaults,
): EmbeddedSandboxInfo | undefined {
  if (!sandbox?.enabled) {
    return undefined;
  }
  const elevatedAllowed = Boolean(execElevated?.enabled && execElevated.allowed);
  const bindMountsByHost = new Map(
    buildSandboxFsMounts(sandbox)
      .filter((mount) => mount.source === "bind")
      .map((mount) => [mount.hostRoot, mount] as const),
  );
  const fsGrants = (sandbox.fsGrants ?? [])
    .map((grant) => {
      const mount = bindMountsByHost.get(grant.path);
      if (!mount) {
        return undefined;
      }
      return {
        hostPath: mount.hostRoot,
        containerPath: mount.containerRoot,
        access: mount.writable ? ("rw" as const) : ("ro" as const),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  return {
    enabled: true,
    workspaceDir: sandbox.workspaceDir,
    containerWorkspaceDir: sandbox.containerWorkdir,
    fsGrants: fsGrants.length > 0 ? fsGrants : undefined,
    workspaceAccess: sandbox.workspaceAccess,
    agentWorkspaceMount: sandbox.workspaceAccess === "ro" ? "/agent" : undefined,
    browserBridgeUrl: sandbox.browser?.bridgeUrl,
    browserNoVncUrl: sandbox.browser?.noVncUrl,
    hostBrowserAllowed: sandbox.browserAllowHostControl,
    ...(elevatedAllowed
      ? {
          elevated: {
            allowed: true,
            defaultLevel: execElevated?.defaultLevel ?? "off",
          },
        }
      : {}),
  };
}
