// gwb-run's file input in the page (#265): the hidden #gwb-run-inputs the files go on, found again
// if the page kept it, or made and put under <html> when the page has no <body> just then. An
// expression; tests/e2e/27-gwb-run-page.spec.js evaluates this same file.
(() => {
  let i = document.getElementById('gwb-run-inputs');
  if (!i) {
    i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    i.id = 'gwb-run-inputs';
    i.hidden = true;
    (document.body ?? document.documentElement).appendChild(i);
  }
  return i;
})()
