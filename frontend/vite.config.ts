import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import * as path from "path";
import { defineConfig, loadEnv, type PluginOption } from "vite";
import svgr from "vite-plugin-svgr";

const DEFAULT_FAVICON_HREF =
  "/src/assets/aztec-scan-brandkit/AS logo purple.svg";
const LOCAL_GREEN_FAVICON_HREF =
  "/src/assets/aztec-scan-brandkit/AS logo local green.svg";

const isEnabled = (value: string | undefined): boolean =>
  value === "true" || value === "1" || value === "yes" || value === "on";

const localGreenFaviconPlugin = (enabled: boolean): PluginOption => ({
  name: "chicmoz-local-green-favicon",
  transformIndexHtml(html) {
    if (!enabled) {
      return html;
    }

    return html.replace(DEFAULT_FAVICON_HREF, LOCAL_GREEN_FAVICON_HREF);
  },
});

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const useLocalGreenFavicon =
    command === "serve" && isEnabled(env.VITE_LOCAL_GREEN_FAVICON);

  return {
    plugins: [
      react(),
      svgr(),
      localGreenFaviconPlugin(useLocalGreenFavicon),
      TanStackRouterVite(),
    ],
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: [
        { find: "~", replacement: path.resolve(__dirname, "src") },
        {
          find: "@chicmoz-pkg/types",
          replacement: path.resolve(__dirname, "../chicmoz-types/src/index.ts"),
        },
        {
          find: "zod",
          replacement: path.resolve(__dirname, "node_modules/zod"),
        },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 8082,
      strictPort: true,
      fs: {
        allow: [path.resolve(__dirname, "..")],
      },
    },
  };
});
