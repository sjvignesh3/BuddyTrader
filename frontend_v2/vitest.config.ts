// Vitest — pure domain math under src/lib gets unit coverage (sizing, net
// worth). No DOM: these modules have zero UI / API dependencies by design.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
