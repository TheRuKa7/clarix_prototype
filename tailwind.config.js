/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{html,ts}",
  ],
  theme: {
    extend: {
      // Stone greys that sit with Cloud Dancer, and Clarix violet (PANTONE 7672 C), so every utility class follows the new palette.
      colors: {
        gray: { 50: '#fafaf9', 100: '#f5f5f4', 200: '#e7e5e2', 300: '#d6d3cf', 400: '#a8a29e', 500: '#78716c', 600: '#57534e', 700: '#44403c', 800: '#292524', 900: '#1c1917', 950: '#0c0a09' },
        slate: { 50: '#fafaf9', 100: '#f5f5f4', 200: '#e7e5e2', 300: '#d6d3cf', 400: '#a8a29e', 500: '#78716c', 600: '#57534e', 700: '#44403c', 800: '#292524', 900: '#1c1917', 950: '#0c0a09' },
        indigo: { 50: '#f1f0f8', 100: '#e3e0f1', 200: '#c8c2e3', 300: '#a69dd0', 400: '#8478bd', 500: '#6a5fc1', 600: '#4c4184', 700: '#3a3168', 800: '#2c2550', 900: '#1f1a3a', 950: '#120f24' },
        primary: { 50: '#f1f0f8', 100: '#e3e0f1', 200: '#c8c2e3', 300: '#a69dd0', 400: '#8478bd', 500: '#6a5fc1', 600: '#4c4184', 700: '#3a3168', 800: '#2c2550', 900: '#1f1a3a', 950: '#120f24' },
      },
      fontFamily: {
        'sans': ['Geist', 'system-ui', '-apple-system', 'sans-serif'],
        'mono': ['Geist Mono', 'ui-monospace', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
  darkMode: 'class',
}