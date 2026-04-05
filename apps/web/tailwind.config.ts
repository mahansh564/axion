import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(222 47% 97%)",
        foreground: "hsl(222 47% 11%)",
        card: "hsl(0 0% 100%)",
        border: "hsl(220 20% 86%)",
        primary: "hsl(224 75% 53%)",
        muted: "hsl(220 17% 42%)",
      },
    },
  },
  plugins: [],
};

export default config;
