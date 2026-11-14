/** Public library, cover presentation and journal; book preparation lives in local tools. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Globe2,
  Headphones,
  Sparkles,
  X,
} from "lucide-react";
import type { Book, Catalog } from "./domain";
import { recoverBookmark, validateBook } from "./domain";
import Reader from "./reader";
import { unlockPaperSounds } from "./paper_sound";
import { readPreferences } from "./domain";

/** Read optional browser state without making privacy restrictions a fatal error. */
export function saved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
/** Persist a preference or bookmark when browser storage is available. */
export function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Reading remains available with blocked storage. */
  }
}

/** Render cover typography independently of the watercolor artwork. */
export function Cover({
  book,
  className = "",
}: {
  book: Book;
  className?: string;
}) {
  return (
    <div
      className={`cover-art ${className}`}
      style={{ backgroundImage: `url("${book.cover}")` }}
    >
      <span className="cover-imprint">BIBLIOTHÈQUE · LES CLASSIQUES</span>
      <span className="cover-title">{book.title}</span>
      <span className="cover-author">{book.author}</span>
      <span className="cover-edition">
        {book.chapters.some((c) => c.segments.some((s) => s.pt.trim()))
          ? "ÉDITION BILINGUE · FR / PT"
          : "ÉDITION FRANÇAISE · FR"}
      </span>
      <span className="cover-binding" />
    </div>
  );
}

/** Reveal the welcome once per browser session while keeping a complete accessible heading. */
function WelcomeTitle() {
  const title = "Bienvenue à la bibliothèque";
  const [length, setLength] = useState(() => {
    try {
      return matchMedia("(prefers-reduced-motion: reduce)").matches ||
        sessionStorage.getItem("welcome-shown")
        ? title.length
        : 0;
    } catch {
      return title.length;
    }
  });
  useEffect(() => {
    if (length >= title.length) return;
    const timer = setInterval(
      () => setLength((value) => Math.min(title.length, value + 1)),
      75,
    );
    try {
      sessionStorage.setItem("welcome-shown", "true");
    } catch {
      /* Animation is optional when storage is blocked. */
    }
    return () => clearInterval(timer);
  }, []);
  return (
    <h1 id="hero-title" lang="fr" aria-label={title}>
      <span aria-hidden="true">
        {title.slice(0, length)}
        <span className="typing-caret">|</span>
      </span>
    </h1>
  );
}

/** Fill the shelf with inert, untitled grey volumes without inventing catalogue entries. */
function BlankVolumes({ side }: { side: "left" | "right" }) {
  return (
    <>
      {Array.from({ length: 14 }, (_, index) => {
        const seed = side === "left" ? 13 - index : index;
        return (
          <span
            key={seed}
            aria-hidden="true"
            className={`placeholder-book ${seed >= 3 ? "blank-distant" : ""}`}
            style={
              {
                width: 20 + ((seed * 17) % 25),
                height: 190 + ((seed * 23) % 67),
                "--spine-color": [
                  "#bcbbb5",
                  "#cac9c3",
                  "#b0b0ab",
                  "#d0cfc9",
                  "#bfbeb8",
                ][seed % 5],
                "--book-lean": `${seed % 5 === 0 ? -3 : seed % 7 === 0 ? 2 : 0}deg`,
              } as CSSProperties
            }
          >
            <span className="book-object">
              <span className="book-spine" />
              <span className="book-top" />
              <span className="blank-front" />
            </span>
          </span>
        );
      })}
    </>
  );
}

