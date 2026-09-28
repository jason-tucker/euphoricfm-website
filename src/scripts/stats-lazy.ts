// Loads the Station Stats driver (stats.ts, the heaviest script on the site)
// only when the #stats section gets close to the viewport, or when someone
// presses "Show full stats" first. Also owns that toggle, so it works before
// stats.ts has arrived; stats.ts listens for `efm:stats-full` and re-renders
// the charts that were drawn while hidden.

const section = document.getElementById('stats');

if (section) {
  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    void import('./stats');
  };

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        load();
      },
      { rootMargin: '1200px 0px' },
    );
    io.observe(section);
  } else {
    load();
  }

  const toggle = document.getElementById('stats-full-toggle');
  const full = document.getElementById('stats-full');
  const label = document.getElementById('stats-full-label');
  toggle?.addEventListener('click', () => {
    if (!full) return;
    const open = full.classList.contains('hidden');
    full.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', String(open));
    if (label) label.textContent = (open ? toggle.dataset.hide : toggle.dataset.show) ?? '';
    load();
    document.dispatchEvent(new CustomEvent('efm:stats-full', { detail: { open } }));
  });
}
