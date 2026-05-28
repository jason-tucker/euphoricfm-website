/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0a0a0a',
        cream: '#ffffff',
        midnight: '#293462',
        ruby: '#d61c4e',
        sunburst: '#feb139',
        lemon: '#fff80a',
      },
      fontFamily: {
        body: ['"Inter"', 'system-ui', 'sans-serif'],
        euphoric: ['"Begaron"', 'system-ui', 'sans-serif'],
        fm: ['"Cortado Script"', 'cursive'],
      },
      maxWidth: {
        phone: '24rem',
      },
    },
  },
  plugins: [],
};
