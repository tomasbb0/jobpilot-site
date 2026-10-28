// Subtle 3D tilt on the product shots: each one leans a little toward the pointer.
// Mouse and trackpad only, and off when the visitor prefers reduced motion.
(function () {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const MAX_DEG = 2.5;
  const shots = Array.from(document.querySelectorAll(".hero-shot, .stage .glass"));
  if (!shots.length) return;
  shots.forEach((el) => {
    el.style.transition = "transform .9s cubic-bezier(.2, .7, .2, 1)";
    el.style.willChange = "transform";
  });

  let x = 0, y = 0, queued = false;
  function tilt() {
    queued = false;
    const vw = window.innerWidth, vh = window.innerHeight;
    shots.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) return;
      const cx = r.left + r.width / 2;
      const cy = Math.max(r.top, 0) + Math.min(r.bottom, vh) / 2 - Math.max(r.top, 0) / 2;
      const dx = Math.max(-1, Math.min(1, (x - cx) / (vw / 2)));
      const dy = Math.max(-1, Math.min(1, (y - cy) / (vh / 2)));
      el.style.transform = `perspective(1200px) rotateX(${(-dy * MAX_DEG).toFixed(2)}deg) rotateY(${(dx * MAX_DEG).toFixed(2)}deg)`;
    });
  }
  window.addEventListener("pointermove", (e) => {
    x = e.clientX; y = e.clientY;
    if (!queued) { queued = true; requestAnimationFrame(tilt); }
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => shots.forEach((el) => { el.style.transform = ""; }));
})();
