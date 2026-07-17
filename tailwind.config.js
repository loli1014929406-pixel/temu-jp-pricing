/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#303030",
        mist: "#f1f1f1",
        line: "#d4d4d4",
        accent: "#303030",
        accentDeep: "#1a1a1a",
        accentSoft: "#e3e3e3",
        panel: "#ffffff",
        warning: "#8a6116",
      },
      boxShadow: {
        panel: "0 1px 0 rgba(0, 0, 0, 0.05), 0 1px 3px rgba(0, 0, 0, 0.08)",
        soft: "0 1px 2px rgba(0, 0, 0, 0.08)",
        glow: "0 2px 6px rgba(0, 0, 0, 0.14)",
      },
      animation: {
        "fade-up": "fade-up 700ms ease both",
        "gradient-pan": "gradient-pan 8s ease infinite",
        "beam": "beam 7s linear infinite",
        "float-slow": "float-slow 7s ease-in-out infinite",
        "border-flow": "border-flow 8s linear infinite",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(18px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "gradient-pan": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        beam: {
          "0%": { transform: "translateX(-18%) translateY(-12%) rotate(12deg)", opacity: "0" },
          "15%, 72%": { opacity: "1" },
          "100%": { transform: "translateX(115%) translateY(18%) rotate(12deg)", opacity: "0" },
        },
        "float-slow": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-10px)" },
        },
        "border-flow": {
          "0%": { backgroundPosition: "0% 50%" },
          "100%": { backgroundPosition: "200% 50%" },
        },
      },
    },
  },
  plugins: [],
};
