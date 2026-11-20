// Christmas theme extras: festive favicon, twinkling lights, falling snow.
// Does nothing unless the server's HOLIDAY_THEME is 'christmas'.
(() => {
  'use strict';
  const root = document.documentElement;
  if (!root.classList.contains('theme-christmas')) return;

  // Favicon: the pencil logo on red with a green corner.
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) {
    icon.href = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
      + "%3Crect width='32' height='32' rx='8' fill='%23c8102e'/%3E%3Cpath d='M0 24 L8 32 H0Z' fill='%230f7a3b'/%3E"
      + "%3Cpath d='M9 23l2-6 9-9 4 4-9 9z' fill='white'/%3E%3C/svg%3E";
  }

  // String of lights under the header.
  const lights = document.querySelector('.lights');
  if (lights) {
    const count = Math.max(12, Math.min(40, Math.round(window.innerWidth / 36)));
    for (let i = 0; i < count; i++) lights.append(document.createElement('i'));
  }

  // Snowfall behind the page content. Skipped for people who prefer less motion.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'snow';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let flakes = [];

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = Math.min(110, Math.round((width * height) / 14000));
    while (flakes.length < target) flakes.push(makeFlake(true));
    flakes.length = target;
  }

  function makeFlake(anywhere) {
    return {
      x: Math.random() * width,
      y: anywhere ? Math.random() * height : -10,
      r: 1 + Math.random() * 2.6,
      speed: 0.35 + Math.random() * 0.9,
      sway: Math.random() * Math.PI * 2,
    };
  }

  let last = performance.now();
  function frame(now) {
    const step = Math.min(50, now - last) / 16.7;
    last = now;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    for (const f of flakes) {
      f.y += f.speed * step;
      f.sway += 0.012 * step;
      f.x += Math.sin(f.sway) * 0.35 * step;
      if (f.y > height + 10) Object.assign(f, makeFlake(false));
      if (f.x < -10) f.x = width + 10;
      if (f.x > width + 10) f.x = -10;
      ctx.globalAlpha = 0.45 + f.r / 6;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
})();
