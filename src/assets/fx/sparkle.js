// Sparkle cursor from PuppyPad: little stars follow the mouse. Free to use (CC0).
// Add <script src="/sparkle.js"></script> to a page. Turned off for visitors who ask for less motion.
(function () {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var colours = ['#ffe14d', '#ff7ad9', '#7ad7ff', '#ffffff'], last = 0;
  document.addEventListener('mousemove', function (e) {
    var now = Date.now();
    if (now - last < 40) return;
    last = now;
    var s = document.createElement('span');
    s.textContent = '✦';
    s.setAttribute('aria-hidden', 'true');
    s.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;font-size:14px;transition:transform .8s ease-out,opacity .8s ease-out;' +
      'left:' + e.clientX + 'px;top:' + e.clientY + 'px;color:' + colours[Math.floor(Math.random() * colours.length)];
    document.body.appendChild(s);
    requestAnimationFrame(function () {
      s.style.transform = 'translate(' + (Math.random() * 30 - 15) + 'px,' + (10 + Math.random() * 20) + 'px) scale(.3)';
      s.style.opacity = '0';
    });
    setTimeout(function () { s.remove(); }, 900);
  });
})();
