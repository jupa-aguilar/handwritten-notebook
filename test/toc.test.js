import { describe, it, expect } from 'vitest';
import { buildTocPrompt, parseToc, batchPages, placeEntries, sentenceCase } from '../src/toc.js';

const batch = [
  { number: 37, text: 'I.4 Disco: por qué cambia el hardware\nAgrandar el disco es trivial.' },
  { number: 38, text: 'J.1 Una idea distinta con el mismo nombre\nLa máquina virtual de Java…' },
];

describe('buildTocPrompt', () => {
  it('sends each page under the number the reader sees', () => {
    const [, user] = buildTocPrompt(batch);
    expect(user.content).toContain('--- Page 37 ---');
    expect(user.content).toContain('--- Page 38 ---');
    expect(user.content).toContain('Agrandar el disco es trivial.');
  });

  // Levels are decided per batch, so without the tail of what came before,
  // every batch starts a fresh hierarchy at 1 and the list reads as flat.
  it('carries what earlier batches already found, so the levels line up', () => {
    const [, user] = buildTocPrompt(batch, [
      { level: 1, title: 'I. Memoria y disco', page: 30 },
      { level: 2, title: 'I.3 Memoria', page: 34 },
    ]);
    expect(user.content).toContain('Found so far');
    expect(user.content).toContain('I. Memoria y disco (p. 30)');
    expect(user.content).toContain('I.3 Memoria (p. 34)');
  });

  it('says nothing about earlier entries on the first batch', () => {
    expect(buildTocPrompt(batch)[1].content).not.toContain('Found so far');
  });

  it('asks for a verbatim anchor, and for a name where the page has no heading', () => {
    const system = buildTocPrompt(batch)[0].content;
    expect(system).toMatch(/copied VERBATIM/);
    expect(system).toMatch(/name the section yourself/i);
    expect(system).toMatch(/handwritten notes usually do not/i);
    expect(system).toMatch(/An empty list is the right answer/i);
  });
});

describe('parseToc', () => {
  const one = '{"entries":[{"level":2,"title":"J.1 Una idea distinta","page":38,"anchor":"Una idea distinta"}]}';

  it('digs the entries out of a fenced, chatty reply', () => {
    const got = parseToc('Claro:\n```json\n' + one + '\n```');
    expect(got).toEqual([
      { level: 2, title: 'J.1 Una idea distinta', page: 38, anchor: 'Una idea distinta' },
    ]);
  });

  it('accepts a bare array too', () => {
    expect(parseToc('[{"level":1,"title":"I. Disco","page":37}]')).toEqual([
      { level: 1, title: 'I. Disco', page: 37, anchor: '' },
    ]);
  });

  it('is empty for junk, an empty list, or nothing at all', () => {
    for (const raw of ['', null, 'no encontré secciones', '{"entries":[]}']) {
      expect(parseToc(raw)).toEqual([]);
    }
  });

  it('drops an entry with no title or no usable page', () => {
    const raw = '{"entries":[{"level":1,"title":"","page":37},{"level":1,"title":"Sin página"},{"level":1,"title":"Bien","page":37}]}';
    expect(parseToc(raw).map((e) => e.title)).toEqual(['Bien']);
  });

  // A page the batch never showed is the model reading a number off the page
  // rather than answering about what it was given, and an entry that jumps to
  // the wrong page is worse than one that is missing.
  it('drops a page the batch did not cover', () => {
    const raw = '{"entries":[{"level":1,"title":"Aquí","page":37},{"level":1,"title":"Allá","page":99}]}';
    expect(parseToc(raw, new Set([37, 38])).map((e) => e.title)).toEqual(['Aquí']);
  });

  it('clamps the level into 1–3 and defaults a missing one', () => {
    const raw = '{"entries":[{"title":"a","page":1,"level":0},{"title":"b","page":1,"level":9},{"title":"c","page":1}]}';
    expect(parseToc(raw).map((e) => e.level)).toEqual([1, 3, 1]);
  });

  it('keeps one entry per title per page', () => {
    const raw = '{"entries":[{"title":"Disco","page":37},{"title":"disco","page":37},{"title":"Disco","page":38}]}';
    expect(parseToc(raw)).toHaveLength(2);
  });

  it('returns them in page order whatever order they arrived in', () => {
    const raw = '{"entries":[{"title":"b","page":38},{"title":"a","page":37}]}';
    expect(parseToc(raw).map((e) => e.page)).toEqual([37, 38]);
  });
});

