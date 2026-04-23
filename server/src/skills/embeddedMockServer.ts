/**
 * Embedded mock merchant server (port 5252).
 *
 * Replaces the old `node mockServer.js` child process with an in-process
 * Express listener so the dashboard owns the endpoint that the Android
 * demo app hits at `http://10.0.2.2:5252/create-payment-intent`.
 *
 * Why in-process?
 *  - The paymentIntentBody is a live UI-driven value. Editing it in the
 *    Preview Panel should take effect on the next emulator request without
 *    a process restart or file write.
 *  - Single source of truth for start/stop — no stale child processes on
 *    the shared box.
 *  - Logs stream directly into a ring buffer that the Server tab tails.
 *
 * The vendored `workspace/hyperswitch-client-core/mockServer.js` is
 * untouched; it remains usable for people running the repo standalone. The
 * dashboard just no longer spawns it.
 *
 * Route shapes mirror mockServer.js exactly so MainActivity.kt's hard-coded
 * `$serverUrl/create-payment-intent` keeps working without demo-app edits.
 */

import cors from "cors";
import express, { type Request, type Response } from "express";
import http from "node:http";

const MOCK_SERVER_PORT = Number(process.env.MOCK_SERVER_PORT ?? 5252);
const LOG_CAP = 500;

type Json = Record<string, unknown>;

export interface Credentials {
  publishableKey: string;
  secretKey: string;
  profileId: string;
  netceteraApiKey: string;
  baseUrl: string;
}

interface State {
  app: express.Express | null;
  server: http.Server | null;
  starting: Promise<void> | null;
  paymentIntentBody: Json;
  /** UI-provided overrides. Empty string means "fall back to env". */
  credentials: Credentials;
  logs: string[];
  startedAt: number | null;
}

const state: State = {
  app: null,
  server: null,
  starting: null,
  paymentIntentBody: {},
  credentials: {
    publishableKey: "",
    secretKey: "",
    profileId: "",
    netceteraApiKey: "",
    baseUrl: "",
  },
  logs: [],
  startedAt: null,
};

/**
 * Resolve a credential — UI override wins, then env vars, then empty.
 * All consumers (routes, Cypress runner) go through this so the UI can
 * flip keys at runtime without restarting anything.
 */
function cred(key: keyof Credentials): string {
  const ui = state.credentials[key];
  if (ui) return ui;
  switch (key) {
    case "publishableKey": return process.env.HYPERSWITCH_PUBLISHABLE_KEY ?? "";
    case "secretKey":      return process.env.HYPERSWITCH_SECRET_KEY ?? "";
    case "profileId":      return process.env.PROFILE_ID ?? "";
    case "netceteraApiKey":return process.env.NETCETERA_SDK_API_KEY ?? "";
    case "baseUrl":
      return (
        process.env.HYPERSWITCH_SANDBOX_URL ??
        process.env.HYPERSWITCH_INTEG_URL ??
        "https://sandbox.hyperswitch.io"
      );
  }
}

export function getCredentials(): Credentials {
  return {
    publishableKey: cred("publishableKey"),
    secretKey: cred("secretKey"),
    profileId: cred("profileId"),
    netceteraApiKey: cred("netceteraApiKey"),
    baseUrl: cred("baseUrl"),
  };
}

/** Merge UI overrides into the credentials state. Empty string clears the override. */
export function setCredentials(patch: Partial<Credentials>): Credentials {
  const changed: string[] = [];
  for (const k of Object.keys(patch) as Array<keyof Credentials>) {
    const v = patch[k];
    if (typeof v === "string" && state.credentials[k] !== v) {
      state.credentials[k] = v;
      changed.push(k);
    }
  }
  pushLog(`credentials updated — ${changed.length ? changed.join(", ") : "no changes"}`);
  return getCredentials();
}

export interface MockServerState {
  running: boolean;
  port: number;
  startedAt: number | null;
  paymentIntentBody: Json;
}

export function getMockServerState(): MockServerState {
  return {
    running: state.server !== null && state.server.listening,
    port: MOCK_SERVER_PORT,
    startedAt: state.startedAt,
    paymentIntentBody: state.paymentIntentBody,
  };
}

export function setPaymentIntentBody(body: Json): void {
  state.paymentIntentBody = body;
  pushLog(`config updated — ${Object.keys(body).length} top-level keys`);
}

export function tailMockServerLogs(since = 0): { lines: string[]; total: number } {
  const total = state.logs.length;
  const lines = since >= total ? [] : state.logs.slice(since);
  return { lines, total };
}

function pushLog(line: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  state.logs.push(`[${ts}] ${line}`);
  if (state.logs.length > LOG_CAP) {
    state.logs.splice(0, state.logs.length - LOG_CAP);
  }
}

async function makeHyperswitchRequest(
  endpoint: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: Json }> {
  const secret = cred("secretKey");
  const url = `${cred("baseUrl")}${endpoint}`;
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "api-key": secret,
      ...(options.headers ?? {}),
    },
    body: options.body,
  });
  const data = (await res.json().catch(() => ({}))) as Json;
  return { status: res.status, data };
}

