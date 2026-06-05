import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { createServer as createNetServer } from "net";
import { spawn, type ChildProcess } from "child_process";
import { simMiddleware, type ServeSimState } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";
import { STATE_DIR, stateFileForDevice } from "../state";

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
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

describe("helper proxy", () => {
  const udid = "PROXY-TEST-DEVICE";
  const stateFile = stateFileForDevice(udid);
  let helper: ReturnType<typeof Bun.serve> | null = null;
  let preview: PreviewServer | null = null;
  let fakeHelperProcess: ChildProcess | null = null;

  afterEach(() => {
    helper?.stop(true);
    helper = null;
    preview?.stop(true);
    preview = null;
    try { rmSync(stateFile); } catch {}
    if (fakeHelperProcess?.pid) {
      try { fakeHelperProcess.kill("SIGKILL"); } catch {}
    }
    fakeHelperProcess = null;
  });

  test("proxies HTTP, bridges WebSocket frames, and forwards input fallback", async () => {
    const helperPort = await freePort();
    const helperMessageResolvers: Array<(message: Uint8Array) => void> = [];
    const nextHelperMessage = () => new Promise<Uint8Array>((resolve) => {
      helperMessageResolvers.push(resolve);
    });
    helper = Bun.serve({
      hostname: "127.0.0.1",
      port: helperPort,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/ws" && server.upgrade(req)) return undefined;
        if (url.pathname === "/probe") return new Response("proxied");
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          helperMessageResolvers.shift()?.(
            typeof message === "string"
              ? new TextEncoder().encode(message)
              : new Uint8Array(message),
          );
          ws.send(message);
        },
      },
    });

    mkdirSync(STATE_DIR, { recursive: true });
    fakeHelperProcess = spawn("sleep", ["60"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fakeHelperProcess.pid).toBeTruthy();
    expect(fakeHelperProcess.exitCode).toBeNull();
    const state: ServeSimState = {
      pid: fakeHelperProcess.pid!,
      port: helperPort,
      device: udid,
      url: `http://127.0.0.1:${helperPort}`,
      streamUrl: `http://127.0.0.1:${helperPort}/stream.mjpeg`,
      wsUrl: `ws://127.0.0.1:${helperPort}/ws`,
    };
    writeFileSync(stateFile, JSON.stringify(state));

    const previewPort = await freePort();
    preview = await servePreview({
      port: previewPort,
      middleware: simMiddleware({ basePath: "/" }),
      host: "127.0.0.1",
    });

    const probe = await fetch(`http://127.0.0.1:${previewPort}/helper/${encodeURIComponent(udid)}/probe`);
    expect(await probe.text()).toBe("proxied");

    const echoed = await new Promise<Uint8Array>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${previewPort}/helper/${encodeURIComponent(udid)}/ws`);
      let browserOpened = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`timed out waiting for WebSocket echo (browserOpened=${browserOpened})`));
      }, 2_000);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        browserOpened = true;
        ws.send(new Uint8Array([0x03, 0x02, 0x01]));
      };
      ws.onmessage = (event) => {
        clearTimeout(timer);
        ws.close();
        resolve(new Uint8Array(event.data as ArrayBuffer));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("websocket failed"));
      };
    });
    expect([...echoed]).toEqual([0x03, 0x02, 0x01]);

    const seenByHelper = await new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for helper input"));
      }, 2_000);
      nextHelperMessage().then((message) => {
        clearTimeout(timer);
        resolve(message);
      }).catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
      void fetch(`http://127.0.0.1:${previewPort}/helper/${encodeURIComponent(udid)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array([0x04, 0x05, 0x06]),
      }).catch(reject);
    });

    expect([...seenByHelper]).toEqual([0x04, 0x05, 0x06]);
  });
});
