// Magnetic scrolling: the page only ever comes to rest on a section.
//
// Every section owns a range of scroll positions: from where its title sits
// HEAD px below the top of the screen down to where its bottom edge meets the bottom of the
// screen. A section that fits on one screen has a single resting position, a
// tall one (program, where) scrolls freely inside its range. The stretch
// between one section's range and the next section's top is never a resting
// place: it is crossed in one go, as a flight.
//
// Touch devices do not run this; they use CSS scroll snap (see style.css).
(function magneticScroll() {
    if (matchMedia('(hover: none) and (pointer: coarse)').matches) return;

    const FLY_MS = 700;        // flight from one section to the next (a full screen of travel)
    const FOLLOW = 16;         // how tightly free scrolling inside a tall section follows the wheel (1/s)
    const GESTURE_GAP = 150;   // ms without wheel events before the next one counts as a new gesture
    const ARM = 8;             // px of wheel travel needed at a section edge before taking off
    const HEAD = 72;           // px between the top of the screen and a section's title when landed on it (keep in sync with --head in style.css)
    const HOLD_MS = 300;       // after a gesture is used up, how long before a re-swipe can be told from its inertia

    const sections = [...document.querySelectorAll('main > .s')];
    const root = document.scrollingElement || document.documentElement;
    if (!sections.length) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    let pos = scrollY, target = pos, expected = pos;
    let fly = null, running = false, lastT = 0;
    let dirty = false, extDir = 1, settleTimer = 0;

    // wheel gesture state. A gesture gets one move at a section boundary: either
    // it launches a flight, or it runs into the edge of a tall section and stops
    // there. After that it is "held": the rest of it (trackpad inertia can go on
    // for over a second) is ignored until a new gesture is recognised.
    let lastWheel = 0, canFly = false, acc = 0;
    let held = false, heldAt = 0, heldDir = 0, low = Infinity;
    let queued = 0;            // a new gesture that arrived mid-flight: carried out on landing
    function fresh() { held = false; canFly = true; acc = 0; }
    function hold(dir) { held = true; heldAt = performance.now(); heldDir = dir; low = Infinity; }

    function ranges() {
        const vh = innerHeight, max = Math.max(0, root.scrollHeight - vh);
        const R = [];
        sections.forEach((s, i) => {
            // sections start with empty padding above the title: land on the title, not on the padding
            const lead = i ? Math.max(0, parseFloat(getComputedStyle(s).paddingTop) - HEAD) : 0;
            const top = Math.min(s.offsetTop + lead, max);
            if (R.length && top <= R[R.length - 1].end + 1) return;      // cannot be reached: the page ends first
            const next = i + 1 < sections.length ? sections[i + 1].offsetTop : root.scrollHeight;
            let end = Math.max(top, Math.min(next - vh, max));
            // if only the empty bottom padding hangs off the screen, it still counts as fitting
            if (i + 1 < sections.length && end - top <= parseFloat(getComputedStyle(s).paddingBottom)) end = top;
            R.push({ top, end });
        });
        return R;
    }
    // index of the range y is in, or of the range just below y when y is in between two
    function locate(y, R) {
        for (let i = 0; i < R.length; i++) if (y <= R[i].end + 1) return { i, inside: y >= R[i].top - 1 };
        return { i: R.length - 1, inside: true };
    }

    function set(y) { expected = y; scrollTo(0, y); }

    function tick(now) {
        const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000)); lastT = now;
        if (fly) {
            const p = fly.ms ? Math.min(1, Math.max(0, (now - fly.t0) / fly.ms)) : 1;
            const e = 1 - Math.pow(1 - p, 3);                        // leaves at once, eases into the landing
            pos = fly.from + (fly.to - fly.from) * e;
            if (p >= 1) {
                pos = target = fly.to; fly = null;
                if (queued) { const q = queued; queued = 0; fresh(); acc = ARM; push(q * 60); }
            }
        } else {
            pos += (target - pos) * (1 - Math.exp(-dt * FOLLOW));
            if (Math.abs(target - pos) < 0.5) pos = target;
        }
        set(pos);
        if (fly || pos !== target) requestAnimationFrame(tick); else running = false;
    }
    function run() {
        if (running) return;
        running = true; lastT = performance.now();
        requestAnimationFrame(tick);
    }
    function flyTo(y) {
        const span = Math.min(1, Math.max(0.4, Math.abs(y - pos) / innerHeight));
        fly = { from: pos, to: y, t0: performance.now(), ms: reduce ? 0 : FLY_MS * span };
        queued = 0;
        target = y;
        run();
    }

    // a scroll request of `delta` px from the wheel or the keyboard
    function push(delta) {
        const dir = Math.sign(delta);
        if (fly || !dir) return;
        const R = ranges(), at = locate(target, R), i = at.i;
        if (!at.inside) { hold(dir); flyTo(dir > 0 ? R[i].top : R[i - 1].end); return; }

        const r = R[i], edge = dir > 0 ? r.end : r.top;
        if (Math.abs(target - edge) >= 1) {
            // inside a tall section: scroll, but never past its edge
            canFly = false;
            target = Math.min(r.end, Math.max(r.top, target + delta));
            run();
            return;
        }
        if (!canFly) { hold(dir); return; }                          // ran into the edge: leaving takes a new gesture
        acc += Math.abs(delta);
        if (acc < ARM) return;
        hold(dir);
        if (dir > 0 && i + 1 < R.length) flyTo(R[i + 1].top);
        else if (dir < 0 && i > 0) flyTo(R[i - 1].end);
    }

    addEventListener('wheel', e => {
        if (e.ctrlKey) return;                                       // pinch zoom
        // Every event must be cancelled, also sideways ones: if the first event
        // of a touchpad gesture gets through, the browser takes over the whole
        // gesture natively and none of the following events can be cancelled.
        if (!e.cancelable) return;                                   // too late, native scroll: settle() cleans up
        e.preventDefault();
        const d = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? innerHeight : 1);
        const a = Math.abs(d), dir = Math.sign(d);
        if (!dir || Math.abs(e.deltaX) > a * 2) return;
        const now = performance.now(), gap = now - lastWheel;
        lastWheel = now;
        if (gap > GESTURE_GAP) {
            if (fly) { if (now - fly.t0 > fly.ms * 0.3) queued = dir; return; }
            fresh();
        } else if (held) {
            // still in the same stream of events. Inertia only ever decays and
            // never turns around, so a jump in speed or a reversal is a new swipe.
            if (!fly && now - heldAt > HOLD_MS && ((dir !== heldDir && a >= 4) || a > 2 * low + 6)) fresh();
            else low = Math.min(low, a);
        }
        if (held) return;
        push(d);
    }, { passive: false });

    addEventListener('keydown', e => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
        const el = e.target;
        if (el && el.closest && el.closest('input, textarea, select, [contenteditable]')) return;
        const page = innerHeight * 0.85;
        let d = 0;
        if (e.key === 'ArrowDown') d = 90;
        else if (e.key === 'ArrowUp') d = -90;
        else if (e.key === 'PageDown') d = page;
        else if (e.key === 'PageUp') d = -page;
        else if (e.key === ' ' && !(el && el.closest && el.closest('a, button'))) d = e.shiftKey ? -page : page;
        if (!d) return;
        e.preventDefault();
        if (fly) { if (!e.repeat) queued = Math.sign(d); return; }
        fresh(); acc = ARM;
        push(d);
        held = false;
    });

    // anything else that moves the page (scrollbar, Home/End, find in page,
    // focus, touch on a hybrid laptop): let it, then pull to the nearest section
    function settle() {
        clearTimeout(settleTimer);
        if (!dirty || fly) return;
        dirty = false;
        const R = ranges(), at = locate(pos, R);
        if (at.inside) return;
        const a = R[at.i - 1].end, b = R[at.i].top, f = (pos - a) / (b - a);
        flyTo(extDir > 0 ? (f > 0.05 ? b : a) : (f < 0.95 ? a : b));
    }
    addEventListener('scroll', () => {
        if (Math.abs(scrollY - expected) <= 2) return;               // our own move
        extDir = Math.sign(scrollY - pos) || extDir;
        fly = null; queued = 0; dirty = true;
        pos = target = expected = scrollY;
        clearTimeout(settleTimer); settleTimer = setTimeout(settle, 300);
    }, { passive: true });
    if ('onscrollend' in window) addEventListener('scrollend', settle);

    function recheck() { clearTimeout(settleTimer); settleTimer = setTimeout(() => { dirty = true; settle(); }, 250); }
    addEventListener('resize', recheck);
    addEventListener('load', recheck);
})();