function buildApp(): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "OK",
      timestamp: new Date().toISOString(),
      environment: {
        baseUrl: cred("baseUrl"),
        hasSecretKey: !!cred("secretKey"),
        hasPublishableKey: !!cred("publishableKey"),
      },
    });
  });

  const handleCreatePayment = async (req: Request, res: Response): Promise<void> => {
    const publishable = cred("publishableKey");
    const secret = cred("secretKey");
    if (!publishable || !secret) {
      pushLog(`[create-payment-intent] missing HYPERSWITCH_* credentials`);
      res.status(500).json({
        error: "Missing publishable/secret key — set them in the Preview → Credentials panel",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // GET merges the UI-driven body with defaults. POST lets the caller
    // override further via req.body (matches the old mockServer.js).
    const paymentData: Json = {
      amount: 100,
      currency: "USD",
      ...state.paymentIntentBody,
      ...(req.method === "POST" && req.body ? req.body : {}),
    };

    const profileId = cred("profileId");
    if (profileId) {
      paymentData.profile_id = profileId;
    }

    pushLog(`[create-payment-intent] ${req.method} — forwarding to sandbox`);
    try {
      const { status, data } = await makeHyperswitchRequest("/payments", {
        method: "POST",
        body: JSON.stringify(paymentData),
      });
      if (status < 200 || status >= 300) {
        pushLog(`[create-payment-intent] sandbox returned ${status}`);
        res.status(status).json({
          error: "Failed to create payment intent",
          details: data,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      pushLog(`[create-payment-intent] ok — payment_id=${String(data.payment_id ?? "?")}`);
      res.json({
        publishableKey: publishable,
        clientSecret: data.client_secret,
        profileId: profileId || null,
      });
    } catch (err) {
      pushLog(`[create-payment-intent] error: ${(err as Error).message}`);
      res.status(500).json({
        error: "Failed to create payment intent",
        details: (err as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  };

  app.get("/create-payment-intent", (req, res) => void handleCreatePayment(req, res));
  app.post("/create-payment-intent", (req, res) => void handleCreatePayment(req, res));

  app.post("/create-authentication", async (req, res) => {
    const publishable = cred("publishableKey");
    const secret = cred("secretKey");
    if (!publishable || !secret) {
      res.status(500).json({ error: "Missing publishable/secret key" });
      return;
    }
    const profileId = cred("profileId");
    const authData: Json = {
      amount: 1000,
      currency: "USD",
      customer_details: {
        id: process.env.CTP_CUSTOMER_ID,
        email: process.env.CTP_CUSTOMER_EMAIL,
      },
      authentication_connector: "ctp_visa",
      profile_id: profileId,
      ...(req.body ?? {}),
    };
    pushLog(`[create-authentication] forwarding to sandbox`);
    try {
      const { status, data } = await makeHyperswitchRequest("/authentication", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "x-feature": "router-custom-be",
          "x-profile-id": profileId,
        },
        body: JSON.stringify(authData),
      });
      if (status < 200 || status >= 300) {
        res.status(status).json({ error: "Failed to create authentication", details: data });
        return;
      }
      res.json({
        publishableKey: publishable,
        clientSecret: data.client_secret,
        profileId: data.profile_id,
        authenticationId: data.authentication_id,
        merchantId: data.merchant_id,
      });
    } catch (err) {
      pushLog(`[create-authentication] error: ${(err as Error).message}`);
      res.status(500).json({
        error: "Failed to create authentication",
        details: (err as Error).message,
      });
    }
  });

  app.get("/netcetera-sdk-api-key", (_req, res) => {
    const key = cred("netceteraApiKey");
    if (!key) {
      res.status(500).json({ error: "Not Configured", timestamp: new Date().toISOString() });
      return;
    }
    res.json({ netceteraApiKey: key, timestamp: new Date().toISOString() });
  });

  app.use((req, res) => {
    res.status(404).json({
      error: "Endpoint not found",
      path: req.path,
      method: req.method,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 800 }, (r) => {
      r.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function startMockServer(): Promise<MockServerState> {
  if (state.server && state.server.listening) return getMockServerState();
  if (state.starting) {
    await state.starting;
    return getMockServerState();
  }

  state.starting = (async () => {
    if (await isPortInUse(MOCK_SERVER_PORT)) {
      throw new Error(
        `port ${MOCK_SERVER_PORT} is already in use — stop any hand-started mockServer.js and retry`,
      );
    }
    const app = buildApp();
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(MOCK_SERVER_PORT, "0.0.0.0", () => {
        state.app = app;
        state.server = server;
        state.startedAt = Date.now();
        pushLog(`🚀 mock merchant server listening on 0.0.0.0:${MOCK_SERVER_PORT}`);
        pushLog(`📱 reachable from android emulator at http://10.0.2.2:${MOCK_SERVER_PORT}`);
        resolve();
      });
      server.on("error", (err) => {
        pushLog(`server error: ${err.message}`);
        reject(err);
      });
    });
  })();

  try {
    await state.starting;
  } finally {
    state.starting = null;
  }
  return getMockServerState();
}

export async function stopMockServer(): Promise<MockServerState> {
  if (!state.server) return getMockServerState();
  await new Promise<void>((resolve) => {
    state.server?.close(() => resolve());
    // close() waits for all connections to drain; force-close any sockets
    // the demo app left open so the Stop button is snappy.
    state.server?.closeAllConnections?.();
  });
  pushLog(`mock merchant server stopped`);
  state.server = null;
  state.app = null;
  state.startedAt = null;
  return getMockServerState();
}
