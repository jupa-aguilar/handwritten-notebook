// The decoys come from the reader's own answers, so the risks are not the ones
// a generated question has. They are: offering an option that is also correct,
// and giving the answer away by its shape.
import { describe, it, expect } from 'vitest';
import { buildChoices, cardsNeedingDecoys } from '../src/choices.js';

// A deck where every distractor is plausible: same page, same subject.
const deck = [
  { id: 1, pageId: 1, topic: 'Mitocondria', a: 'ATP' },
  { id: 2, pageId: 1, topic: 'Mitocondria', a: 'Doble membrana' },
  { id: 3, pageId: 1, topic: 'Mitocondria', a: 'ADN circular' },
  { id: 4, pageId: 1, topic: 'Mitocondria', a: 'Matriz mitocondrial' },
];
const card = deck[0];

// A shuffle that leaves the order alone, so a test can say where things are.
const still = () => 0;

describe('buildChoices', () => {
  it('offers the answer among decoys drawn from the deck', () => {
    const { options, correct } = buildChoices(card, deck, { rng: still });
    expect(options).toHaveLength(4);
    expect(options[correct]).toBe('ATP');
    expect(new Set(options).size).toBe(4);
  });

  it('refuses a decoy that could itself be right', () => {
    // "produce ATP" contains the answer, so offering it would be a trick.
    const tricky = [...deck, { id: 5, pageId: 1, a: 'produce ATP' }];
    const { options } = buildChoices(card, tricky, { rng: still });
    expect(options).not.toContain('produce ATP');
  });

  it('refuses one the answer is contained in, which is the same trap backwards', () => {
    const long = { id: 1, pageId: 1, a: 'La cadena respiratoria de la mitocondria' };
    const tricky = [long, { id: 5, pageId: 1, a: 'La cadena' }, ...deck.slice(1)];
    const { options } = buildChoices(long, tricky, { rng: still });
    expect(options).not.toContain('La cadena');
  });

  it('prefers answers of a similar length, so the shape gives nothing away', () => {
    const mixed = [
      { id: 1, pageId: 1, a: 'Se sintetiza ATP en la cadena respiratoria interna' },
      { id: 2, pageId: 1, a: 'La membrana interna se pliega formando las crestas' },
      { id: 3, pageId: 1, a: 'El ADN circular se hereda por vía materna siempre' },
      { id: 4, pageId: 1, a: 'La matriz contiene las enzimas del ciclo de Krebs' },
      { id: 5, pageId: 1, a: 'Sí' },
      { id: 6, pageId: 1, a: 'No' },
    ];
    const { options } = buildChoices(mixed[0], mixed, { rng: still });
    expect(options).not.toContain('Sí');
    expect(options).not.toContain('No');
  });

  it('keeps a short decoy whose letters merely occur inside the answer', () => {
    // "Sí" folds to "si", which is inside "sintetiza" — a substring test threw
    // it away, and with it most short decoys on a deck of mixed lengths.
    const short = [
      { id: 1, pageId: 1, a: 'Se sintetiza ATP' },
      { id: 2, pageId: 1, a: 'Sí' },
      { id: 3, pageId: 1, a: 'No' },
      { id: 4, pageId: 1, a: 'Quizá' },
    ];
    const { options } = buildChoices(short[0], short, { rng: still });
    expect(options).toContain('Sí');
  });

  it('prefers the same page over the rest of the notebook', () => {
    const wide = [
      { id: 1, pageId: 1, a: 'ATP' },
      { id: 2, pageId: 1, a: 'Doble membrana' },
      { id: 3, pageId: 1, a: 'ADN circular' },
      { id: 9, pageId: 7, a: 'Teorema de Bayes' },
      { id: 4, pageId: 1, a: 'Matriz mitocondrial' },
    ];
    const { options } = buildChoices(wide[0], wide, { rng: still });
    expect(options).not.toContain('Teorema de Bayes');
  });

  it('gives up rather than offer a thin question', () => {
    expect(buildChoices(card, deck.slice(0, 3), { rng: still })).toBeNull();
    expect(buildChoices(card, [card], { rng: still })).toBeNull();
    expect(buildChoices({ id: 1, a: '' }, deck, { rng: still })).toBeNull();
  });

  it('does not always put the answer in the same place', () => {
    // Walked through a run of positions rather than trusting one draw.
    const seen = new Set();
    for (const r of [0, 0.35, 0.7, 0.99]) {
      seen.add(buildChoices(card, deck, { rng: () => r }).correct);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('always reports the index the answer actually landed on', () => {
    for (const r of [0, 0.35, 0.7, 0.99]) {
      const { options, correct } = buildChoices(card, deck, { rng: () => r });
      expect(options[correct]).toBe('ATP');
    }
  });
});

// The flaw the first version had: same-page decoys that answer nothing like
// the question, so the right option stands out without being read.
describe('relevance to the question', () => {
  const page = [
    { id: 1, pageId: 8, q: '¿Qué diferencia hay entre replicación y backup?',
      a: 'La replicación aumenta la disponibilidad, pero no reemplaza al backup' },
    { id: 2, pageId: 8, q: '¿Qué se comparte?', a: 'CPU y RAM de varios servidores' },
    { id: 3, pageId: 8, q: '¿Qué se puede agregar en caliente?', a: 'Agregar RAM, VCPU, disco o red sin apagar' },
    { id: 4, pageId: 8, q: '¿Qué permite vGPU?', a: 'Particionar una GPU potente entre varias cargas' },
  ];

  it('says so when the only decoys available are about something else', () => {
    const built = buildChoices(page[0], page, { rng: still });
    expect(built.weak).toBe(true);
  });

  it('prefers an answer that talks about the question over one that merely shares a page', () => {
    const withRelevant = [
      ...page,
      { id: 9, pageId: 30, a: 'El backup reemplaza a la replicación cuando falla el disco' },
    ];
    const { options } = buildChoices(page[0], withRelevant, { rng: still });
    expect(options).toContain('El backup reemplaza a la replicación cuando falla el disco');
  });

  it('is not weak once the card carries decoys written for it', () => {
    const armed = { ...page[0], decoys: ['Son lo mismo', 'El backup da disponibilidad', 'Ninguna de las dos'] };
    const built = buildChoices(armed, [armed, ...page.slice(1)], { rng: still });
    expect(built.weak).toBe(false);
    expect(built.options).toContain('Son lo mismo');
  });

  it('picks out exactly the cards a model call would be worth spending on', () => {
    const ids = cardsNeedingDecoys(page).map((c) => c.id);
    expect(ids).toContain(1);
  });

  it('leaves alone a card that already has its own decoys', () => {
    const armed = page.map((c) =>
      c.id === 1 ? { ...c, decoys: ['a', 'b', 'c'] } : c
    );
    expect(cardsNeedingDecoys(armed).map((c) => c.id)).not.toContain(1);
  });
});
