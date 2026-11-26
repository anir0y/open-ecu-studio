import {LabSimulation} from "./lab";

type Env = {
  ASSETS: {fetch(request: Request): Promise<Response>};
  LAB_SESSIONS: {idFromName(name: string): unknown; get(id: unknown): {fetch(request: Request): Promise<Response>}};
};

function sessionId(request: Request): string | undefined {
  const url = new URL(request.url);
  const candidate = request.headers.get("X-ECU-Session") ?? url.searchParams.get("session") ?? "";
  return /^[A-Za-z0-9-]{16,128}$/.test(candidate) ? candidate : undefined;
}

function securityHeaders(response: Response): Response {
  const next = new Response(response.body, response);
  next.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  next.headers.set("X-Content-Type-Options", "nosniff");
  next.headers.set("X-Frame-Options", "DENY");
  next.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next.headers.set("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; connect-src 'self' wss:; font-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:");
  return next;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let session = sessionId(request);
    session ??= crypto.randomUUID();
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
      const objectId = env.LAB_SESSIONS.idFromName(session);
      return env.LAB_SESSIONS.get(objectId).fetch(request);
    }
    return securityHeaders(await env.ASSETS.fetch(request));
  },
};

export class LabSession {
  private readonly simulation = new LabSimulation();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return json({detail: "Not found"}, 404);
    try {
      const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
      let payload: unknown;
      switch (url.pathname) {
        case "/api/status": payload = this.simulation.status(); break;
        case "/api/tick": {
          const frames = this.simulation.tick();
          payload = {frames, status: this.simulation.status()};
          break;
        }
        case "/api/run": payload = this.simulation.start(String(body.source ?? "synthetic")); break;
        case "/api/stop": payload = this.simulation.stop(); break;
        case "/api/fault": payload = this.simulation.setFault(Boolean(body.active)); break;
        case "/api/vehicle": payload = this.simulation.setInputs(body); break;
        case "/api/body": payload = this.simulation.bodyAction(String(body.action ?? "")); break;
        case "/api/esc-capture": payload = this.simulation.controlCapture(String(body.action ?? "")); break;
        case "/api/diagnostics": payload = this.simulation.diagnostic(String(body.service ?? "")); break;
        case "/api/trace": payload = this.simulation.traceFrames(); break;
        default: return json({detail: "Not found"}, 404);
      }
      return json(payload);
    } catch (error) {
      return json({detail: error instanceof Error ? error.message : "Request failed"}, 400);
    }
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {status, headers: {"Cache-Control": "no-store"}});
}
