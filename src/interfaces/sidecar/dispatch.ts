import {
  failure,
  INTERNAL_ERROR,
  INVALID_REQUEST,
  isNotification,
  isRequest,
  type JsonRpcResponse,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  success,
} from "./protocol.js";

/** A method the sidecar answers. Async because the real handlers do I/O. */
export type Handler = (params: unknown) => Promise<unknown> | unknown;

export type Methods = Readonly<Record<string, Handler>>;

/**
 * One line of stdin to at most one line of stdout.
 *
 * Returning `null` rather than throwing for a notification keeps the caller's
 * loop free of protocol knowledge: it writes what it is given and writes
 * nothing when it is given nothing.
 */
export async function dispatch(line: string, methods: Methods): Promise<JsonRpcResponse | null> {
  const parsed = parseLine(line);
  if (!parsed.ok) return failure(null, PARSE_ERROR, "invalid JSON");
  if (!isRequest(parsed.message)) return failure(null, INVALID_REQUEST, "not a JSON-RPC request");

  const request = parsed.message;
  const id = request.id ?? null;
  if (isNotification(request)) return null;
  return invoke(methods[request.method], request.method, request.params, id);
}

/**
 * A handler's result, or the error it failed with.
 *
 * A throwing handler becomes an error response rather than an unhandled
 * rejection: the sidecar answering "that failed" keeps the supervisor's restart
 * for the case where the process is actually gone, which is the distinction
 * `runtime.md` §1's crash-loop degradation depends on.
 */
async function invoke(
  handler: Handler | undefined,
  method: string,
  params: unknown,
  id: string | number | null,
): Promise<JsonRpcResponse> {
  if (handler === undefined) return failure(id, METHOD_NOT_FOUND, `no such method: ${method}`);
  try {
    return success(id, await handler(params));
  } catch (error) {
    return failure(id, INTERNAL_ERROR, messageOf(error));
  }
}

type ParseResult = { ok: true; message: unknown } | { ok: false };

function parseLine(line: string): ParseResult {
  try {
    return { ok: true, message: JSON.parse(line) as unknown };
  } catch {
    return { ok: false };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
