import { readFileSync } from "fs";
import { listStateFiles } from "serve-sim/state";

type LocationLike = Pick<Location, "host" | "protocol">;

export type ServeSimState = {
  pid: number;
  port: number;
  device: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
};

export type PreviewConfig = ServeSimState & {
  basePath?: string;
  [key: string]: unknown;
};

export type WebKitDevtoolsTarget = {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl: string;
  [key: string]: unknown;
};

export type WebKitDevtoolsResponse = {
  port?: number;
  targets?: WebKitDevtoolsTarget[];
  error?: string;
  [key: string]: unknown;
};

export type ServeSimProxyOptions = {
  port?: number;
  host?: string;
  previewPort?: number;
  previewHost?: string;
};

export type ServeSimProxyServer = {
  url: string;
  stop(force?: boolean): void;
};

type HelperProxyTarget = {
  device: string | null;
  upstreamPath: string;
};

type WebSocketData = {
  upstreamUrl: string;
  upstream?: WebSocket;
  pending?: WebSocketPayload[];
};

type WebSocketPayload = string | ArrayBuffer;

const DEFAULT_PROXY_PORT = 3300;
const DEFAULT_PREVIEW_PORT = 3200;
const DEFAULT_HOST = "127.0.0.1";
const INSPECT_WEBKIT_START_PORT = 9222;
const INSPECT_WEBKIT_SCAN_COUNT = 100;

function normalizedBasePath(basePath: unknown): string {
  if (typeof basePath !== "string" || basePath === "/") return "";
  return basePath.replace(/\/+$/, "");
}

function responseLocation(req: Request): LocationLike {
  const url = new URL(req.url);
  const forwardedProto = req.headers.get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  const protocol = forwardedProto === "https" ? "https:" : url.protocol;
  return { protocol, host: req.headers.get("host") ?? url.host };
}

function helperPath(basePath: unknown, device: string): string {
  const base = normalizedBasePath(basePath);
  return `${base}/helper/${encodeURIComponent(device)}`;
}

function hostnameFromHost(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host.split(":")[0] ?? host;
  }
}

function portFromHost(host: string): string {
  try {
    return new URL(`http://${host}`).port;
  } catch {
    const match = /:(\d+)$/.exec(host);
    return match?.[1] ?? "";
  }
}

function devtoolsWebSocketLocation(location: LocationLike): { protocol: "ws:" | "wss:"; host: string; paramName: "ws" | "wss" } {
  const hostname = hostnameFromHost(location.host);
  const port = portFromHost(location.host);
  if (
    location.protocol === "http:"
    && port
    && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1")
  ) {
    return { protocol: "ws:", host: `127.0.0.1:${port}`, paramName: "ws" };
  }
  return location.protocol === "https:"
    ? { protocol: "wss:", host: location.host, paramName: "wss" }
    : { protocol: "ws:", host: location.host, paramName: "ws" };
}

export function proxyPreviewConfigForBrowser<T extends PreviewConfig | null | undefined>(
  config: T,
  location: LocationLike,
): T {
  if (!config?.device) return config;
  const httpOrigin = `${location.protocol}//${location.host}`;
  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  const path = helperPath(config.basePath, config.device);
  return {
    ...config,
    url: `${httpOrigin}${path}`,
    streamUrl: `${httpOrigin}${path}/stream.mjpeg`,
    wsUrl: `${wsProtocol}//${location.host}${path}/ws`,
  };
}

function proxyHelperStateForBrowser(value: unknown, location: LocationLike, basePath: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const state = value as Partial<ServeSimState>;
  if (typeof state.device !== "string") return value;
  const config = {
    ...state,
    basePath,
  } as PreviewConfig;
  const proxied = proxyPreviewConfigForBrowser(config, location);
  const { basePath: _basePath, ...helper } = proxied;
  return helper;
}

function proxyGridResponseForBrowser(json: unknown, location: LocationLike, basePath: unknown): unknown {
  if (!json || typeof json !== "object") return json;
  const record = json as { devices?: Array<{ helper?: unknown }> };
  if (!Array.isArray(record.devices)) return json;
  return {
    ...record,
    devices: record.devices.map((device) => ({
      ...device,
      helper: device.helper ? proxyHelperStateForBrowser(device.helper, location, basePath) : device.helper,
    })),
  };
}

