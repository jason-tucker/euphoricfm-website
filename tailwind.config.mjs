/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      // Colours resolve to the channel vars in src/styles/tokens.css (the single
      // source of truth), so every `/alpha` modifier (bg-ruby/20, text-cream/60)
      // keeps working while the actual values live in one place.
      colors: {
        ink: 'rgb(var(--efm-ink-rgb) / <alpha-value>)',
        cream: 'rgb(var(--efm-cream-rgb) / <alpha-value>)',
        midnight: 'rgb(var(--efm-midnight-rgb) / <alpha-value>)',
        ruby: 'rgb(var(--efm-ruby-rgb) / <alpha-value>)',
        sunburst: 'rgb(var(--efm-sunburst-rgb) / <alpha-value>)',
        gold: 'rgb(var(--efm-gold-rgb) / <alpha-value>)',
        // Legacy alias — `lemon` now maps to the retuned warm gold so existing
        // `to-lemon` gradients become a smooth amber ramp with no code churn.
        lemon: 'rgb(var(--efm-gold-rgb) / <alpha-value>)',
      },
      fontFamily: {
        body: ['"Inter"', 'system-ui', 'sans-serif'],
        euphoric: ['"Begaron"', 'system-ui', 'sans-serif'],
        fm: ['"Cortado Script"', 'cursive'],
      },
      maxWidth: {
        phone: '24rem',
        // Desktop cap — keeps the hero from over-stretching on widescreens
        // and the whole above-the-fold layout fitting a 1080p viewport.
        frame: '64rem',
      },
      keyframes: {
        'soft-pulse': {
          '0%, 100%': { opacity: '0.6', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.04)' },
        },
      },
      animation: {
        'soft-pulse': 'soft-pulse 2.8s ease-in-out infinite',
      },
      backgroundImage: {
        'efm-aurora':
          'radial-gradient(60% 60% at 18% 10%, color-mix(in oklch, rgb(var(--efm-sunburst-rgb)) 35%, transparent), transparent 60%), radial-gradient(50% 50% at 95% 25%, color-mix(in oklch, rgb(var(--efm-ruby-rgb)) 35%, transparent), transparent 60%), radial-gradient(60% 60% at 50% 100%, color-mix(in oklch, rgb(var(--efm-midnight-rgb)) 70%, transparent), transparent 70%)',
      },
    },
  },
  plugins: [],
};
