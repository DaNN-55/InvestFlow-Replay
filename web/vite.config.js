import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig(() => {
  const backendPort = Number(process.env.INVESTFLOW_REPLAY_BACKEND_PORT ?? 3110);
  const webPort = Number(process.env.INVESTFLOW_REPLAY_WEB_PORT ?? 5180);

  return {
    plugins: [vue()],
    server: {
      host: "127.0.0.1",
      port: webPort,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${backendPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
