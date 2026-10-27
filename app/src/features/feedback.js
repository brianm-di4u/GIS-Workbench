// Feedback whiteboard feature: commands, IndexedDB sessions keyed by project (REQ-WB-10,
// outside the project file, obeying the journal-off policy), and the read-only AI tool and
// resource that expose pages to the assistant (REQ-WB-14; images only when attached).

import { Whiteboard, importFeedback } from '../feedback/whiteboard.js';
import { openReview, pageToObservationRecord, pageToAnnotation } from '../feedback/review.js';
import { toJson, fromJson, extractJsonFromHtml } from '../feedback/model.js';
import { reportHtml } from '../feedback/review.js';

export const name = 'feedback';

export function install(app) {
  const wb = new Whiteboard(app);
  app.feedback = wb;
  app.pageToObservation = (page) => pageToObservationRecord(app, page);
  app.pageToAnnotation = (page) => pageToAnnotation(app, page);
  const key = () => `fb/${app.project()?.created ?? 'none'}`;
  app.feedbackSession = {
    async save(w) {
      const j = app.journal;
      if (!j?.available) return;
      if (!j.enabled) return; // journal-off policy covers whiteboard sessions too
      await j.put('feedback', key(), { pages: w.pages, saved: Date.now() });
    },
    async load(w) {
      const j = app.journal;
      if (!j?.available || !j.enabled) return;
      const s = await j.get('feedback', key());
      if (s?.pages?.length) {
        w.pages = s.pages;
        app.toast(`Restored ${s.pages.length} feedback page(s) from this browser`);
        app.emit('state');
      }
    },
  };
  app.on('ready', () => app.feedbackSession.load(wb));
  const C = app.commands;
  C.implement('wb.toggle', {
    run: () => {
      if (!wb.active && !app.journal?.available) app.toast('Browser storage is unavailable: feedback pages last only for this session; export them before closing.', { kind: 'warn', ms: 6000 });
      wb.toggle();
    },
    checked: () => wb.active,
  });
  C.implement('wb.review', { run: () => openReview(app, wb) });
  C.implement('wb.import', { run: () => importFeedback(app, wb) });
  app.__test = { ...(app.__test ?? {}), reportHtml, fromJson, extractJsonFromHtml, toJson };
  app.feedbackForAi = () => toJson({ project: app.project()?.name, build: app.build.id, pages: wb.pages.map(({ image, ...p }) => ({ ...p, image: null, hasImage: !!image })) });
}