/** Fetch only reviewed static manifests; reject malformed editions before opening the reader. */
export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Book | null>(null);
  const [reading, setReading] = useState<Book | null>(null);
  const [openingFrom, setOpeningFrom] = useState<DOMRect | null>(null);
  const [tab, setTab] = useState("library");
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState("all");
  const [resume, setResume] = useState(true);
  const [hoveredBook, setHoveredBook] = useState<{
    book: Book;
    x: number;
    y: number;
  } | null>(null);
  const rackRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const coverRef = useRef<HTMLButtonElement>(null);
  const bookOrigin = useRef<DOMRect | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const response = await fetch("/catalog.json", {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Não foi possível carregar a estante.");
      const data = (await response.json()) as Catalog;
      if (
        data.schemaVersion !== 1 ||
        !Array.isArray(data.books) ||
        !Array.isArray(data.entries)
      )
        throw new Error("Este catálogo precisa de uma atualização.");
      const manifests = await Promise.all(
        data.books.map(async (entry) => {
          if (
            !/^\/books\/[a-zA-Z0-9_./-]+\.json$/.test(entry.manifest) ||
            entry.manifest.includes("..")
          )
            throw new Error("Endereço de edição inválido.");
          const response = await fetch(entry.manifest, {
            signal: controller.signal,
          });
          if (!response.ok)
            throw new Error("Uma edição está indisponível. Tente novamente.");
          const value: unknown = await response.json();
          validateBook(value);
          return value;
        }),
      );
      setCatalog(data);
      setBooks(manifests);
    })().catch((e) => {
      if (e.name !== "AbortError") setError(e.message);
    });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!selected) {
      lastFocus.current?.focus();
      return;
    }
    lastFocus.current = document.activeElement as HTMLElement;
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
      if (e.key === "Tab") {
        const items = [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".cover-dialog button",
          ),
        ];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        items[
          (i + (e.shiftKey ? items.length - 1 : 1)) % items.length
        ]?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [selected]);
  useLayoutEffect(() => {
    const rack = rackRef.current;
    if (!rack) return;
    const center = () => {
      const book = rack.querySelector<HTMLElement>(".shelf-book");
      if (!book) return;
      const item = book.getBoundingClientRect();
      const frame = rack.getBoundingClientRect();
      rack.scrollLeft +=
        item.left + item.width / 2 - frame.left - rack.clientWidth / 2;
    };
    const observer = new ResizeObserver(center);
    observer.observe(rack);
    center();
    return () => observer.disconnect();
  }, [books, query, language, tab, reading]);
  useLayoutEffect(() => {
    const target = coverRef.current;
    const origin = bookOrigin.current;
    if (
      !selected ||
      !target ||
      !origin ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const rect = target.getBoundingClientRect();
    const animation = target.animate(
      [
        {
          transform: `translate(${origin.left + origin.width / 2 - rect.left - rect.width / 2}px, ${origin.top + origin.height / 2 - rect.top - rect.height / 2}px) scale(${origin.height / rect.height}) rotateY(82deg)`,
          opacity: 0.3,
        },
        { transform: "translate(0, 0) scale(1) rotateY(0deg)", opacity: 1 },
      ],
      { duration: 900, easing: "cubic-bezier(.16, 1, .3, 1)" },
    );
    return () => animation.cancel();
  }, [selected]);
  if (reading)
    return (
      <Reader
        book={reading}
        resume={resume}
        openingFrom={openingFrom}
        onClose={() => {
          setReading(null);
          setOpeningFrom(null);
        }}
      />
    );
  const pairs = [
    ...new Set(
      books.map((book) => `${book.sourceLanguage}:${book.targetLanguage}`),
    ),
  ];
  const filtered = books.filter(
    (book) =>
      `${book.title} ${book.translatedTitle} ${book.author}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()) &&
      (language === "all" ||
        `${book.sourceLanguage}:${book.targetLanguage}` === language),
  );
  return (
    <div className={`library-app ${tab === "library" ? "library-home" : ""}`}>
      <header className="site-header">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setTab("library");
          }}
        >
          bibliothèque
        </a>
        <nav aria-label="Navegação principal">
          <button
            className={tab === "library" ? "active" : ""}
            onClick={() => setTab("library")}
          >
            A biblioteca
          </button>
          <button
            className={tab === "journal" ? "active" : ""}
            onClick={() => setTab("journal")}
          >
            Diário
          </button>
          <button
            className={tab === "about" ? "active" : ""}
            onClick={() => setTab("about")}
          >
            Sobre
          </button>
        </nav>
      </header>
      <main>
        {tab === "library" ? (
          <>
            <section className="hero" aria-labelledby="hero-title">
              <div className="hero-kicker">
                HISTÓRIAS QUE ATRAVESSAM IDIOMAS
              </div>
              <WelcomeTitle />
              <span className="volume-count">
                {books.length.toString().padStart(2, "0")}{" "}
                {books.length === 1 ? "VOLUME" : "VOLUMES"}
              </span>
            </section>
            <section className="collection" aria-label="Biblioteca">
              <div className="archive-controls">
                <input
                  className="archive-search"
                  type="search"
                  aria-label="Buscar na biblioteca"
                  placeholder="Que história você procura?"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <div
                  className="archive-filters"
                  role="group"
                  aria-label="Filtrar por idioma"
                >
                  <button
                    aria-pressed={language === "all"}
                    onClick={() => setLanguage("all")}
                  >
                    Todos
                  </button>
                  {pairs.map((pair) => (
                    <button
                      key={pair}
                      aria-pressed={language === pair}
                      onClick={() => setLanguage(pair)}
                    >
                      {pair === "fr:pt-BR"
                        ? "Francês → Português"
                        : pair.replace(":", " → ")}
                    </button>
                  ))}
                </div>
              </div>
              {error ? (
                <div className="empty-state" role="alert">
                  <BookOpen size={26} />
                  <p>{error}</p>
                  <button onClick={() => location.reload()}>
                    Tentar novamente
                  </button>
                </div>
              ) : !catalog ? (
                <div className="empty-state">
                  <span className="loading-dot" />
                  <p>Preparando a estante…</p>
                </div>
              ) : (
                <div className="shelf-stage" aria-label="Estante de livros">
                  <div
                    ref={rackRef}
                    className="shelf-books"
                    aria-label="Livros disponíveis"
                  >
                    {filtered.length > 0 && <BlankVolumes side="left" />}
                    {filtered.map((book, index) => (
                      <button
                        key={book.id}
                        className="shelf-book"
                        aria-label={`Ver capa de ${book.title}`}
                        style={
                          {
                            "--spine-color": book.accent,
                            "--book-lean": `${index % 2 === 0 ? -2 : 1}deg`,
                          } as CSSProperties
                        }
                        onMouseEnter={(event) => {
                          const rect =
                            event.currentTarget.getBoundingClientRect();
                          setHoveredBook({
                            book,
                            x: rect.left + rect.width / 2,
                            y: rect.top - 18,
                          });
                        }}
                        onMouseLeave={() => setHoveredBook(null)}
                        onFocus={(event) => {
                          const rect =
                            event.currentTarget.getBoundingClientRect();
                          setHoveredBook({
                            book,
                            x: rect.left + rect.width / 2,
                            y: rect.top - 18,
                          });
                        }}
                        onBlur={() => setHoveredBook(null)}
                        onClick={(event) => {
                          setHoveredBook(null);
                          bookOrigin.current =
                            event.currentTarget.getBoundingClientRect();
                          setSelected(book);
                        }}
                      >
                        <span className="book-object" aria-hidden="true">
                          <span className="book-spine">
                            <span className="spine-rule top-rule" />
                            <span className="spine-title">{book.title}</span>
                            <span className="spine-author">{book.author}</span>
                            <span className="spine-mark">b.</span>
                            <span className="spine-rule bottom-rule" />
                          </span>
                          <span className="book-front">
                            <Cover book={book} />
                          </span>
                          <span className="book-top" />
                          <span className="book-bottom" />
                        </span>
                      </button>
                    ))}
                    {filtered.length > 0 && <BlankVolumes side="right" />}
                  </div>
                  {!filtered.length && (
                    <div className="no-results">
                      Nenhum livro encontrado.
                      <button
                        className="text-button"
                        onClick={() => {
                          setQuery("");
                          setLanguage("all");
                        }}
                      >
                        Ver toda a coleção
                      </button>
                    </div>
                  )}
                  <div className="shelf-ground" aria-hidden="true" />
                  <p className="shelf-invitation">
                    ESCOLHA UM LIVRO PARA COMEÇAR
                  </p>
                </div>
              )}
            </section>
          </>
        ) : tab === "journal" ? (
          <section className="editorial-page">
            <span className="eyebrow">NOTAS DA BIBLIOTECA</span>
            <h1>
              Nosso <em>diário.</em>
            </h1>
            <p className="editorial-intro">
              Uma coleção também é uma história em construção.
            </p>
            {catalog?.entries.map((entry) => (
              <article
                className="journal-entry"
                key={`${entry.date}-${entry.title}`}
              >
                <div className="journal-date">
                  {new Date(`${entry.date}T12:00:00`).toLocaleDateString(
                    "pt-BR",
                    {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    },
                  )}
                  <span>{entry.tag}</span>
                </div>
                <h2>{entry.title}</h2>
                <p>{entry.text}</p>
              </article>
            ))}
          </section>
        ) : (
          <section className="editorial-page about-page">
            <span className="eyebrow">O PRAZER DE DESCOBRIR</span>
            <h1>
              Histórias que
              <br />
              <em>atravessam idiomas.</em>
            </h1>
            <p className="editorial-intro">
              Bibliothèque nasceu de uma ideia simples: aprender outra língua
              pode começar com uma boa história.
            </p>
            <div className="about-grid">
              <article>
                <BookOpen strokeWidth={1.2} />
                <h2>Leia lado a lado</h2>
                <p>
                  Francês e português, frase a frase. Ajuste a fonte e esconda a
                  tradução quando quiser se desafiar.
                </p>
              </article>
              <article>
                <Headphones strokeWidth={1.2} />
                <h2>Encontre seu ritmo</h2>
                <p>
                  A narração acompanha cada palavra e vira as páginas com você.
                  Ouça devagar, repita, descubra.
                </p>
              </article>
              <article>
                <Sparkles strokeWidth={1.2} />
                <h2>Guarde a curiosidade</h2>
                <p>
                  No computador, passe o mouse para ligar palavras nos dois
                  idiomas. Clique ou toque para consultar o significado. Seu
                  progresso fica neste navegador.
                </p>
              </article>
            </div>
            <button
              className="primary-button"
              onClick={() => setTab("library")}
            >
              Voltar à estante <ArrowRight size={16} />
            </button>
          </section>
        )}
      </main>
      <footer className="site-footer">
        <span>
          bibliothèque<span className="brand-dot">.</span>
        </span>
        <span>HISTÓRIAS PARA LER, OUVIR E DESCOBRIR.</span>
        <span>© {new Date().getFullYear()} Bibliothèque</span>
      </footer>
      {hoveredBook &&
        !selected &&
        createPortal(
          <aside
            className="shelf-tooltip"
            role="tooltip"
            style={{
              left: Math.max(
                135,
                Math.min(window.innerWidth - 135, hoveredBook.x),
              ),
              top: hoveredBook.y,
            }}
          >
            <strong>{hoveredBook.book.title}</strong>
            <span>{hoveredBook.book.author}</span>
            <small>FRANÇAIS · PORTUGUÊS</small>
          </aside>,
          document.body,
        )}
      {selected && (
        <div
          className="cover-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelected(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="cover-dialog-title"
            className="cover-dialog"
          >
            <button
              ref={closeRef}
              className="dialog-close icon-button"
              aria-label="Voltar à estante"
              onClick={() => setSelected(null)}
            >
              <X size={22} />
            </button>
            <button
              ref={coverRef}
              className="detail-cover"
              aria-label={`Abrir ${selected.title}`}
              onClick={() => {
                setResume(true);
                unlockPaperSounds(readPreferences(saved("preferences")).sounds);
                setOpeningFrom(
                  coverRef.current?.getBoundingClientRect() ?? null,
                );
                setReading(selected);
                setSelected(null);
              }}
            >
              <Cover book={selected} />
              <span className="open-cover-hint">
                TOQUE PARA ABRIR <ArrowRight size={13} />
              </span>
            </button>
            <div className="cover-detail">
              <span className="eyebrow">
                LES CLASSIQUES ·{" "}
                {String(
                  books.findIndex((b) => b.id === selected.id) + 1,
                ).padStart(3, "0")}
              </span>
              <h2 id="cover-dialog-title">{selected.title}</h2>
              <span className="detail-translated">
                {selected.translatedTitle}
              </span>
              <p className="detail-author">{selected.author}</p>
              <p>{selected.description}</p>
              <div className="detail-chips">
                <span>
                  <Globe2 size={14} />{" "}
                  {selected.chapters.some((c) =>
                    c.segments.some((s) => s.pt.trim()),
                  )
                    ? "FR → PT-BR"
                    : "Original francês"}
                </span>
                <span>
                  <Headphones size={14} />{" "}
                  {selected.chapters.some((c) => c.audio)
                    ? "Leitura narrada"
                    : "Áudio em preparação"}
                </span>
                <span>
                  <BookOpen size={14} /> {selected.chapters.length} capítulos
                </span>
              </div>
              {selected.status === "preview" && (
                <p className="preview-note">
                  <Sparkles size={14} /> Edição em preparação editorial. Explore
                  a prévia de leitura.
                </p>
              )}
              <button
                className="primary-button"
                onClick={() => {
                  setResume(true);
                  unlockPaperSounds(
                    readPreferences(saved("preferences")).sounds,
                  );
                  setOpeningFrom(
                    coverRef.current?.getBoundingClientRect() ?? null,
                  );
                  setReading(selected);
                  setSelected(null);
                }}
              >
                {recoverBookmark(selected, saved(`bookmark:${selected.id}`))
                  ? "Continuar a leitura"
                  : "Abrir o livro"}
                <ArrowRight size={16} />
              </button>
              {recoverBookmark(selected, saved(`bookmark:${selected.id}`)) && (
                <button
                  className="text-button"
                  onClick={() => {
                    setResume(false);
                    unlockPaperSounds(
                      readPreferences(saved("preferences")).sounds,
                    );
                    setOpeningFrom(
                      coverRef.current?.getBoundingClientRect() ?? null,
                    );
                    setReading(selected);
                    setSelected(null);
                  }}
                >
                  Começar do início
                </button>
              )}
              <span className="detail-credit">
                <Check size={12} /> Seu ritmo. Seu tempo. Sem cadastro.
              </span>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
