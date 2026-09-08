import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run as runCloud } from "./cloud";

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

let root: string;
let server: Server;
let requests: RecordedRequest[];
let previousXdg: string | undefined;
let previousProfiles: string | undefined;
let previousApiUrl: string | undefined;
let stdout = "";
let stderr = "";
let originalStdout: typeof process.stdout.write;
let originalStderr: typeof process.stderr.write;

function reply(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startApi(): Promise<string> {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk.toString();
    let body: unknown = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    requests.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      authorization: req.headers.authorization,
      body,
    });

    if (req.headers.authorization !== "Bearer good-token") {
      reply(res, 401, { ok: false, error: "invalid token" });
      return;
    }
    if (req.url === "/api/v1/me" && req.method === "GET") {
      reply(res, 200, {
        ok: true,
        data: { id: "user-1", email: "tester@example.com" },
      });
      return;
    }
    if (req.url === "/api/v1/community" && req.method === "POST") {
      const item = body as { name?: string };
      reply(res, 200, {
        ok: true,
        data: {
          handle: "tester",
          name: item.name,
          add: `cue use tester/${item.name}`,
        },
      });
      return;
    }
    reply(res, 404, { ok: false, error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cue-cloud-contract-"));
  requests = [];
  previousXdg = process.env.XDG_CONFIG_HOME;
  previousProfiles = process.env.CUE_PROFILES_DIR;
  previousApiUrl = process.env.CUE_API_URL;
  process.env.XDG_CONFIG_HOME = join(root, "xdg");
  process.env.CUE_PROFILES_DIR = join(root, "profiles");
  process.env.CUE_API_URL = await startApi();

  stdout = "";
  stderr = "";
  originalStdout = process.stdout.write.bind(process.stdout);
  originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  if (previousProfiles === undefined) delete process.env.CUE_PROFILES_DIR;
  else process.env.CUE_PROFILES_DIR = previousProfiles;
  if (previousApiUrl === undefined) delete process.env.CUE_API_URL;
  else process.env.CUE_API_URL = previousApiUrl;
  rmSync(root, { recursive: true, force: true });
});

describe("hosted marketplace API contract through cloud aliases", () => {
  test("login verifies the bearer token and stores it with 0600 permissions", async () => {
    expect(await runCloud(["login", "--token", "good-token"])).toBe(0);

    const file = join(root, "xdg", "cue", "credentials.json");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      apiUrl: process.env.CUE_API_URL,
      token: "good-token",
    });
    expect(requests[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/me",
      authorization: "Bearer good-token",
    });
  });

  test("whoami reuses the saved token against the same API", async () => {
    expect(await runCloud(["login", "--token", "good-token"])).toBe(0);
    stdout = "";
    requests = [];

    expect(await runCloud(["whoami"])).toBe(0);

    expect(stdout).toContain("tester@example.com");
    expect(requests[0]?.authorization).toBe("Bearer good-token");
    expect(requests[0]?.path).toBe("/api/v1/me");
  });

  test("push publishes a local profile using the hosted community contract", async () => {
    expect(await runCloud(["login", "--token", "good-token"])).toBe(0);
    const profileDir = join(root, "profiles", "safe-profile");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "profile.yaml"),
      "name: safe-profile\ndescription: Contract profile\n",
    );
    requests = [];

    const sourceUrl = "https://github.com/tester/profiles/tree/main/safe-profile";
    expect(await runCloud(["push", "safe-profile", "--source-url", sourceUrl, "--tags", "test"])).toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/community",
      authorization: "Bearer good-token",
      body: {
        type: "profile",
        name: "safe-profile",
        description: "Contract profile",
        tags: ["test"],
        sourceUrl,
      },
    });
    expect(stdout).toContain("tester/safe-profile");
  });

  test("a rejected token is never persisted", async () => {
    expect(await runCloud(["login", "--token", "bad-token"])).toBe(1);

    expect(existsSync(join(root, "xdg", "cue", "credentials.json"))).toBe(false);
    expect(stderr).toContain("token rejected");
  });

  test("network failures return a user error instead of throwing", async () => {
    process.env.CUE_API_URL = "http://127.0.0.1:1";

    expect(await runCloud(["login", "--token", "good-token"])).toBe(1);

    expect(stderr).toContain("cannot reach");
    expect(stderr).not.toContain("internal error");
  });
});
