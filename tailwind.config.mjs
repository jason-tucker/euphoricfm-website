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
        frame: '72rem', // desktop hero layout cap
      },
      keyframes: {
        spin: { to: { transform: 'rotate(360deg)' } },
        'soft-pulse': {
          '0%, 100%': { opacity: '0.6', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.04)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'spin-slow': 'spin 18s linear infinite',
        'soft-pulse': 'soft-pulse 2.8s ease-in-out infinite',
        shimmer: 'shimmer 6s linear infinite',
      },
      backgroundImage: {
        'efm-aurora':
          'radial-gradient(60% 60% at 18% 10%, color-mix(in oklch, #FEB139 35%, transparent), transparent 60%), radial-gradient(50% 50% at 95% 25%, color-mix(in oklch, #D61C4E 35%, transparent), transparent 60%), radial-gradient(60% 60% at 50% 100%, color-mix(in oklch, #293462 70%, transparent), transparent 70%)',
      },
    },
  },
  plugins: [],
};