export function proxyWebKitDevtoolsResponse<T extends WebKitDevtoolsResponse>(
  response: T,
  location: LocationLike,
  basePath: unknown = "",
): T {
  if (!Array.isArray(response.targets)) return response;
  const base = normalizedBasePath(basePath);
  const wsLocation = devtoolsWebSocketLocation(location);

  return {
    ...response,
    targets: response.targets.map((target) => {
      let path = `${base}/devtools/page/${encodeURIComponent(target.id)}`;
      try {
        const debuggerUrl = new URL(target.webSocketDebuggerUrl);
        const upstreamPath = debuggerUrl.pathname;
        const pageIndex = upstreamPath.indexOf("/devtools/page/");
        if (pageIndex !== -1) {
          path = `${base}${upstreamPath.slice(pageIndex)}${debuggerUrl.search}`;
        }
      } catch {}

      let devtoolsFrontendUrl = target.devtoolsFrontendUrl;
      try {
        const frontend = new URL(target.devtoolsFrontendUrl, `${location.protocol}//${location.host}`);
        frontend.searchParams.delete("ws");
        frontend.searchParams.delete("wss");
        frontend.searchParams.set(wsLocation.paramName, `${wsLocation.host}${path}`);
        devtoolsFrontendUrl = `${frontend.pathname}${frontend.search}${frontend.hash}`;
      } catch {}

      return {
        ...target,
        webSocketDebuggerUrl: `${wsLocation.protocol}//${wsLocation.host}${path}`,
        devtoolsFrontendUrl,
      };
    }),
  };
}

function previewUpstreamUrl(req: Request, previewHost: string, previewPort: number): URL {
  const url = new URL(req.url);
  url.protocol = "http:";
  url.hostname = previewHost;
  url.port = String(previewPort);
  return url;
}

function forwardedHeaders(req: Request, host: string): Headers {
  const headers = new Headers(req.headers);
  headers.set("host", host);
  return headers;
}

function previewHeaders(req: Request): Headers {
  const headers = new Headers(req.headers);
  headers.set("host", responseLocation(req).host);
  return headers;
}

function requestBody(req: Request): BodyInit | undefined {
  return req.method === "GET" || req.method === "HEAD" ? undefined : req.body ?? undefined;
}

function copyHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete("content-length");
  return next;
}

function basePathFromProxyPath(pathname: string, marker: "helper" | "devtools"): string {
  const segments = pathname.split("/").filter(Boolean);
  const index = segments.indexOf(marker);
  if (index <= 0) return "";
  return `/${segments.slice(0, index).join("/")}`;
}

function basePathFromEndpointPath(pathname: string): string {
  const patterns = ["/api/events", "/grid/api", "/devtools", "/api"];
  for (const pattern of patterns) {
    if (pathname === pattern) return "";
    if (pathname.endsWith(pattern)) {
      return pathname.slice(0, -pattern.length) || "";
    }
  }
  return "";
}

function matchHelperTarget(req: Request): HelperProxyTarget | null {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const helperIndex = segments.indexOf("helper");
  if (helperIndex === -1) return null;

  const deviceSegment = segments[helperIndex + 1];
  const device = deviceSegment ? decodeURIComponent(deviceSegment) : url.searchParams.get("device");
  const upstreamSegments = deviceSegment ? segments.slice(helperIndex + 2) : segments.slice(helperIndex + 1);
  const upstreamPath = `/${upstreamSegments.join("/")}`.replace(/\/$/, "") || "/";
  url.searchParams.delete("device");
  return {
    device,
    upstreamPath: `${upstreamPath}${url.search}`,
  };
}

function matchDevtoolsPage(req: Request): { upstreamPath: string } | null {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const devtoolsIndex = segments.indexOf("devtools");
  if (devtoolsIndex === -1 || segments[devtoolsIndex + 1] !== "page") return null;
  const pageSegments = segments.slice(devtoolsIndex + 2);
  if (pageSegments.length === 0) return null;
  return {
    upstreamPath: `/devtools/page/${pageSegments.join("/")}${url.search}`,
  };
}

