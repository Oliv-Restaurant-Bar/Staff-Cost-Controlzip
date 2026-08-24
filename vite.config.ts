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