describe('batchPages', () => {
  const pages = Array.from({ length: 10 }, (_, i) => ({ number: i + 1, text: 'x'.repeat(1000) }));

  it('covers every page exactly once, in order', () => {
    const seen = batchPages(pages, 3000).flat().map((p) => p.number);
    expect(seen).toEqual(pages.map((p) => p.number));
  });

  it('fills a batch up to the budget and no further', () => {
    // 1040 chars a page against 3000: two per batch, never three.
    expect(batchPages(pages, 3000).every((b) => b.length <= 2)).toBe(true);
  });

  it('never drops a page that is bigger than the whole budget on its own', () => {
    const huge = [{ number: 1, text: 'x'.repeat(50000) }, { number: 2, text: 'y' }];
    expect(batchPages(huge, 1000).flat().map((p) => p.number)).toEqual([1, 2]);
  });

  it('is empty for no pages', () => {
    expect(batchPages([], 1000)).toEqual([]);
  });

  // The reply has to come back whole: a hosted budget would otherwise put a
  // whole notebook in one request, and its answer is one JSON of every heading
  // in it.
  it('caps a batch at a dozen pages however big the budget is', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ number: i + 1, text: 'x' }));
    const batches = batchPages(many, 10_000_000);
    expect(batches.every((b) => b.length <= 12)).toBe(true);
    expect(batches.flat().map((p) => p.number)).toEqual(many.map((p) => p.number));
  });
});

describe('placeEntries', () => {
  // The notebook that showed this up: three fourteen-page documents scanned
  // into one, each page printing its own number, so the model answered with the
  // number written on the page instead of the one it was given.
  const notebook = [
    { number: 9, text: 'RAID: capacidad, velocidad y tolerancia a fallas\nRAID 0 — striping\nPÁG. 9/14' },
    { number: 10, text: 'Contenedores vs. máquinas virtuales\nMáquina virtual, contenedor\nPÁG. 10/14' },
    { number: 23, text: 'IPv4, máscaras y subredes\nUna dirección y su máscara\nPÁG. 9/14' },
    { number: 24, text: 'Firewall y acceso a servicios\nReglas de entrada y salida\nPÁG. 10/14' },
  ];

  it('keeps the page the model named when the anchor is written on it', () => {
    const got = placeEntries(
      [{ level: 1, title: 'RAID', page: 9, anchor: 'RAID: capacidad, velocidad' }],
      notebook
    );
    expect(got.map((e) => e.page)).toEqual([9]);
  });

  it('moves an entry to the page that actually carries its anchor', () => {
    const got = placeEntries(
      [
        { level: 1, title: 'IPv4, máscaras y subredes', page: 9, anchor: 'IPv4, máscaras y subredes' },
        { level: 1, title: 'Firewall y acceso a servicios', page: 10, anchor: 'Firewall y acceso a servicios' },
      ],
      notebook
    );
    expect(got.map((e) => e.page)).toEqual([23, 24]);
  });

  it('matches an anchor the model retyped imperfectly, as locateAnchor does', () => {
    const got = placeEntries(
      [{ level: 1, title: 'Contenedores', page: 9, anchor: 'contenedores vs maquinas virtuales' }],
      notebook
    );
    expect(got.map((e) => e.page)).toEqual([10]);
  });

  it('keeps the claim when the anchor is on no page at all', () => {
    const got = placeEntries(
      [{ level: 1, title: 'Algo', page: 10, anchor: 'una paráfrasis que nadie escribió' }],
      notebook
    );
    expect(got.map((e) => e.page)).toEqual([10]);
  });

  it('drops an entry two pages carry equally rather than guessing', () => {
    const twins = [
      { number: 3, text: 'Ejercicios resueltos de la unidad' },
      { number: 7, text: 'Ejercicios resueltos de la unidad' },
    ];
    expect(placeEntries([{ level: 1, title: 'Ejercicios', page: 5, anchor: 'Ejercicios resueltos' }], twins)).toEqual([]);
  });

  it('leaves an entry with no anchor where the model put it', () => {
    const got = placeEntries([{ level: 1, title: 'Sin ancla', page: 10, anchor: '' }], notebook);
    expect(got.map((e) => e.page)).toEqual([10]);
  });

  it('re-sorts by the corrected page, not the claimed one', () => {
    const got = placeEntries(
      [
        { level: 1, title: 'IPv4', page: 9, anchor: 'IPv4, máscaras y subredes' },
        { level: 1, title: 'RAID', page: 9, anchor: 'RAID: capacidad, velocidad' },
      ],
      notebook
    );
    expect(got.map((e) => e.title)).toEqual(['RAID', 'IPv4']);
  });

  it('ignores pages with no transcription', () => {
    const got = placeEntries(
      [{ level: 1, title: 'RAID', page: 9, anchor: 'RAID: capacidad, velocidad' }],
      [...notebook, { number: 40, text: '' }, { number: 41 }]
    );
    expect(got.map((e) => e.page)).toEqual([9]);
  });
});

