/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          bg: "#0b0f14",
          panel: "#111826",
          border: "#1f2937",
          text: "#e5e7eb",
          mute: "#94a3b8",
          accent: "#10b981",
          warn: "#f59e0b",
          danger: "#ef4444",
        },
      },
    },
  },
  plugins: [],
};
