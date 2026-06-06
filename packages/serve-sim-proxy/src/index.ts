#!/usr/bin/env bun
import { createServeSimProxyServer, type ServeSimProxyOptions } from "./proxy-server";

function usage(): never {
  console.log(`Usage: serve-sim-proxy [options]

Options:
  -p, --port <port>              Proxy port (default: 3300)
  --host <addr>                  Proxy bind host (default: 127.0.0.1)
  --preview-port <port>          serve-sim preview port (default: 3200)
  --preview-host <addr>          serve-sim preview host (default: 127.0.0.1)
  -h, --help                     Show this help`);
  process.exit(0);
}

function readNumber(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${flag} must be a port number from 1 to 65535`);
  }
  return parsed;
}

function parseArgs(argv: string[]): ServeSimProxyOptions {
  const options: ServeSimProxyOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") usage();
    if (arg === "-p" || arg === "--port") {
      options.port = readNumber(argv[++i], arg);
      continue;
    }
    if (arg === "--host") {
      options.host = argv[++i];
      continue;
    }
    if (arg === "--preview-port") {
      options.previewPort = readNumber(argv[++i], arg);
      continue;
    }
    if (arg === "--preview-host") {
      options.previewHost = argv[++i];
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const server = await createServeSimProxyServer(options);
  console.log(`serve-sim proxy listening at ${server.url}`);
  console.log(`  preview upstream: http://${options.previewHost ?? "127.0.0.1"}:${options.previewPort ?? 3200}`);
  await new Promise(() => {});
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
