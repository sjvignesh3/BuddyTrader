/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Premium light theme — warm ivory ground, ink text, deep teal
        // primary, muted gold + rose accents.
        brand: {
          bg: "#f4f2ec",      // warm ivory ground
          soft: "#faf9f5",    // raised soft surface
          panel: "#ffffff",   // cards
          border: "#e5e0d4",  // warm stone hairline
          text: "#181c26",    // ink
          mute: "#8b8574",    // warm gray
          accent: "#0f766e",  // deep teal
          gold: "#9a6a08",
          warn: "#b45309",
          danger: "#be123c",
        },
      },
      fontFamily: {
        display: ['"Fraunces"', "Georgia", "serif"],
        sans: ['"Inter"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(24,28,38,0.04), 0 8px 24px -12px rgba(24,28,38,0.12)",
        pop: "0 4px 12px rgba(24,28,38,0.08), 0 24px 48px -16px rgba(24,28,38,0.22)",
      },
    },
  },
  plugins: [],
};
