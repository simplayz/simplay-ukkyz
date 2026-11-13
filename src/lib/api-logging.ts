import { randomUUID } from "node:crypto";

type ApiHandlerArgs = [Request, ...unknown[]];
const requestIds = new WeakMap<Request, string>();

export function withApiLogging<Args extends ApiHandlerArgs>(
  route: string,
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const [request] = args;
    const requestId = randomUUID();
    requestIds.set(request, requestId);
    const url = new URL(request.url);
    const startedAt = Date.now();
    const context = {
      requestId,
      route,
      method: request.method,
      path: url.pathname,
      queryKeys: [...new Set(url.searchParams.keys())],
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
    };

    try {
      const response = await handler(...args);
      const durationMs = Date.now() - startedAt;
      const log = response.status >= 500 ? console.error : console.info;
      log("[api]", JSON.stringify({ ...context, status: response.status, durationMs }));
      const headers = new Headers(response.headers);
      headers.set("x-request-id", requestId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      console.error(
        "[api] unhandled route error",
        JSON.stringify({ ...context, durationMs: Date.now() - startedAt, error: errorDetails(error) }),
      );
      throw error;
    }
  };
}

export function logApiError(route: string, request: Request, error: unknown) {
  const url = new URL(request.url);
  console.error(
    "[api] handled route error",
    JSON.stringify({
      route,
      requestId: requestIds.get(request),
      method: request.method,
      path: url.pathname,
      error: errorDetails(error),
    }),
  );
}

export function logApiWarning(route: string, request: Request, operation: string, error: unknown) {
  const url = new URL(request.url);
  console.warn(
    "[api] degraded operation",
    JSON.stringify({
      route,
      requestId: requestIds.get(request),
      method: request.method,
      path: url.pathname,
      operation,
      error: errorDetails(error),
    }),
  );
}

export async function readApiJson<T>(request: Request, route: string, fallback: T): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch (error) {
    logApiWarning(route, request, "parse JSON request body; using fallback", error);
    return fallback;
  }
}

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}