function readServeSimStates(): ServeSimState[] {
  const states: ServeSimState[] = [];
  for (const file of listStateFiles()) {
    try {
      const state = JSON.parse(readFileSync(file, "utf8")) as ServeSimState;
      if (!state || typeof state.device !== "string" || typeof state.port !== "number") continue;
      try {
        process.kill(state.pid, 0);
      } catch {
        continue;
      }
      states.push(state);
    } catch {}
  }
  return states;
}

function selectServeSimState(device: string | null): ServeSimState | null {
  const states = readServeSimStates();
  if (device) return states.find((state) => state.device === device) ?? null;
  return states[0] ?? null;
}

async function proxyHelperHttp(req: Request, target: HelperProxyTarget): Promise<Response> {
  const state = selectServeSimState(target.device);
  if (!state) return new Response("No serve-sim device", { status: 404 });
  const upstream = new URL(target.upstreamPath, `http://127.0.0.1:${state.port}`);
  return fetch(upstream, {
    method: req.method,
    headers: forwardedHeaders(req, `127.0.0.1:${state.port}`),
    body: requestBody(req),
    signal: req.signal,
  });
}

async function findInspectWebKitPort(): Promise<number | null> {
  for (let port = INSPECT_WEBKIT_START_PORT; port < INSPECT_WEBKIT_START_PORT + INSPECT_WEBKIT_SCAN_COUNT; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(200) });
      if (!res.ok) continue;
      const json = await res.json() as { Browser?: string };
      if (json.Browser === "Safari/inspect-webkit") return port;
    } catch {}
  }
  return null;
}

function rewritePreviewHtml(html: string, location: LocationLike): string {
  return html.replace(
    /(<script>window\.__SIM_PREVIEW__=)(.*?)(<\/script>)/s,
    (_match, prefix: string, rawJson: string, suffix: string) => {
      try {
        const config = JSON.parse(rawJson) as PreviewConfig | null;
        return `${prefix}${JSON.stringify(proxyPreviewConfigForBrowser(config, location))}${suffix}`;
      } catch {
        return `${prefix}${rawJson}${suffix}`;
      }
    },
  );
}

function rewriteEventStream(text: string, location: LocationLike): string {
  return text.replace(/^data: (.*)$/gm, (line, rawJson: string) => {
    try {
      const config = JSON.parse(rawJson) as PreviewConfig | null;
      return `data: ${JSON.stringify(proxyPreviewConfigForBrowser(config, location))}`;
    } catch {
      return line;
    }
  });
}

