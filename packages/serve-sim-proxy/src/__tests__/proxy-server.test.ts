import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { createServer as createNetServer } from "net";
import { spawn, type ChildProcess } from "child_process";
import { createServeSimProxyServer, proxyPreviewConfigForBrowser, proxyWebKitDevtoolsResponse } from "../proxy-server";
import { STATE_DIR, stateFileForDevice } from "serve-sim/state";

type ServeSimState = {
  pid: number;
  port: number;
  device: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      server.close(() => resolve(addr.port));
    });
  });
}

describe("proxyPreviewConfigForBrowser", () => {
  test("rewrites helper URLs to same-origin helper paths", () => {
    const config = {
      pid: 101,
      port: 3100,
      device: "DEVICE-A",
      url: "http://127.0.0.1:3100",
      streamUrl: "http://127.0.0.1:3100/stream.mjpeg",
      wsUrl: "ws://127.0.0.1:3100/ws",
      basePath: "",
    };

    expect(proxyPreviewConfigForBrowser(config, { protocol: "http:", host: "127.0.0.1:3300" })).toEqual({
      ...config,
      url: "http://127.0.0.1:3300/helper/DEVICE-A",
      streamUrl: "http://127.0.0.1:3300/helper/DEVICE-A/stream.mjpeg",
      wsUrl: "ws://127.0.0.1:3300/helper/DEVICE-A/ws",
    });
  });

  test("preserves middleware base paths and uses secure WebSockets on https", () => {
    const config = {
      pid: 101,
      port: 3100,
      device: "DEVICE A",
      url: "http://127.0.0.1:3100",
      streamUrl: "http://127.0.0.1:3100/stream.mjpeg",
      wsUrl: "ws://127.0.0.1:3100/ws",
      basePath: "/.sim",
    };

    expect(proxyPreviewConfigForBrowser(config, { protocol: "https:", host: "preview.example.test" })).toEqual({
      ...config,
      url: "https://preview.example.test/.sim/helper/DEVICE%20A",
      streamUrl: "https://preview.example.test/.sim/helper/DEVICE%20A/stream.mjpeg",
      wsUrl: "wss://preview.example.test/.sim/helper/DEVICE%20A/ws",
    });
  });
});

describe("proxyWebKitDevtoolsResponse", () => {
  test("rewrites targets to same-origin DevTools WebSocket paths", () => {
    const response = proxyWebKitDevtoolsResponse({
      port: 9222,
      targets: [{
        id: "sim:page:1",
        title: "Example",
        url: "https://example.test",
        type: "page",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/sim%3Apage%3A1",
        devtoolsFrontendUrl: "/.sim/devtools-frontend/inspector.html?ws=127.0.0.1%3A9222%2Fdevtools%2Fpage%2Fsim%253Apage%253A1",
      }],
    }, { protocol: "https:", host: "preview.example.test" }, "/.sim");

    expect(response.targets[0]!.webSocketDebuggerUrl).toBe("wss://preview.example.test/.sim/devtools/page/sim%3Apage%3A1");
    const frontend = new URL(response.targets[0]!.devtoolsFrontendUrl, "https://preview.example.test");
    expect(frontend.pathname).toBe("/.sim/devtools-frontend/inspector.html");
    expect(frontend.searchParams.get("wss")).toBe("preview.example.test/.sim/devtools/page/sim%3Apage%3A1");
    expect(frontend.searchParams.has("ws")).toBe(false);
  });

  test("uses 127.0.0.1 for loopback DevTools WebSockets to satisfy frontend CSP", () => {
    const response = proxyWebKitDevtoolsResponse({
      port: 9222,
      targets: [{
        id: "sim:page:1",
        title: "Example",
        url: "https://example.test",
        type: "page",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/sim%3Apage%3A1",
        devtoolsFrontendUrl: "/devtools-frontend/inspector.html?ws=127.0.0.1%3A9222%2Fdevtools%2Fpage%2Fsim%253Apage%253A1",
      }],
    }, { protocol: "http:", host: "localhost:3300" }, "");

    expect(response.targets[0]!.webSocketDebuggerUrl).toBe("ws://127.0.0.1:3300/devtools/page/sim%3Apage%3A1");
    const frontend = new URL(response.targets[0]!.devtoolsFrontendUrl, "http://localhost:3300");
    expect(frontend.searchParams.get("ws")).toBe("127.0.0.1:3300/devtools/page/sim%3Apage%3A1");
  });
});

