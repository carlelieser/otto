import { describe, expect, it } from "vitest";
import { dispatch, type Methods } from "../../src/interfaces/sidecar/dispatch.js";
import {
  INTERNAL_ERROR,
  INVALID_REQUEST,
  type JsonRpcFailure,
  type JsonRpcSuccess,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
} from "../../src/interfaces/sidecar/protocol.js";

const METHODS: Methods = {
  echo: (params) => params,
  boom: () => {
    throw new Error("handler failed");
  },
};

function request(method: string, params?: unknown, id: string | number | null = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params, id });
}

describe("a request gets its handler's result back", () => {
  it("answers with the result and the request's id", async () => {
    const response = (await dispatch(request("echo", { a: 1 }, 7), METHODS)) as JsonRpcSuccess;
    expect(response).toEqual({ jsonrpc: "2.0", result: { a: 1 }, id: 7 });
  });

  it("preserves a string id", async () => {
    const response = (await dispatch(request("echo", null, "abc"), METHODS)) as JsonRpcSuccess;
    expect(response.id).toBe("abc");
  });
});

describe("failures are answers, not crashes", () => {
  it("reports an unknown method rather than throwing", async () => {
    const response = (await dispatch(request("nope"), METHODS)) as JsonRpcFailure;
    expect(response.error.code).toBe(METHOD_NOT_FOUND);
    expect(response.id).toBe(1);
  });

  it("turns a throwing handler into an error response", async () => {
    const response = (await dispatch(request("boom"), METHODS)) as JsonRpcFailure;
    expect(response.error.code).toBe(INTERNAL_ERROR);
    expect(response.error.message).toBe("handler failed");
  });

  it("reports unparseable input", async () => {
    const response = (await dispatch("{not json", METHODS)) as JsonRpcFailure;
    expect(response.error.code).toBe(PARSE_ERROR);
  });

  it("rejects well-formed JSON that is not a request", async () => {
    const response = (await dispatch(JSON.stringify({ hello: 1 }), METHODS)) as JsonRpcFailure;
    expect(response.error.code).toBe(INVALID_REQUEST);
  });
});

describe("notifications take no response", () => {
  it("answers nothing when a request carries no id", async () => {
    const notification = JSON.stringify({ jsonrpc: "2.0", method: "echo", params: 1 });
    expect(await dispatch(notification, METHODS)).toBeNull();
  });

  it("answers a request whose id is explicitly null", async () => {
    const response = await dispatch(request("echo", 1, null), METHODS);
    expect(response).not.toBeNull();
  });
});
