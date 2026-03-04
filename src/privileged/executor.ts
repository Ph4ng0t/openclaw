import { executePrivilegedViaGate } from "./gate-client.js";
import type { PrivilegedRequestRecord } from "./types.js";

export async function executePrivilegedRequest(record: PrivilegedRequestRecord): Promise<string> {
  return await executePrivilegedViaGate(record);
}