describe('sentenceCase', () => {
  // The two pages from the notebook that showed this up: one heading shouted,
  // the next capitalised every important word, and the index showed both.
  const containers = [
    'CONTENEDORES VS. MÁQUINAS VIRTUALES',
    'Máquina virtual — más aislamiento y flexibilidad',
    'Contenedor — proceso aislado, liviano y rápido',
    'Comparte la familia de kernel y la arquitectura CPU del host.',
  ].join('\n');
  const raid = [
    'RAID: Capacidad, Velocidad y Tolerancia a Fallas',
    'RAID 0 — striping: máxima capacidad y velocidad',
    'la paridad permite reconstruir datos faltantes',
    'una dirección IPv4 y su máscara de subred',
  ].join('\n');

  it('brings a shouted heading down to ordinary writing', () => {
    expect(sentenceCase('CONTENEDORES VS. MÁQUINAS VIRTUALES', containers)).toBe(
      'Contenedores vs. máquinas virtuales'
    );
  });

  it('keeps the capitals of a word the page never writes in lower case', () => {
    expect(sentenceCase('RAID: CAPACIDAD Y VELOCIDAD', raid)).toBe('RAID: capacidad y velocidad');
  });

  it('restores the page\'s own spelling rather than a guess at it', () => {
    expect(sentenceCase('IPV4 Y MÁSCARA DE SUBRED', raid)).toBe('IPv4 y máscara de subred');
  });

  it('takes Title Case down too, since the index shows both side by side', () => {
    expect(sentenceCase('RAID: Capacidad, Velocidad y Tolerancia a Fallas', raid)).toBe(
      'RAID: capacidad, velocidad y tolerancia a fallas'
    );
  });

  it('leaves a title that is already written ordinarily', () => {
    for (const t of [
      'Planificación de CPU y colas multinivel',
      'Imagen, Dockerfile, contenedor y volumen',
      'Modelo OSI y encapsulación',
    ]) {
      expect(sentenceCase(t, raid)).toBe(t);
    }
  });

  // Two capitalised words are as likely to be a name as a pattern.
  it('leaves a short title alone', () => {
    expect(sentenceCase('Docker Compose', containers)).toBe('Docker Compose');
  });

  it('lowers what the page never writes at all, but for the first word', () => {
    expect(sentenceCase('TEMAS PENDIENTES DEL PARCIAL', '')).toBe('Temas pendientes del parcial');
  });

  it('ignores an all-capitals line as evidence of how a word is written', () => {
    // "CONTENEDOR" appears in capitals on the diagram's label line; that line
    // is shouting, so it must not be what makes the title shout back.
    expect(sentenceCase('CONTENEDOR Y MÁQUINA VIRTUAL', 'VM CONTENEDOR\nun contenedor es un proceso')).toBe(
      'Contenedor y máquina virtual'
    );
  });
});

describe('placeEntries casing', () => {
  it('writes the title the way the page it landed on writes its words', () => {
    const batch = [
      { number: 4, text: 'RAID 0 — striping\nmáxima capacidad y velocidad del arreglo' },
    ];
    const got = placeEntries(
      [{ level: 1, title: 'RAID: CAPACIDAD Y VELOCIDAD', page: 4, anchor: 'RAID 0 striping' }],
      batch
    );
    expect(got[0].title).toBe('RAID: capacidad y velocidad');
  });
});

