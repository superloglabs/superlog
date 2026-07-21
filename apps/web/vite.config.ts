import { statSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };

  // HMR misfires for worktrees in some layouts (e.g. under `.claude/worktrees/…`
  // where a hidden parent dir defeats chokidar's macOS FSEvents listener and the
  // browser silently goes stale). Polling is the boring, reliable workaround;
  // only enable it for worktrees so the main checkout doesn't pay the CPU cost.
  //
  // Detection: in any git worktree the local `.git` is a *file* pointing at the
  // main repo's `.git/worktrees/<name>`; in the main checkout `.git` is a dir.
  // Catches `.claude/worktrees`, Conductor's `~/conductor/workspaces`, Codex's
  // `.codex/worktrees`, and anywhere else, without per-tool path coupling.
  //
  // Vite's cwd is the package dir (apps/web), not the repo root, so we have
  // to walk up looking for the `.git` marker — only the workspace root
  // carries it. Without this walk the check finds no `.git` and silently
  // leaves polling off, which is exactly the rake we just stepped on.
  let inWorktree = false;
  let dir = process.cwd();
  while (true) {
    try {
      const stat = statSync(path.join(dir, ".git"));
      inWorktree = stat.isFile();
      break;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(process.cwd(), "src"),
      },
    },
    server: {
      host: env.HOST ?? "127.0.0.1",
      port: Number(env.PORT ?? env.WEB_PORT ?? 5173),
      strictPort: true,
      watch: inWorktree ? { usePolling: true, interval: 150 } : undefined,
      allowedHosts: [".localhost", ".ngrok-free.app", ".ngrok.app", ".trycloudflare.com"],
    },
  };
});
