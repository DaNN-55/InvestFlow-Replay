/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{vue,js}"],
  prefix: "ql-",
  theme: {
    extend: {
      colors: {
        ink: "var(--ql-ink)",
        muted: "var(--ql-muted)",
        line: "var(--ql-line)",
        accent: "var(--ql-accent)",
        surface: "var(--ql-surface)",
        paper: "var(--ql-paper)",
        rise: "var(--ql-rise)",
        fall: "var(--ql-fall)",
        slate: {
          50: "var(--ql-color-bg-muted)",
          100: "var(--ql-color-bg-muted-strong)",
          200: "var(--ql-color-border-strong)",
          300: "var(--ql-color-text-subtle)",
          400: "var(--ql-color-text-subtle)",
          500: "var(--ql-color-text-muted)",
          600: "var(--ql-color-text-body)",
          700: "var(--ql-color-text-body)",
          800: "var(--ql-color-text-strong)",
          900: "var(--ql-color-text-strong)",
        },
        indigo: {
          50: "#eef7ff",
          100: "#dcefff",
          200: "#b9ddff",
          300: "#7dc0ff",
          400: "#4fa6f5",
          500: "#2997ff",
          600: "#0071e3",
          700: "#0066cc",
          800: "#004ea3",
          900: "#003366",
        },
      },
      fontFamily: {
        sans: ["SF Pro Text", "SF Pro Display", "-apple-system", "BlinkMacSystemFont", "Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
        display: ["SF Pro Display", "SF Pro Text", "-apple-system", "BlinkMacSystemFont", "Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
        mono: ["SF Mono", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        sm: "0 1px 2px rgba(0, 0, 0, 0.04)",
        lg: "0 2px 10px rgba(0, 0, 0, 0.08)",
        xl: "0 3px 16px rgba(0, 0, 0, 0.1)",
        "2xl": "0 6px 24px rgba(0, 0, 0, 0.12)",
        card: "3px 5px 30px 0px rgba(0, 0, 0, 0.22)",
      },
      animation: {
        fadein: "fadein 360ms ease-out both",
      },
      keyframes: {
        fadein: {
          from: { opacity: 0, transform: "translateY(10px)" },
          to: { opacity: 1, transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