describe('placeEntries levels', () => {
  // A page of the notebook this came from: the subject at the head, underlined
  // twice, then its sections underlined once. The transcription keeps the order
  // and loses the underlines, which is the whole problem.
  const page = [
    'PÁGINA 2/16  DÍA  MES  AÑO',
    'Núcleo, usuario y concepto de proceso',
    'Dos niveles de privilegio',
    'Espacio de núcleo (anillo 0): accede al hardware, memoria física.',
    'Biblioteca ≠ llamada al sistema',
    'Una función de biblioteca corre dentro del proceso.',
  ].join('\n');
  const batch = [{ number: 16, text: page }];

  it('makes the heading a page opens with its top-level entry', () => {
    const got = placeEntries(
      [{ level: 2, title: 'Núcleo, usuario y concepto de proceso', page: 16, anchor: 'Núcleo, usuario y concepto de proceso' }],
      batch
    );
    expect(got.map((e) => e.level)).toEqual([1]);
  });

  it('puts the headings further down that page under it', () => {
    const got = placeEntries(
      [
        { level: 1, title: 'Dos niveles de privilegio', page: 16, anchor: 'Dos niveles de privilegio' },
        { level: 1, title: 'Núcleo, usuario y concepto de proceso', page: 16, anchor: 'Núcleo, usuario y concepto de proceso' },
        { level: 1, title: 'Biblioteca ≠ llamada al sistema', page: 16, anchor: 'Biblioteca llamada al sistema' },
      ],
      batch
    );
    expect(got.map((e) => [e.title, e.level])).toEqual([
      ['Núcleo, usuario y concepto de proceso', 1],
      ['Dos niveles de privilegio', 2],
      ['Biblioteca ≠ llamada al sistema', 2],
    ]);
  });

  it('keeps a deeper level the model asked for', () => {
    const got = placeEntries(
      [
        { level: 1, title: 'Núcleo, usuario y concepto de proceso', page: 16, anchor: 'Núcleo, usuario y concepto de proceso' },
        { level: 3, title: 'Dos niveles de privilegio', page: 16, anchor: 'Dos niveles de privilegio' },
      ],
      batch
    );
    expect(got.map((e) => e.level)).toEqual([1, 3]);
  });

  // A page that opens mid-paragraph is a page whose title was on the one
  // before: there is nothing at its head to promote, and nothing to demote
  // the rest against either.
  it('promotes nothing on a page that opens in the middle of something', () => {
    const continues = [{
      number: 17,
      text:
        'reduce el tiempo de interrupción del servicio, porque la réplica ya tiene ' +
        'una copia actualizada y el nodo activo puede caer sin que nadie lo note. ' +
        'El orquestador decide dónde corre cada máquina virtual.\n' +
        'Latencia\nLa ubicación depende de la carga.',
    }];
    const got = placeEntries(
      [{ level: 2, title: 'Latencia', page: 17, anchor: 'Latencia La ubicación depende' }],
      continues
    );
    expect(got.map((e) => e.level)).toEqual([2]);
  });

  it('leaves the level alone when the anchor was never located', () => {
    const got = placeEntries(
      [{ level: 2, title: 'Algo', page: 16, anchor: 'una paráfrasis que nadie escribió' }],
      batch
    );
    expect(got.map((e) => e.level)).toEqual([2]);
  });

  it('levels each page on its own head, not the notebook\'s first', () => {
    const two = [
      { number: 4, text: 'Arquitecturas del kernel y familias Linux\nKernel monolítico: servicios dentro del núcleo.' },
      { number: 5, text: 'Memoria protegida, virtual y swap\nMemoria virtual\nCada proceso ve direcciones propias.' },
    ];
    const got = placeEntries(
      [
        { level: 1, title: 'Arquitecturas del kernel y familias Linux', page: 4, anchor: 'Arquitecturas del kernel y familias Linux' },
        { level: 2, title: 'Memoria protegida, virtual y swap', page: 5, anchor: 'Memoria protegida, virtual y swap' },
        { level: 1, title: 'Memoria virtual', page: 5, anchor: 'Memoria virtual Cada proceso ve' },
      ],
      two
    );
    expect(got.map((e) => [e.page, e.level])).toEqual([[4, 1], [5, 1], [5, 2]]);
  });

  it('does not leak the anchor offset it worked from', () => {
    const [e] = placeEntries(
      [{ level: 1, title: 'Núcleo, usuario y concepto de proceso', page: 16, anchor: 'Núcleo, usuario y concepto de proceso' }],
      batch
    );
    expect(Object.keys(e).sort()).toEqual(['anchor', 'level', 'page', 'title']);
  });
});
