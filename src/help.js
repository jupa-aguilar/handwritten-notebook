// The guide. Its content is static markup in index.html — this only opens it,
// keeps the section chips in step with what you're reading, and hands the
// keyboard back where it came from.

const $ = (sel) => document.querySelector(sel);

let onShortcuts = () => {};

// Which chip is lit follows the scroll directly. An IntersectionObserver was
// the first try and stayed silent: its root is a modal that is display:none
// when the observer is set up, and it never woke.
function sections() {
  return [...document.querySelectorAll('#help-body .help-section')];
}

function markActive() {
  const body = $('#help-body');
  const top = body.getBoundingClientRect().top;
  const list = sections();
  let active = list[0];
  for (const s of list) {
    if (s.getBoundingClientRect().top - top <= 24) active = s;
  }
  // The last sections are short enough that their tops never reach the top of
  // the scroller, so at the bottom the chip would stick on whichever one did.
  if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) active = list.at(-1);
  for (const chip of document.querySelectorAll('.help-chip')) {
    chip.classList.toggle('active', chip.dataset.helpTo === active?.id);
  }
}

// Two things had to go for a chip to actually jump. offsetTop is measured
// against the nearest positioned ancestor — the modal, not the scroller —
// hence the rects. And the jump is deliberately instant: smooth scrolling,
// whether asked for in the stylesheet or through scrollTo, silently does
// nothing in some environments (measured: the identical assignment lands as
// soon as the behaviour is 'auto'), and a chip that quietly fails to move is
// worse than one that moves abruptly.
function scrollToSection(id) {
  const body = $('#help-body');
  const target = document.getElementById(id);
  if (!target) return;
  const delta = target.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTop += delta - 8;
  markActive();
}

export function openHelp() {
  const el = $('#help');
  if (!el.hidden) return;
  el.hidden = false;
  $('#help-body').scrollTop = 0;
  markActive();
  $('#help-close').focus();
}

export function closeHelp() {
  $('#help').hidden = true;
}

export function initHelp(opts = {}) {
  onShortcuts = opts.onShortcuts || onShortcuts;

  $('#help-btn').addEventListener('click', openHelp);
  $('#help-close').addEventListener('click', closeHelp);
  $('#help-done').addEventListener('click', closeHelp);
  $('#help-shortcuts').addEventListener('click', () => {
    closeHelp();
    onShortcuts();
  });

  $('#help-nav').addEventListener('click', (e) => {
    const chip = e.target.closest('.help-chip');
    if (!chip) return;
    scrollToSection(chip.dataset.helpTo);
  });

  $('#help-body').addEventListener('scroll', markActive, { passive: true });
}
