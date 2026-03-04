import type { PrivilegedRequestRecord } from "./types.js";

export type PrivilegedGateExecuteRequest = {
  token: string;
  action: "execute";
  record: PrivilegedRequestRecord;
};

export type PrivilegedGateExecuteResponse =
  | {
      ok: true;
      message: string;
    }
  | {
      ok: false;
      error: string;
    };
