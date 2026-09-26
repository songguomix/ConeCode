/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}', './preview/**/*.{html,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        clay: {
          50: '#FDF8F4', 100: '#FAF0E8', 200: '#F2DFD0',
          300: '#E5C4AA', 400: '#D4A07A', 500: '#C96442',
          600: '#B85A3A', 700: '#964A30', 800: '#6E3724', 900: '#4A2618',
        },
        surface: {
          0: '#1A1915', 1: '#14130F', 2: '#242320', 3: '#2E2D28', 4: '#3A3833',
        },
      },
      // Softer, rounder silhouette across the app — same class names, friendlier shape.
      borderRadius: {
        sm: '0.3rem',
        DEFAULT: '0.45rem',
        md: '0.6rem',
        lg: '0.85rem',
        xl: '1.1rem',
        '2xl': '1.35rem',
        '3xl': '1.75rem',
      },
    },
  },
  plugins: [],
};
