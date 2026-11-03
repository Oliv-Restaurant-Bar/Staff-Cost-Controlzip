import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { componentTagger } from "lovable-tagger";
import { createAuthorizationHandler } from "./server/authorization.js";

function authorizationPlugin(supabaseUrl?: string, publishableKey?: string): Plugin {
  const handleAuthorization = createAuthorizationHandler({ supabaseUrl, publishableKey });
  const middleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: (error?: unknown) => void,
  ) => {
    void handleAuthorization(req, res)
      .then(handled => { if (!handled) next(); })
      .catch(next);
  };
  return {
    name: "server-role-authorization",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    // Replit-Deployments verwenden aktuell `vite preview`; der Schutz muss
    // deshalb dort ebenso vor dem SPA-Fallback installiert sein.
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// DEV ONLY: serves /api/read-invoice from the real Vercel handler so the AI reading can be
// tested locally (`npm run dev` does not run api/*). Variables come from Vite's loadEnv;
// nothing is printed. Not part of the production build.
function localInvoiceApiPlugin(env: Record<string, string>): Plugin {
  return {
    name: "local-read-invoice-api",
    apply: "serve",
    configureServer(server) {
      for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY"]) {
        if (env[k] && !process.env[k]) process.env[k] = env[k];
      }
      server.middlewares.use("/api/read-invoice", (req, res, next) => {
        const chunks: Buffer[] = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            const mod = await server.ssrLoadModule("/api/read-invoice.ts");
            let body: unknown;
            try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = undefined; }
            const shim = {
              status: (code: number) => ({
                json: (payload: unknown) => {
                  res.statusCode = code;
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify(payload));
                },
              }),
            };
            await mod.default({ method: req.method, headers: req.headers, body }, shim);
          })().catch(next);
        });
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
  server: {
    host: "0.0.0.0",
    port: 8080,
    allowedHosts: true,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    authorizationPlugin(
      env.VITE_SUPABASE_URL || env.SUPABASE_URL,
      env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY,
    ),
    localInvoiceApiPlugin(env),
    react(),
    mode === "development" && componentTagger(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  };
});
