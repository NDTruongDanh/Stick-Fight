/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,html}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Luckiest Guy"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
