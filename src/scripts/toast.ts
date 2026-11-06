// toast.ts — one small status message at the bottom of the screen, shared by
// the home player and the Web Player (e.g. when the browser refuses to start
// the stream). Created on first use; a polite live region, so screen readers
// announce it without stealing focus. Styles: .efm-toast in global.css.

let el: HTMLDivElement | null = null;
let hideTimer = 0;

export const showToast = (message: string, ms = 5000): void => {
  if (!el) {
    el = document.createElement('div');
    el.className = 'efm-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('is-open');
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => el?.classList.remove('is-open'), ms);
};
