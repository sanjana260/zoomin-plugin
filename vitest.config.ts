import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      // Obsidian's API only exists inside the app. Tests run the pure modules
      // and the model against this stub, never the real thing.
      obsidian: path.resolve(__dirname, "tests/obsidian-stub.ts"),
    },
  },
});
