  // --- nav dropdowns (identical on every page) ---
  // On phones (640px and under) .top-nav scrolls sideways, and iOS WebKit clips or
  // misplaces anything left inside it, so an open menu is moved into <body> and fixed
  // under its trigger. There, the trigger label opens the menu instead of navigating
  // (the label's page is the menu's first item). Outside taps use pointerdown, because
  // iOS doesn't dispatch click to the document for taps on non-interactive elements.
  (function () {
    var nav = document.querySelector('.top-nav');
    var dropdowns = Array.prototype.map.call(document.querySelectorAll('.nav-dropdown'), function (dd) {
      return {
        dd: dd,
        label: dd.querySelector('a.nav-link'),
        caret: dd.querySelector('.nav-caret'),
        menu: dd.querySelector('.nav-dropdown-menu'),
        scrollStart: 0
      };
    });
    function isPhone() { return window.innerWidth <= 640; }
    function close(d) {
      d.menu.classList.remove('open');
      if (d.menu.parentNode !== d.dd) {
        d.menu.style.position = '';
        d.menu.style.zIndex = '';
        d.menu.style.top = '';
        d.menu.style.left = '';
        d.dd.appendChild(d.menu);
      }
    }
    function closeAll(except) {
      dropdowns.forEach(function (d) { if (d !== except) close(d); });
    }
    function open(d) {
      closeAll(d);
      d.scrollStart = nav.scrollLeft;
      if (isPhone()) {
        document.body.appendChild(d.menu);
        d.menu.style.position = 'fixed';
        d.menu.style.zIndex = '300';
        d.menu.classList.add('open');
        var maxLeft = window.innerWidth - Math.max(190, d.menu.offsetWidth) - 12;
        d.menu.style.top = (nav.getBoundingClientRect().bottom + 6) + 'px';
        d.menu.style.left = Math.max(12, Math.min(d.dd.getBoundingClientRect().left, maxLeft)) + 'px';
      } else {
        d.menu.classList.add('open');
      }
    }
    function toggle(d) {
      if (d.menu.classList.contains('open')) close(d); else open(d);
    }
    dropdowns.forEach(function (d) {
      d.caret.addEventListener('click', function (e) {
        e.stopPropagation();
        toggle(d);
      });
      d.label.addEventListener('click', function (e) {
        if (!isPhone()) return; // desktop: the label is an ordinary link
        e.preventDefault();
        e.stopPropagation();
        toggle(d);
      });
    });
    document.addEventListener('click', function () { closeAll(); });
    document.addEventListener('pointerdown', function (e) {
      if (!isPhone()) return;
      if (e.target.closest && e.target.closest('.nav-dropdown, .nav-dropdown-menu')) return;
      closeAll();
    });
    nav.addEventListener('scroll', function () {
      dropdowns.forEach(function (d) {
        if (d.menu.classList.contains('open') && Math.abs(nav.scrollLeft - d.scrollStart) > 4) close(d);
      });
    });
    // iOS fires resize when its toolbars show or hide, so only a width change counts.
    var lastWidth = window.innerWidth;
    window.addEventListener('resize', function () {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      closeAll();
    });
    window.addEventListener('orientationchange', function () { closeAll(); });
  })();
  // --- end nav dropdowns ---
