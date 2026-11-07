// What the activity indicator showed during a real job (SCN-66): sampled in the page on a timer that
// runs when the main thread is free, with every long task the browser reports. A long task with no
// indicator on screen is a freeze the user cannot see the reason for.

/** Start watching in the page. */
export const watchActivity = (frame) =>
  frame.evaluate(() => {
    const w = { t0: performance.now(), samples: [], longtasks: [], gaps: [] };
    window.__watch = w;
    const showing = () => {
      const el = document.querySelector('[data-id="activity"]');
      return el && !el.hidden ? el : null;
    };
    w.timer = setInterval(() => {
      const el = showing();
      const at = Math.round(performance.now() - w.t0);
      const running = window.gisworkbench.activity.items().map((i) => i.label);
      if (!el) return void w.samples.push({ at, shown: false, running });
      const bar = el.querySelector('[role="progressbar"]');
      w.samples.push({
        at,
        shown: true,
        running,
        label: el.querySelector('.activity-label').textContent,
        time: el.querySelector('.activity-time').textContent,
        pct: Number(bar.getAttribute('aria-valuenow') ?? NaN),
        moving: el.classList.contains('indeterminate'),
        cancel: !el.querySelector('.activity-cancel').hidden,
        more: el.querySelector('.activity-more').hidden ? '' : el.querySelector('.activity-more').textContent,
      });
    }, 100);
    w.obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.longtasks.push({ at: Math.round(e.startTime - w.t0), ms: Math.round(e.duration) });
    });
    w.obs.observe({ type: 'longtask' });
  });

/** Stop watching → a short summary of what was on screen. */
export const stopActivity = (frame) =>
  frame.evaluate(() => {
    const w = window.__watch;
    clearInterval(w.timer);
    w.obs.disconnect();
    const shown = w.samples.filter((s) => s.shown);
    const labels = [...new Set(shown.map((s) => s.label))];
    const pcts = shown.map((s) => s.pct).filter(Number.isFinite);
    // A long task counts as hidden when the last sample before it showed nothing.
    const hidden = w.longtasks.filter((l) => l.ms >= 2000 && !w.samples.filter((s) => s.at <= l.at).at(-1)?.shown);
    const firstRunning = w.samples.find((s) => s.running.length)?.at ?? null;
    return {
      ms: Math.round(performance.now() - w.t0),
      firstRunningMs: firstRunning,
      firstShownMs: shown[0]?.at ?? null,
      labels,
      times: shown.map((s) => s.time).filter((x, i, a) => a.indexOf(x) === i).slice(-4),
      topPct: pcts.length ? Math.max(...pcts) : null,
      monotonic: pcts.every((p, i) => i === 0 || p >= pcts[i - 1]),
      hadMoving: shown.some((s) => s.moving),
      hadCancel: shown.some((s) => s.cancel),
      more: [...new Set(shown.map((s) => s.more).filter(Boolean))],
      longestTaskMs: Math.max(0, ...w.longtasks.map((l) => l.ms)),
      longTasksOver2s: w.longtasks.filter((l) => l.ms >= 2000).length,
      hiddenLongTasks: hidden.length,
    };
  });

/** Wait until the indicator shows `label` (a RegExp source), then press Cancel. */
export const cancelWhenShown = (frame, label, { atPct = 0 } = {}) =>
  frame.evaluate(
    ({ label, atPct }) =>
      new Promise((res) => {
        const tick = setInterval(() => {
          const el = document.querySelector('[data-id="activity"]');
          if (!el || el.hidden || !new RegExp(label).test(el.querySelector('.activity-label').textContent)) return;
          if (Number(el.querySelector('[role="progressbar"]').getAttribute('aria-valuenow') ?? 0) < atPct) return;
          clearInterval(tick);
          el.querySelector('.activity-cancel').click();
          res(true);
        }, 50);
      }),
    { label, atPct },
  );
