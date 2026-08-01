/**
 * JSON-RPC 2.0 over stdio, the host-to-sidecar transport (`runtime.md` §1).
 *
 * No local HTTP port: nothing to conflict with, nothing to firewall, nothing to
 * accidentally expose. For a local-first application that matters more than the
 * ergonomics do.
 *
 * The subset here is the half the sidecar needs — it answers requests and never
 * makes them, so there is no client-side correlation to model. Notifications are
 * accepted and ignored rather than answered, per the specification.
 */

export const JSON_RPC_VERSION = "2.0";

/** A request id. The specification permits a string, a number, or null. */
export type RequestId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly method: string;
  readonly params?: unknown;
  /** Absent for a notification, which takes no response. */
  readonly id?: RequestId;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly result: unknown;
  readonly id: RequestId;
}

export interface JsonRpcFailure {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly error: JsonRpcError;
  readonly id: RequestId;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * The specification's reserved codes. Otto adds none of its own yet: a handler
 * that throws is an internal error, and there is nothing else that fails here.
 */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

export function success(id: RequestId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSON_RPC_VERSION, result, id };
}

export function failure(id: RequestId, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: JSON_RPC_VERSION, error: { code, message }, id };
}

/** Whether a parsed message is a well-formed request this sidecar can act on. */
export function isRequest(message: unknown): message is JsonRpcRequest {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as Partial<JsonRpcRequest>;
  return candidate.jsonrpc === JSON_RPC_VERSION && typeof candidate.method === "string";
}

/**
 * A request with no id is a notification: the specification requires that no
 * response be sent, which is a different thing from a response with a null id.
 */
export function isNotification(request: JsonRpcRequest): boolean {
  return !("id" in request) || request.id === undefined;
}
