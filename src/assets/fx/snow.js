// Falling snow from PuppyPad. Free to use (CC0).
// Add <script src="/snow.js"></script> to a page. Turned off for visitors who ask for less motion.
(function () {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  function go() {
    var style = document.createElement('style');
    style.textContent = '@keyframes pp-snow{to{transform:translateY(110vh)}}';
    document.head.appendChild(style);
    for (var i = 0; i < 40; i++) {
      var f = document.createElement('span');
      f.textContent = '❄';
      f.setAttribute('aria-hidden', 'true');
      var secs = 6 + Math.random() * 8;
      f.style.cssText = 'position:fixed;top:-5vh;pointer-events:none;z-index:9999;color:#fff;text-shadow:0 0 2px #8ab4ff;' +
        'left:' + Math.random() * 100 + 'vw;font-size:' + (8 + Math.random() * 14) + 'px;opacity:' + (0.5 + Math.random() * 0.5) + ';' +
        'animation:pp-snow ' + secs + 's linear ' + (-Math.random() * secs) + 's infinite';
      document.body.appendChild(f);
    }
  }
  if (document.body) go(); else document.addEventListener('DOMContentLoaded', go); // works from <head> too
})();
