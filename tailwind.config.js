/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0f172a",
        mist: "#F8FAFC",
        line: "#E2E8F0",
        accent: "#0f766e",
        accentDeep: "#115e59",
        accentSoft: "#ccfbf1",
        panel: "#ffffff",
        warning: "#b45309",
      },
      boxShadow: {
        panel: "0 16px 40px rgba(15, 23, 42, 0.06)",
        soft: "0 1px 3px rgba(0,0,0,0.05)",
      },
    },
  },
  plugins: [],
};