function rewriteEventStreamBody(body: ReadableStream<Uint8Array> | null, location: LocationLike): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline !== -1) {
          const line = buffered.slice(0, newline + 1);
          buffered = buffered.slice(newline + 1);
          controller.enqueue(encoder.encode(rewriteEventStream(line, location)));
          return;
        }

        const { value, done } = await reader.read();
        if (done) {
          if (buffered) {
            controller.enqueue(encoder.encode(rewriteEventStream(buffered, location)));
            buffered = "";
          }
          controller.close();
          return;
        }
        buffered += decoder.decode(value, { stream: true });
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function rewritePreviewResponse(req: Request, res: Response, location: LocationLike, setDevtoolsPort: (port: number) => void): Promise<Response> {
  const contentType = res.headers.get("content-type") ?? "";
  const pathname = new URL(req.url).pathname;
  const basePath = basePathFromEndpointPath(pathname)
    || basePathFromProxyPath(pathname, "devtools")
    || basePathFromProxyPath(pathname, "helper");
  const headers = copyHeaders(res.headers);

  if (contentType.includes("text/html")) {
    return new Response(rewritePreviewHtml(await res.text(), location), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  if (contentType.includes("text/event-stream")) {
    return new Response(rewriteEventStreamBody(res.body, location), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  if (!contentType.includes("application/json")) return res;

  const json = await res.json();
  let next = json;
  if (/\/api$/.test(pathname) && !/\/grid\/api$/.test(pathname)) {
    next = proxyPreviewConfigForBrowser(json as PreviewConfig | null, location);
  } else if (/\/grid\/api$/.test(pathname)) {
    next = proxyGridResponseForBrowser(json, location, basePath);
  } else if (/\/devtools$/.test(pathname)) {
    const devtools = proxyWebKitDevtoolsResponse(json as WebKitDevtoolsResponse, location, basePath);
    if (typeof devtools.port === "number") setDevtoolsPort(devtools.port);
    next = devtools;
  }

  return new Response(JSON.stringify(next), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

async function proxyPreviewHttp(
  req: Request,
  previewHost: string,
  previewPort: number,
  setDevtoolsPort: (port: number) => void,
): Promise<Response> {
  const upstream = previewUpstreamUrl(req, previewHost, previewPort);
  const upstreamRes = await fetch(upstream, {
    method: req.method,
    headers: previewHeaders(req),
    body: requestBody(req),
    signal: req.signal,
  });
  return rewritePreviewResponse(req, upstreamRes, responseLocation(req), setDevtoolsPort);
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const view = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return view as ArrayBuffer;
}

function createWebSocketBridge(ws: Bun.ServerWebSocket<WebSocketData>): void {
  const upstream = new WebSocket(ws.data.upstreamUrl);
  const pending: WebSocketPayload[] = [];

  upstream.binaryType = "arraybuffer";
  upstream.onopen = () => {
    for (const message of pending) upstream.send(message);
    pending.length = 0;
  };
  upstream.onmessage = (event) => {
    if (typeof event.data === "string") {
      ws.send(event.data);
    } else {
      ws.send(event.data as ArrayBuffer);
    }
  };
  upstream.onerror = () => ws.close();
  upstream.onclose = () => ws.close();

  ws.data.upstream = upstream;
  ws.data.pending = pending;
}

function sendToUpstream(ws: Bun.ServerWebSocket<WebSocketData>, message: string | Buffer): void {
  const payload = typeof message === "string" ? message : bufferToArrayBuffer(message);
  if (ws.data.upstream?.readyState === WebSocket.OPEN) {
    ws.data.upstream.send(payload);
    return;
  }
  ws.data.pending?.push(payload);
}

async function websocketUpstreamUrl(
  req: Request,
  helperTarget: HelperProxyTarget | null,
  devtoolsTarget: { upstreamPath: string } | null,
  previewHost: string,
  previewPort: number,
  devtoolsPort: number | null,
): Promise<string | null> {
  if (helperTarget) {
    const state = selectServeSimState(helperTarget.device);
    if (!state) return null;
    return `ws://127.0.0.1:${state.port}${helperTarget.upstreamPath}`;
  }
  if (devtoolsTarget) {
    const port = devtoolsPort ?? await findInspectWebKitPort();
    if (!port) return null;
    return `ws://127.0.0.1:${port}${devtoolsTarget.upstreamPath}`;
  }
  const url = previewUpstreamUrl(req, previewHost, previewPort);
  url.protocol = "ws:";
  return url.toString();
}

export async function createServeSimProxyServer(options: ServeSimProxyOptions = {}): Promise<ServeSimProxyServer> {
  const port = options.port ?? DEFAULT_PROXY_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const previewPort = options.previewPort ?? DEFAULT_PREVIEW_PORT;
  const previewHost = options.previewHost ?? DEFAULT_HOST;
  let devtoolsPort: number | null = null;

  const server = Bun.serve<WebSocketData>({
    hostname: host,
    port,
    idleTimeout: 255,
    async fetch(req, server) {
      const helperTarget = matchHelperTarget(req);
      const devtoolsTarget = matchDevtoolsPage(req);

      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upstreamUrl = await websocketUpstreamUrl(
          req,
          helperTarget,
          devtoolsTarget,
          previewHost,
          previewPort,
          devtoolsPort,
        );
        if (!upstreamUrl) return new Response("No upstream WebSocket", { status: 502 });
        if (server.upgrade(req, { data: { upstreamUrl } })) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (helperTarget) return proxyHelperHttp(req, helperTarget);
      return proxyPreviewHttp(req, previewHost, previewPort, (port) => {
        devtoolsPort = port;
      });
    },
    websocket: {
      open(ws) {
        createWebSocketBridge(ws);
      },
      message(ws, message) {
        sendToUpstream(ws, message);
      },
      close(ws) {
        ws.data.upstream?.close();
      },
    },
  });

  return {
    url: `http://${host}:${server.port}`,
    stop(force?: boolean) {
      server.stop(force);
    },
  };
}
