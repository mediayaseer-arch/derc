import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./static";
import { registerRoutes as registerDiriyahRoutes } from "../routes";

const app = express();
const server = createServer(app);

let routesRegistered = false;

export function registerRoutes() {
  if (routesRegistered) return;
  routesRegistered = true;

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  registerDiriyahRoutes(server, app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  if (process.env.NODE_ENV !== "development") {
    serveStatic(app);
  }
}

// Lazy registration middleware so routes are guaranteed to be registered
// inside the request handler lifecycle.
const lazyRouter = express();
lazyRouter.use((req, res, next) => {
  if (!routesRegistered) {
    registerRoutes();
  }
  return app(req, res, next);
});

export default {
  async fetch(req: any, env?: Record<string, string>, _ctx?: any) {
    if (env && typeof env === "object") {
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === "string" && !process.env[k]) {
          process.env[k] = v;
        }
      }
    }
    if (!routesRegistered) {
      registerRoutes();
    }
    return new Promise<Response>((resolve, reject) => {
      try {
        const url = new URL(req.url || "http://localhost/");
        const headers: Record<string, string> = {};
        if (req.headers && typeof req.headers.forEach === "function") {
          req.headers.forEach((val: string, key: string) => {
            headers[key.toLowerCase()] = val;
          });
        }
        const chunks: Uint8Array[] = [];
        let statusCode = 200;
        const resHeaders = new Headers();

        const mockReq: any = {
          method: req.method || "GET",
          url: url.pathname + url.search,
          originalUrl: url.pathname + url.search,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          headers,
          get: (name: string) => headers[name.toLowerCase()],
          protocol: url.protocol.replace(":", "") || "https",
          on: () => mockReq,
          once: () => mockReq,
          emit: () => false,
        };

        const mockRes: any = {
          statusCode: 200,
          headersSent: false,
          status(code: number) {
            statusCode = code;
            this.statusCode = code;
            return this;
          },
          setHeader(name: string, value: string | string[]) {
            if (Array.isArray(value)) {
              resHeaders.delete(name);
              value.forEach((v) => resHeaders.append(name, v));
            } else {
              resHeaders.set(name, String(value));
            }
            return this;
          },
          getHeader(name: string) {
            return resHeaders.get(name) ?? undefined;
          },
          append(name: string, value: string | string[]) {
            if (Array.isArray(value)) {
              value.forEach((v) => resHeaders.append(name, v));
            } else {
              resHeaders.append(name, String(value));
            }
            return this;
          },
          type(contentType: string) {
            resHeaders.set("Content-Type", contentType);
            return this;
          },
          json(data: unknown) {
            if (!resHeaders.has("Content-Type")) {
              resHeaders.set("Content-Type", "application/json; charset=utf-8");
            }
            this.headersSent = true;
            resolve(
              new Response(JSON.stringify(data), {
                status: statusCode,
                headers: resHeaders,
              })
            );
            return this;
          },
          send(body?: any) {
            this.headersSent = true;
            resolve(
              new Response(
                typeof body === "object" && body !== null && !(body instanceof Uint8Array)
                  ? JSON.stringify(body)
                  : body ?? "",
                {
                  status: statusCode,
                  headers: resHeaders,
                }
              )
            );
            return this;
          },
          end(chunk?: any) {
            if (chunk) {
              chunks.push(
                typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
              );
            }
            this.headersSent = true;
            const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
              merged.set(c, offset);
              offset += c.byteLength;
            }
            resolve(
              new Response(merged, {
                status: statusCode,
                headers: resHeaders,
              })
            );
            return this;
          },
          write(chunk: any) {
            chunks.push(
              typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
            );
            return true;
          },
          flushHeaders() {},
        };

        (async () => {
          if (
            req.body &&
            req.method !== "GET" &&
            req.method !== "HEAD" &&
            typeof req.text === "function"
          ) {
            const rawText = await req.text().catch(() => "");
            if (rawText) {
              try {
                mockReq.body = JSON.parse(rawText);
              } catch {
                mockReq.body = rawText;
              }
            }
          }
          app(mockReq, mockRes, (err?: any) => {
            if (err) reject(err);
            else if (!mockRes.headersSent) {
              resolve(new Response("Not Found", { status: 404 }));
            }
          });
        })().catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  },
};

async function startServer() {
  registerRoutes();
  if (process.env.NODE_ENV === "development") {
    const viteModulePath = "./vite";
    const { setupVite } = await import(viteModulePath);
    await setupVite(app, server);
  }

  const port = Number.parseInt(process.env.PORT || "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }

  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
  });
}

if (typeof process !== "undefined" && process.release?.name === "node") {
  startServer().catch(console.error);
}