describe("createServeSimProxyServer", () => {
  const udid = "PROXY-DEVICE-A";
  const stateFile = stateFileForDevice(udid);
  let preview: ReturnType<typeof Bun.serve> | null = null;
  let helper: ReturnType<typeof Bun.serve> | null = null;
  let proxy: Awaited<ReturnType<typeof createServeSimProxyServer>> | null = null;
  let fakeHelperProcess: ChildProcess | null = null;

  afterEach(() => {
    proxy?.stop(true);
    proxy = null;
    preview?.stop(true);
    preview = null;
    helper?.stop(true);
    helper = null;
    try { rmSync(stateFile); } catch {}
    if (fakeHelperProcess?.pid) {
      try { fakeHelperProcess.kill("SIGKILL"); } catch {}
    }
    fakeHelperProcess = null;
  });

  test("rewrites preview config JSON, SSE, and grid helper URLs", async () => {
    const helperPort = await freePort();
    fakeHelperProcess = spawn("sleep", ["60"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const state: ServeSimState = {
      pid: fakeHelperProcess.pid!,
      port: helperPort,
      device: udid,
      url: `http://127.0.0.1:${helperPort}`,
      streamUrl: `http://127.0.0.1:${helperPort}/stream.mjpeg`,
      wsUrl: `ws://127.0.0.1:${helperPort}/ws`,
    };
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state));

    const previewPort = await freePort();
    preview = Bun.serve({
      hostname: "127.0.0.1",
      port: previewPort,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api") return Response.json({ ...state, basePath: "" });
        if (url.pathname === "/grid/api") {
          return Response.json({ devices: [{ device: udid, helper: state }] });
        }
        if (url.pathname === "/.sim/grid/api") {
          return Response.json({ devices: [{ device: udid, helper: state }] });
        }
        if (url.pathname === "/api/events") {
          return new Response(`data: ${JSON.stringify({ ...state, basePath: "" })}\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return new Response("preview");
      },
    });

    const proxyPort = await freePort();
    proxy = await createServeSimProxyServer({ port: proxyPort, previewPort });

    const config = await fetch(`http://127.0.0.1:${proxyPort}/api`).then((res) => res.json());
    expect(config.streamUrl).toBe(`http://127.0.0.1:${proxyPort}/helper/${udid}/stream.mjpeg`);
    expect(config.wsUrl).toBe(`ws://127.0.0.1:${proxyPort}/helper/${udid}/ws`);

    const grid = await fetch(`http://127.0.0.1:${proxyPort}/grid/api`).then((res) => res.json());
    expect(grid.devices[0].helper.streamUrl).toBe(`http://127.0.0.1:${proxyPort}/helper/${udid}/stream.mjpeg`);

    const mountedGrid = await fetch(`http://127.0.0.1:${proxyPort}/.sim/grid/api`).then((res) => res.json());
    expect(mountedGrid.devices[0].helper.streamUrl).toBe(`http://127.0.0.1:${proxyPort}/.sim/helper/${udid}/stream.mjpeg`);

    const events = await fetch(`http://127.0.0.1:${proxyPort}/api/events`).then((res) => res.text());
    expect(events).toContain(`data: {"pid":${state.pid}`);
    expect(events).toContain(`http://127.0.0.1:${proxyPort}/helper/${udid}/stream.mjpeg`);
  });

  test("keeps /exec same-origin at the proxy surface", async () => {
    const previewPort = await freePort();
    preview = Bun.serve({
      hostname: "127.0.0.1",
      port: previewPort,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/exec") return new Response("preview");
        const origin = req.headers.get("origin");
        const host = req.headers.get("host");
        if (origin && new URL(origin).host !== host) {
          return Response.json({ stdout: "", stderr: "Cross-origin request blocked", exitCode: 1 }, { status: 403 });
        }
        return Response.json({ stdout: await req.text(), stderr: "", exitCode: 0 });
      },
    });

    const proxyPort = await freePort();
    proxy = await createServeSimProxyServer({ port: proxyPort, previewPort });
    const origin = `http://127.0.0.1:${proxyPort}`;
    const res = await fetch(`${origin}/exec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({ command: "echo hi" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.exitCode).toBe(0);
  });

  test("proxies helper HTTP and bridges helper WebSocket traffic", async () => {
    const helperPort = await freePort();
    helper = Bun.serve<unknown>({
      hostname: "127.0.0.1",
      port: helperPort,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/ws" && server.upgrade(req, { data: null })) return undefined;
        if (url.pathname === "/probe") return new Response("helper-ok");
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          ws.send(message);
        },
      },
    });

    fakeHelperProcess = spawn("sleep", ["60"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      pid: fakeHelperProcess.pid!,
      port: helperPort,
      device: udid,
      url: `http://127.0.0.1:${helperPort}`,
      streamUrl: `http://127.0.0.1:${helperPort}/stream.mjpeg`,
      wsUrl: `ws://127.0.0.1:${helperPort}/ws`,
    } satisfies ServeSimState));

    const previewPort = await freePort();
    preview = Bun.serve({
      hostname: "127.0.0.1",
      port: previewPort,
      fetch: () => new Response("preview"),
    });

    const proxyPort = await freePort();
    proxy = await createServeSimProxyServer({ port: proxyPort, previewPort });

    const probe = await fetch(`http://127.0.0.1:${proxyPort}/helper/${udid}/probe`);
    expect(await probe.text()).toBe("helper-ok");

    const echoed = await new Promise<Uint8Array>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/helper/${udid}/ws`);
      const timer = setTimeout(() => reject(new Error("timed out waiting for helper echo")), 2_000);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => ws.send(new Uint8Array([1, 2, 3]));
      ws.onmessage = (event) => {
        clearTimeout(timer);
        ws.close();
        resolve(new Uint8Array(event.data as ArrayBuffer));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("helper websocket failed"));
      };
    });
    expect([...echoed]).toEqual([1, 2, 3]);
  });

  test("rewrites DevTools JSON and bridges CDP WebSocket traffic", async () => {
    const cdpPort = await freePort();
    const targetId = "sim:page:1";
    const cdp = Bun.serve<unknown>({
      hostname: "127.0.0.1",
      port: cdpPort,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/json/version") return Response.json({ Browser: "Safari/inspect-webkit" });
        if (url.pathname.startsWith("/devtools/page/") && server.upgrade(req, { data: null })) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          ws.send(`cdp:${message}`);
        },
      },
    });

    const previewPort = await freePort();
    preview = Bun.serve({
      hostname: "127.0.0.1",
      port: previewPort,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/devtools") {
          return Response.json({
            port: cdpPort,
            targets: [{
              id: targetId,
              title: "Example",
              url: "https://example.test",
              type: "page",
              webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/${encodeURIComponent(targetId)}`,
              devtoolsFrontendUrl: `/devtools-frontend/inspector.html?ws=127.0.0.1%3A${cdpPort}%2Fdevtools%2Fpage%2F${encodeURIComponent(encodeURIComponent(targetId))}`,
            }],
          });
        }
        return new Response("preview");
      },
    });

    const proxyPort = await freePort();
    proxy = await createServeSimProxyServer({ port: proxyPort, previewPort });

    const json = await fetch(`http://127.0.0.1:${proxyPort}/devtools`).then((res) => res.json());
    expect(json.targets[0].webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${proxyPort}/devtools/page/${encodeURIComponent(targetId)}`);

    const echoed = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/devtools/page/${encodeURIComponent(targetId)}`);
      const timer = setTimeout(() => reject(new Error("timed out waiting for CDP echo")), 2_000);
      ws.onopen = () => ws.send("hello");
      ws.onmessage = (event) => {
        clearTimeout(timer);
        ws.close();
        resolve(String(event.data));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("devtools websocket failed"));
      };
    });
    expect(echoed).toBe("cdp:hello");
    cdp.stop(true);
  });
});
