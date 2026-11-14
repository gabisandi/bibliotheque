/** Reflowable CSS-column book reader driven by the native audio clock. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  Headphones,
  List,
  Moon,
  Pause,
  Play,
  Repeat2,
  SkipBack,
  SkipForward,
  Settings2,
  Sun,
  Volume2,
  X,
} from "lucide-react";
import type { Book, Passage, Preferences, WordTiming } from "./domain";
import {
  activeWord,
  clock,
  pairedWords,
  readPreferences,
  recoverBookmark,
  tokenize,
} from "./domain";
import { Cover, persist, saved } from "./app";
import { playPaperSound, unlockPaperSounds } from "./paper_sound";

interface Popup {
  source: string;
  target: string;
  note: string;
  language: "fr" | "pt";
  segmentId: string;
  x: number;
  y: number;
}

/** Locate a word or editorial expression in context; phrase fallback is explicitly labelled. */
function lookup(
  book: Book,
  segment: Passage,
  language: "fr" | "pt",
  offset: number,
  text: string,
): Omit<Popup, "x" | "y"> {
  const annotation = segment.annotations?.find(
    (a) => offset >= a[language][0] && offset < a[language][1],
  );
  const other = language === "fr" ? "pt" : "fr";
  const key = `${language}:${text.toLocaleLowerCase().normalize("NFC")}`;
  return {
    source: annotation
      ? segment[language].slice(...annotation[language])
      : text,
    target: annotation
      ? segment[other].slice(...annotation[other])
      : book.glossary[key] ||
        segment[other] ||
        "Tradução deste trecho em preparação.",
    note:
      annotation?.note ||
      (book.glossary[key]
        ? "Significado de apoio · observe o contexto da frase."
        : segment[other]
          ? "Tradução da frase no contexto."
          : "Original francês disponível; tradução ainda não preparada."),
    language,
    segmentId: segment.id,
  };
}

/** Render selectable text and accessible contextual word controls without altering whitespace. */
function Words({
  book,
  segment,
  language,
  active,
  onLookup,
  onDismiss,
  highlight,
  onHighlight,
}: {
  book: Book;
  segment: Passage;
  language: "fr" | "pt";
  active?: WordTiming;
  onLookup: (popup: Popup, pause: boolean) => void;
  onDismiss: () => void;
  highlight?: [number, number];
  onHighlight: (offset: number | null) => void;
}) {
  return (
    <>
      {tokenize(segment[language]).map((token) =>
        token.word ? (
          <span
            key={token.start}
            role="button"
            tabIndex={0}
            data-offset={token.start}
            data-word-segment={segment.id}
            data-word-language={language}
            className={`word ${language === "fr" && active?.segmentId === segment.id && token.start < active.offset + active.length && token.start + token.text.length > active.offset ? "spoken" : ""} ${highlight && token.start < highlight[1] && token.start + token.text.length > highlight[0] ? "paired-word" : ""}`}
            aria-label={`Consultar ${token.text}`}
            onMouseEnter={() => {
              if (matchMedia("(hover: hover)").matches)
                onHighlight(token.start);
            }}
            onMouseLeave={() => {
              onHighlight(null);
              if (matchMedia("(hover: hover)").matches) onDismiss();
            }}
            onBlur={() => {
              onHighlight(null);
              onDismiss();
            }}
            onFocus={() => onHighlight(token.start)}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onLookup(
                {
                  ...lookup(book, segment, language, token.start, token.text),
                  x: rect.left + rect.width / 2,
                  y: rect.top,
                },
                true,
              );
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.currentTarget.click();
              }
            }}
          >
            {token.text}
          </span>
        ) : (
          <span key={token.start}>{token.text}</span>
        ),
      )}
    </>
  );
}

/** Keep the user's stable text anchor while columns, chapter, font and viewport change. */
export default function Reader({
  book,
  onClose,
  resume,
  openingFrom,
}: {
  book: Book;
  onClose: () => void;
  resume: boolean;
  openingFrom?: DOMRect | null;
}) {
  const initial = useRef(
    resume ? recoverBookmark(book, saved(`bookmark:${book.id}`)) : null,
  );
  const [chapterIndex, setChapterIndex] = useState(() =>
    Math.max(
      0,
      book.chapters.findIndex(
        (c) => c.id === initial.current?.bookmark.chapterId,
      ),
    ),
  );
  const chapter = book.chapters[chapterIndex];
  const [preferences, setPreferences] = useState<Preferences>(() =>
    readPreferences(saved("preferences")),
  );
  const [settings, setSettings] = useState(false);
  const [contents, setContents] = useState(false);
  const [spread, setSpread] = useState(0);
  const [columns, setColumns] = useState(1);
  const [geometry, setGeometry] = useState({
    width: 480,
    height: 480,
    pages: window.innerWidth >= 800 ? 2 : 1,
  });
  const [popup, setPopup] = useState<Popup | null>(null);
  const [hoveredPair, setHoveredPair] = useState<{
    segmentId: string;
    fr: [number, number];
    pt: [number, number];
  } | null>(null);
  const [time, setTime] = useState(initial.current?.bookmark.time ?? 0);
  const [duration, setDuration] = useState(chapter.audio?.duration ?? 0);
  const [playing, setPlaying] = useState(false);
  const [turnWaiting, setTurnWaiting] = useState(false);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [notice, setNotice] = useState(
    initial.current?.moved
      ? "Lembramos o seu capítulo. A edição foi atualizada."
      : "",
  );
  const [audioError, setAudioError] = useState(false);
  const [turn, setTurn] = useState<"next" | "previous" | null>(null);
  const [opening, setOpening] = useState(Boolean(openingFrom));
  const [openingOrigin, setOpeningOrigin] = useState(openingFrom ?? null);
  const [coverVisible, setCoverVisible] = useState(false);
  const [coverClosing, setCoverClosing] = useState(false);
  const closedCover = useRef<HTMLButtonElement>(null);
  const bookFrame = useRef<HTMLElement>(null);
  const openingCover = useRef<HTMLDivElement>(null);
  const turnLayer = useRef<HTMLDivElement>(null);
  const turnGeneration = useRef(0);
  const viewport = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const anchor = useRef<{
    segmentId: string;
    offset: number;
    language?: "fr" | "pt";
  }>({
    segmentId: initial.current?.bookmark.segmentId ?? chapter.segments[0].id,
    offset: initial.current?.bookmark.offset ?? 0,
    language: initial.current?.bookmark.language ?? "fr",
  });
  const pageRef = useRef(0);
  const playingRef = useRef(false);
  const pendingTime = useRef(initial.current?.bookmark.time ?? 0);
  const openingAt = useRef(performance.now());
  const manualPage = useRef(false);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const active = activeWord(chapter.audio?.words ?? [], time);
  const totalSpreads = Math.max(1, Math.ceil(columns / geometry.pages));
  const step = geometry.width + 56;
  const page = spread * geometry.pages;
  const prefRef = useRef(preferences);
  prefRef.current = preferences;
  const chapterRef = useRef(chapter);
  chapterRef.current = chapter;

  const savePosition = useCallback(() => {
    persist(`bookmark:${book.id}`, {
      edition: book.edition,
      chapterId: chapterRef.current.id,
      ...anchor.current,
      time: audio.current?.currentTime ?? 0,
    });
  }, [book.id, book.edition]);
  const pause = useCallback(() => {
    clearTimeout(resumeTimer.current);
    resumeTimer.current = undefined;
    setTurnWaiting(false);
    audio.current?.pause();
  }, []);
  useEffect(() => () => clearTimeout(resumeTimer.current), []);
  const findAnchor = useCallback(() => {
    const nodes = flow.current?.querySelectorAll<HTMLElement>(
      "[data-word-segment]",
    );
    const first =
      nodes &&
      [...nodes].find(
        (node) =>
          Math.floor((node.offsetLeft + 1) / (geometry.width + 56)) >=
          pageRef.current,
      );
    if (first)
      anchor.current = {
        segmentId: first.dataset.wordSegment!,
        offset: Number(first.dataset.offset),
        language: first.dataset.wordLanguage as "fr" | "pt",
      };
  }, [geometry.width]);
  /** Turn a physical leaf around the binding using inert snapshots of the current pages. */
  const animatePageTurn = useCallback(
    (direction: number, nextSpread: number) => {
      playPaperSound("page_turn", prefRef.current.sounds);
      const layer = turnLayer.current;
      const source = flow.current;
      const frame = bookFrame.current;
      if (
        !layer ||
        !source ||
        !frame ||
        matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;
      const generation = ++turnGeneration.current;
      layer.replaceChildren();
      const isForward = direction > 0;
      const pages = geometry.pages;
      const half = pages === 2 ? frame.clientWidth / 2 : frame.clientWidth;
      const top = viewport.current!.offsetTop;
      const left = viewport.current!.offsetLeft;
      const gutter = 28;
      /** Crop a real page without adding another accessible copy of its content. */
      const snapshot = (column: number, inset: number) => {
        const window = document.createElement("div");
        window.className = "page-snapshot-window";
        Object.assign(window.style, {
          top: `${top}px`,
          left: `${inset}px`,
          width: `${geometry.width}px`,
          height: `${geometry.height}px`,
        });
        const clone = source.cloneNode(true) as HTMLDivElement;
        clone.inert = true;
        clone.style.transition = "none";
        clone.style.transform = `translateX(-${column * (geometry.width + 56)}px)`;
        clone
          .querySelectorAll("[tabindex]")
          .forEach((node) => node.removeAttribute("tabindex"));
        window.append(clone);
        return window;
      };
      if (pages === 2) {
        const stationary = document.createElement("div");
        stationary.className = "turn-static";
        Object.assign(stationary.style, {
          left: isForward ? "0px" : `${half}px`,
          width: `${half}px`,
        });
        stationary.append(
          snapshot(
            pageRef.current + (isForward ? 0 : 1),
            isForward ? left : gutter,
          ),
        );
        layer.append(stationary);
      }
      const leaf = document.createElement("div");
      leaf.className = "turn-leaf";
      Object.assign(leaf.style, {
        left: isForward && pages === 2 ? `${half}px` : "0px",
        width: `${half}px`,
        transformOrigin: isForward ? "left center" : "right center",
      });
      const front = document.createElement("div");
      front.className = "turn-face turn-front";
      front.append(
        snapshot(
          pageRef.current + (pages === 2 && isForward ? 1 : 0),
          pages === 2 && isForward ? gutter : left,
        ),
      );
      const back = document.createElement("div");
      back.className = "turn-face turn-back";
      if (pages === 2)
        back.append(
          snapshot(
            nextSpread * pages + (isForward ? 0 : 1),
            isForward ? left : gutter,
          ),
        );
      leaf.append(front, back);
      layer.append(leaf);
      setTurn(isForward ? "next" : "previous");
      const animation = leaf.animate(
        [
          { transform: "rotateY(0deg)" },
          { transform: `rotateY(${isForward ? -180 : 180}deg)` },
        ],
        {
          duration: 720,
          easing: "cubic-bezier(.3,.08,.2,1)",
          fill: "forwards",
        },
      );
      animation.finished
        .then(() => {
          if (generation === turnGeneration.current) {
            layer.replaceChildren();
            setTurn(null);
          }
        })
        .catch(() => {});
    },
    [geometry],
  );
  const move = useCallback(
    (direction: number) => {
      if (opening || coverClosing) return;
      pause();
      setPopup(null);
      manualPage.current = true;
      const current = Math.floor(pageRef.current / geometry.pages);
      if (coverVisible) {
        if (direction > 0 && !coverClosing) openClosedCover();
        return;
      }
      if (direction < 0 && current === 0 && chapterIndex === 0) {
        if (audio.current) audio.current.currentTime = 0;
        setTime(0);
        setCoverClosing(true);
        setCoverVisible(true);
        setHoveredPair(null);
        return;
      }
      const next = Math.max(
        0,
        Math.min(Math.ceil(columns / geometry.pages) - 1, current + direction),
      );
      if (next === current) return;
      animatePageTurn(direction, next);
      setSpread(next);
    },
    [
      columns,
      geometry.pages,
      pause,
      animatePageTurn,
      coverVisible,
      coverClosing,
      chapterIndex,
      opening,
    ],
  );

  useLayoutEffect(() => {
    const frame = bookFrame.current;
    const cover = openingCover.current;
    if (
      !openingOrigin ||
      !frame ||
      !cover ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setOpening(false);
      return;
    }
    const rect = frame.getBoundingClientRect();
    const twoPages = window.innerWidth >= 800;
    const destination = {
      left: `${rect.left + (twoPages ? rect.width / 2 : 0)}px`,
      top: `${rect.top}px`,
      width: `${rect.width / (twoPages ? 2 : 1)}px`,
      height: `${rect.height}px`,
    };
    const move = cover.animate(
      [
        {
          left: `${openingOrigin.left}px`,
          top: `${openingOrigin.top}px`,
          width: `${openingOrigin.width}px`,
          height: `${openingOrigin.height}px`,
        },
        { offset: 0.45, ...destination },
        { ...destination },
      ],
      {
        duration: 1450,
        easing: "cubic-bezier(.22,.7,.15,1)",
        fill: "forwards",
      },
    );
    const leaf = cover.firstElementChild as HTMLElement;
    const open = leaf.animate(
      [{ transform: "rotateY(0deg)" }, { transform: "rotateY(-180deg)" }],
      {
        delay: 600,
        duration: 850,
        easing: "cubic-bezier(.3,.1,.15,1)",
        fill: "forwards",
      },
    );
    const reveal = frame.animate(
      [{ opacity: 0 }, { offset: 0.94, opacity: 0 }, { opacity: 1 }],
      { duration: 1450, fill: "forwards" },
    );
    const fade = cover.animate(
      [{ opacity: 1 }, { offset: 0.94, opacity: 1 }, { opacity: 0 }],
      {
        duration: 1450,
        fill: "forwards",
      },
    );
    const sound = setTimeout(
      () => playPaperSound("book_open", prefRef.current.sounds),
      600,
    );
    open.finished
      .then(() => {
        frame.style.opacity = "1";
        setOpening(false);
      })
      .catch(() => {});
    return () => {
      clearTimeout(sound);
      [move, open, reveal, fade].forEach((animation) => animation.cancel());
    };
  }, [openingOrigin]);

  useLayoutEffect(() => {
    if (!coverVisible || !closedCover.current) return;
    playPaperSound("book_open", prefRef.current.sounds);
    turnGeneration.current++;
    turnLayer.current?.replaceChildren();
    setTurn(null);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCoverClosing(false);
      return;
    }
    const leaf = closedCover.current.firstElementChild as HTMLElement;
    const animation = leaf.animate(
      [{ transform: "rotateY(-180deg)" }, { transform: "rotateY(0deg)" }],
      { duration: 850, easing: "cubic-bezier(.3,.1,.2,1)" },
    );
    animation.finished.then(() => setCoverClosing(false)).catch(() => {});
    return () => animation.cancel();
  }, [coverVisible]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => {
      const pages = window.innerWidth >= 800 ? 2 : 1;
      // Layout dimensions stay stable while the opening animation transforms the whole book.
      setGeometry({
        width: Math.max(160, (element.clientWidth - (pages - 1) * 56) / pages),
        height: Math.max(120, element.clientHeight),
        pages,
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = flow.current;
    if (!element) return;
    let disposed = false;
    const layout = () => {
      if (disposed) return;
      const count = Math.max(
        1,
        Math.round((element.scrollWidth + 56) / (geometry.width + 56)),
      );
      setColumns(count);
      const nodes = [
        ...element.querySelectorAll<HTMLElement>("[data-word-segment]"),
      ];
      const wanted =
        nodes.find(
          (n) =>
            n.dataset.wordSegment === anchor.current.segmentId &&
            n.dataset.wordLanguage === (anchor.current.language ?? "fr") &&
            Number(n.dataset.offset) >= anchor.current.offset,
        ) ??
        nodes
          .filter(
            (node) => node.dataset.wordSegment === anchor.current.segmentId,
          )
          .at(-1) ??
        nodes[0];
      const column = wanted
        ? Math.floor((wanted.offsetLeft + 1) / (geometry.width + 56))
        : 0;
      setSpread(Math.floor(column / geometry.pages));
    };
    const timer = requestAnimationFrame(layout);
    document.fonts.ready.then(layout);
    const images = [...element.querySelectorAll("img")];
    images.forEach((img) => img.addEventListener("load", layout));
    return () => {
      disposed = true;
      cancelAnimationFrame(timer);
      images.forEach((img) => img.removeEventListener("load", layout));
    };
  }, [
    geometry,
    preferences.fontSize,
    preferences.spacing,
    preferences.translation,
    chapterIndex,
  ]);
  useEffect(() => {
    pageRef.current = page;
    if (manualPage.current && !playingRef.current) {
      findAnchor();
      savePosition();
      manualPage.current = false;
    }
  }, [page, findAnchor, savePosition]);
  useEffect(() => {
    persist("preferences", preferences);
    if (audio.current) audio.current.playbackRate = preferences.speed;
  }, [preferences]);
  useEffect(() => {
    const interval = setInterval(savePosition, 1500);
    window.addEventListener("pagehide", savePosition);
    return () => {
      clearInterval(interval);
      savePosition();
      window.removeEventListener("pagehide", savePosition);
    };
  }, [savePosition]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).matches(
          'input, select, button, [role="button"]',
        )
      )
        return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        move(1);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        move(-1);
      }
      if (e.key === "Escape") {
        setPopup(null);
        setSettings(false);
        setContents(false);
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [move]);
  useEffect(() => {
    let frame: number;
    const tick = () => {
      if (audio.current && !audio.current.paused)
        setTime(audio.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!active || !playing) return;
    anchor.current = { segmentId: active.segmentId, offset: active.offset };
    const element = [
      ...(flow.current?.querySelectorAll<HTMLElement>(
        '[data-word-segment][data-word-language="fr"]',
      ) ?? []),
    ].find(
      (n) =>
        n.dataset.wordSegment === active.segmentId &&
        Number(n.dataset.offset) <= active.offset &&
        Number(n.dataset.offset) + (n.textContent?.length ?? 0) > active.offset,
    );
    if (element) {
      const next = Math.floor(
        Math.floor((element.offsetLeft + 1) / step) / geometry.pages,
      );
      const previous = Math.floor(pageRef.current / geometry.pages);
      if (next !== previous) {
        const player = audio.current;
        player?.pause();
        setTurnWaiting(true);
        clearTimeout(resumeTimer.current);
        animatePageTurn(next > previous ? 1 : -1, next);
        setSpread(next);
        // Hold the audio clock through the turn, then allow two seconds to find the text.
        const turnDuration = matchMedia("(prefers-reduced-motion: reduce)")
          .matches
          ? 0
          : 720;
        resumeTimer.current = setTimeout(() => {
          resumeTimer.current = undefined;
          setTurnWaiting(false);
          if (player && audio.current === player)
            player.play().catch(() => setAudioError(true));
        }, turnDuration + 2000);
      }
    }
  }, [
    active?.segmentId,
    active?.offset,
    playing,
    geometry.pages,
    step,
    animatePageTurn,
  ]);

  /** Switch chapters with a fresh stable anchor and explicit user-controlled playback. */
  function selectChapter(index: number, fromEnd = false) {
    pause();
    savePosition();
    setChapterIndex(index);
    setCoverVisible(false);
    setSpread(0);
    setTime(0);
    setDuration(book.chapters[index].audio?.duration ?? 0);
    setAudioError(false);
    pendingTime.current = 0;
    const target = fromEnd
      ? book.chapters[index].segments.at(-1)!
      : book.chapters[index].segments[0];
    anchor.current = {
      segmentId: target.id,
      offset: fromEnd ? target.fr.length : 0,
    };
    setContents(false);
    setPopup(null);
  }
  /** Reopen from the closed cover's actual right-page position. */
  function openClosedCover() {
    unlockPaperSounds(prefRef.current.sounds);
    const origin = closedCover.current?.getBoundingClientRect();
    setCoverVisible(false);
    if (origin) {
      setOpeningOrigin(origin);
      setOpening(true);
    }
  }
  /** Seek by approved word timings rather than estimating progress from text length. */
  function seekPassage(id: string) {
    const first = chapter.audio?.words.find((w) => w.segmentId === id);
    if (first && audio.current) {
      audio.current.currentTime = first.start;
      setTime(first.start);
      anchor.current = { segmentId: id, offset: first.offset };
    }
  }
  /** Request playback only after a gesture and keep failures out of the reading flow. */
  async function togglePlay() {
    unlockPaperSounds(prefRef.current.sounds);
    if (turnWaiting) {
      pause();
      return;
    }
    if (coverVisible) openClosedCover();
    if (!audio.current || !chapter.audio) {
      setNotice(
        "A narração deste capítulo está em preparação. A leitura já está disponível.",
      );
      return;
    }
    if (!audio.current.paused) {
      pause();
      return;
    }
    try {
      await audio.current.play();
      setAudioError(false);
    } catch {
      setAudioError(true);
    }
  }
  /** Apply word lookup while respecting touch users' need to pause and inspect. */
  function showLookup(value: Popup, deliberate: boolean) {
    clearTimeout(tooltipTimer.current);
    if (!deliberate && performance.now() - openingAt.current < 1000) return;
    setPopup(value);
    if (deliberate || matchMedia("(hover: none)").matches) pause();
  }
  /** Allow crossing to tooltip actions before dismissing a pointer or keyboard lookup. */
  function dismissLookup() {
    clearTimeout(tooltipTimer.current);
    tooltipTimer.current = setTimeout(() => setPopup(null), 180);
  }
  useEffect(() => () => clearTimeout(tooltipTimer.current), []);
  const chapterProgress =
    playing || time > 0
      ? Math.max(page / columns, duration ? time / duration : 0)
      : page / columns;
  const progress = Math.round(
    ((chapterIndex + chapterProgress) / book.chapters.length) * 100,
  );
  return (
    <div
      className={`reader-app ${preferences.theme === "night" ? "night" : ""} ${opening ? "is-opening" : ""}`}
    >
      <header className="reader-header">
        <button
          className="back-library"
          aria-label="A biblioteca"
          onClick={() => {
            pause();
            savePosition();
            onClose();
          }}
        >
          <ArrowLeft size={17} />
          <span>A biblioteca</span>
        </button>
        <div className="reader-book-title">
          <BookOpen size={17} strokeWidth={1.2} />
          <span>{book.title}</span>
          <span className="reader-title-author">{book.author}</span>
        </div>
        <div className="reader-tools">
          <button
            className={`icon-button ${contents ? "chosen" : ""}`}
            aria-label="Índice de capítulos"
            aria-expanded={contents}
            onClick={() => {
              setContents(!contents);
              setSettings(false);
            }}
          >
            <List size={20} />
          </button>
          <button
            className={`icon-button ${settings ? "chosen" : ""}`}
            aria-label="Ajustes de leitura"
            aria-expanded={settings}
            onClick={() => {
              setSettings(!settings);
              setContents(false);
            }}
          >
            <Settings2 size={19} />
          </button>
        </div>
      </header>
      <div className="reader-chapter-heading">
        <span className="eyebrow">{coverVisible ? "CAPA" : chapter.title}</span>
        <span className="chapter-subtitle">{chapter.subtitle}</span>
        <span className="reader-language">
          FRANÇAIS <span>·</span>{" "}
          {chapter.segments.some((s) => s.pt.trim())
            ? "PORTUGUÊS"
            : "TRADUÇÃO EM PREPARAÇÃO"}
        </span>
      </div>
      <main
        ref={bookFrame}
        className={`book-frame ${turn ? `turn-${turn}` : ""} ${coverVisible ? "is-cover-view" : ""} ${coverClosing ? "is-closing" : ""}`}
        aria-label={`Leitura de ${chapter.title}`}
      >
        <div ref={turnLayer} className="turn-layer" aria-hidden="true" inert />
        <span className="book-center" aria-hidden="true" />
        <div
          ref={viewport}
          className="page-viewport"
          onTouchStart={(e) => {
            (e.currentTarget as HTMLDivElement).dataset.touchStart =
              `${e.touches[0].clientX},${e.touches[0].clientY}`;
          }}
          onTouchEnd={(e) => {
            if ((e.target as HTMLElement).closest(".word")) return;
            const [x, y] = (e.currentTarget.dataset.touchStart ?? "0,0")
              .split(",")
              .map(Number);
            const dx = e.changedTouches[0].clientX - x;
            const dy = e.changedTouches[0].clientY - y;
            if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5)
              move(dx < 0 ? 1 : -1);
          }}
        >
          <div
            ref={flow}
            className="page-flow"
            onFocusCapture={(event) => {
              const target = event.target as HTMLElement;
              if (!target.dataset.wordSegment) return;
              const next = Math.floor(
                Math.floor((target.offsetLeft + 1) / step) / geometry.pages,
              );
              if (next !== spread) {
                pause();
                manualPage.current = true;
                setSpread(next);
              }
              if (viewport.current) viewport.current.scrollLeft = 0;
            }}
            style={
              {
                width: geometry.width,
                height: geometry.height,
                columnWidth: geometry.width,
                columnGap: 56,
                transform: `translateX(-${page * step}px)`,
                fontSize: preferences.fontSize,
                lineHeight: preferences.spacing,
              } as CSSProperties
            }
          >
            <div className="chapter-opening">
              <span className="chapter-ornament">✧</span>
              <h1>{chapter.title}</h1>
              <span>{chapter.subtitle}</span>
            </div>
            {chapter.segments.map((segment) => (
              <section
                className={`passage ${active?.segmentId === segment.id ? "active-passage" : ""}`}
                data-passage={segment.id}
                key={segment.id}
              >
                <p className="original-text" lang="fr">
                  <Words
                    book={book}
                    segment={segment}
                    language="fr"
                    active={active}
                    onLookup={showLookup}
                    onDismiss={dismissLookup}
                    highlight={
                      hoveredPair?.segmentId === segment.id
                        ? hoveredPair.fr
                        : undefined
                    }
                    onHighlight={(offset) => {
                      const pair =
                        offset === null
                          ? null
                          : pairedWords(book, segment, "fr", offset);
                      setHoveredPair(
                        pair ? { segmentId: segment.id, ...pair } : null,
                      );
                    }}
                  />
                </p>
                {preferences.translation && (
                  <p className="translated-text" lang="pt-BR">
                    <Words
                      book={book}
                      segment={segment}
                      language="pt"
                      onLookup={showLookup}
                      onDismiss={dismissLookup}
                      highlight={
                        hoveredPair?.segmentId === segment.id
                          ? hoveredPair.pt
                          : undefined
                      }
                      onHighlight={(offset) => {
                        const pair =
                          offset === null
                            ? null
                            : pairedWords(book, segment, "pt", offset);
                        setHoveredPair(
                          pair ? { segmentId: segment.id, ...pair } : null,
                        );
                      }}
                    />
                  </p>
                )}
                {[
                  ...(segment.image
                    ? [{ src: segment.image, alt: segment.imageAlt! }]
                    : []),
                  ...(segment.illustrations ?? []),
                ].map((image) => (
                  <figure className="story-illustration" key={image.src}>
                    <img
                      src={image.src}
                      alt={image.alt}
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                    <figcaption>{image.alt}</figcaption>
                  </figure>
                ))}
              </section>
            ))}
            <div className="chapter-ending">
              ✧<span>Fim do capítulo</span>
            </div>
          </div>
        </div>
        {coverVisible && (
          <button
            ref={closedCover}
            className="resting-cover"
            aria-label="Abrir capa na direita"
            onClick={openClosedCover}
          >
            <span className="closed-leaf">
              <span className="opening-front">
                <Cover book={book} />
              </span>
              <span className="opening-back">
                <span>✧</span>
              </span>
            </span>
          </button>
        )}
        <div className="page-numbers">
          <span>{page + 1}</span>
          <span>
            {geometry.pages === 2 && page + 2 <= columns ? page + 2 : ""}
          </span>
        </div>
      </main>
      <div className="page-navigation">
        <button
          disabled={coverVisible || opening || coverClosing}
          aria-label="Página anterior"
          onClick={() =>
            spread === 0 && chapterIndex > 0
              ? selectChapter(chapterIndex - 1, true)
              : move(-1)
          }
        >
          <ArrowLeft size={17} />{" "}
          <span>
            {spread === 0 && chapterIndex === 0 ? "Capa" : "Anterior"}
          </span>
        </button>
        <span>
          {chapterIndex + 1} de {book.chapters.length} capítulos{" "}
          <span className="nav-separator">·</span> {progress}% da leitura
        </span>
        <button
          disabled={
            opening ||
            coverClosing ||
            (!coverVisible &&
              spread >= totalSpreads - 1 &&
              chapterIndex >= book.chapters.length - 1)
          }
          aria-label="Próxima página"
          onClick={() =>
            !coverVisible &&
            spread >= totalSpreads - 1 &&
            chapterIndex < book.chapters.length - 1
              ? selectChapter(chapterIndex + 1)
              : move(1)
          }
        >
          <span>Próxima</span>
          <ArrowRight size={17} />
        </button>
      </div>
      <footer className="audio-player">
        <div className="audio-description">
          <span className="audio-icon">
            <Headphones size={21} strokeWidth={1.3} />
          </span>
          <div>
            <strong>{chapter.title}</strong>
            <span>
              {chapter.audio
                ? "Narração em francês · Azure Speech"
                : "Narração em preparação"}
            </span>
          </div>
        </div>
        <div className="player-main">
          <div className="playback-buttons">
            <button
              className="icon-button"
              aria-label="Repetir frase atual"
              disabled={!chapter.audio}
              onClick={() => {
                const word =
                  active ?? chapter.audio?.words.find((w) => w.start >= time);
                if (word) seekPassage(word.segmentId);
              }}
            >
              <Repeat2 size={19} />
            </button>
            <button
              className="icon-button mobile-chapter-control"
              aria-label="Chapitre précédent"
              disabled={chapterIndex === 0}
              onClick={() => selectChapter(chapterIndex - 1)}
            >
              <SkipBack size={23} fill="currentColor" />
            </button>
            <button
              className="play-button"
              aria-label={
                playing || turnWaiting
                  ? "Pausar narração"
                  : "Reproduzir narração"
              }
              onClick={togglePlay}
            >
              {playing || turnWaiting ? (
                <Pause size={19} fill="currentColor" />
              ) : (
                <Play size={19} fill="currentColor" />
              )}
            </button>
            <button
              className="icon-button mobile-chapter-control"
              aria-label="Chapitre suivant"
              disabled={chapterIndex === book.chapters.length - 1}
              onClick={() => selectChapter(chapterIndex + 1)}
            >
              <SkipForward size={23} fill="currentColor" />
            </button>
            <button
              className="speed-button"
              aria-label={`Velocidade ${preferences.speed} vezes. Alterar`}
              onClick={() =>
                setPreferences((p) => ({
                  ...p,
                  speed:
                    p.speed >= 2
                      ? 0.5
                      : Math.round((p.speed + 0.25) * 100) / 100,
                }))
              }
            >
              {preferences.speed}×
            </button>
          </div>
          <div className="audio-timeline">
            <span>{clock(time)}</span>
            <input
              aria-label="Posição do áudio"
              type="range"
              min="0"
              max={duration || 1}
              step="0.05"
              value={Math.min(time, duration || 1)}
              style={
                {
                  "--audio-progress": `${duration ? Math.min(100, (time / duration) * 100) : 0}%`,
                } as CSSProperties
              }
              disabled={!chapter.audio}
              onChange={(e) => {
                if (turnWaiting) pause();
                const value = Number(e.target.value);
                if (audio.current) audio.current.currentTime = value;
                setTime(value);
              }}
            />
            <span>{clock(duration)}</span>
          </div>
          {turnWaiting && (
            <span className="page-turn-status" role="status">
              Encontre o texto · retomando em instantes
            </span>
          )}
        </div>
        <div className="audio-right">
          <Volume2 size={17} strokeWidth={1.4} />
          <span>NO SEU RITMO</span>
        </div>
        <audio
          key={chapter.id + (chapter.audio?.fingerprint ?? "")}
          ref={audio}
          src={chapter.audio?.src}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const player = e.currentTarget;
            player.playbackRate = prefRef.current.speed;
            player.preservesPitch = true;
            setDuration(
              Number.isFinite(player.duration)
                ? player.duration
                : (chapter.audio?.duration ?? 0),
            );
            player.currentTime = Math.min(
              pendingTime.current,
              Number.isFinite(player.duration)
                ? player.duration
                : pendingTime.current,
            );
            pendingTime.current = 0;
          }}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onPlay={() => {
            playingRef.current = true;
            setPlaying(true);
          }}
          onPause={() => {
            playingRef.current = false;
            setPlaying(false);
            savePosition();
          }}
          onEnded={() => {
            playingRef.current = false;
            setPlaying(false);
            if (chapterIndex < book.chapters.length - 1)
              setNotice(
                "Capítulo concluído. Escolha o próximo capítulo para continuar.",
              );
          }}
          onError={() => setAudioError(true)}
        />
      </footer>
      {(notice || audioError) && (
        <div className="reader-notice" role="status">
          <span>
            {audioError
              ? "Não foi possível carregar a narração. Você pode continuar lendo e tentar novamente."
              : notice}
          </span>
          <button
            className="icon-button"
            aria-label="Fechar aviso"
            onClick={() => {
              setNotice("");
              setAudioError(false);
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {settings && (
        <aside
          className="reader-panel settings-panel"
          aria-label="Preferências de leitura"
        >
          <div className="panel-title">
            <h2>Seu jeito de ler</h2>
            <button
              className="icon-button"
              aria-label="Fechar ajustes"
              onClick={() => setSettings(false)}
            >
              <X size={18} />
            </button>
          </div>
          <label>
            Tamanho do texto <span>{preferences.fontSize}px</span>
            <input
              aria-label="Tamanho da fonte"
              type="range"
              min="16"
              max="30"
              value={preferences.fontSize}
              onChange={(e) => {
                findAnchor();
                setPreferences((p) => ({
                  ...p,
                  fontSize: Number(e.target.value),
                }));
              }}
            />
          </label>
          <label>
            Espaçamento <span>{preferences.spacing.toFixed(1)}</span>
            <input
              aria-label="Espaçamento entre linhas"
              type="range"
              min="1.4"
              max="2.2"
              step="0.1"
              value={preferences.spacing}
              onChange={(e) => {
                findAnchor();
                setPreferences((p) => ({
                  ...p,
                  spacing: Number(e.target.value),
                }));
              }}
            />
          </label>
          <label className="translation-toggle">
            Tradução em português
            <input
              type="checkbox"
              checked={preferences.translation}
              onChange={(e) => {
                findAnchor();
                setPreferences((p) => ({
                  ...p,
                  translation: e.target.checked,
                }));
              }}
            />
            <span className="toggle-track" />
          </label>
          <label className="translation-toggle">
            Som de papel
            <input
              type="checkbox"
              checked={preferences.sounds}
              onChange={(event) =>
                setPreferences((previous) => ({
                  ...previous,
                  sounds: event.target.checked,
                }))
              }
            />
            <span className="toggle-track" />
          </label>
          <div className="theme-options">
            <button
              className={preferences.theme === "paper" ? "chosen" : ""}
              onClick={() => setPreferences((p) => ({ ...p, theme: "paper" }))}
            >
              <Sun size={17} /> Papel{" "}
              {preferences.theme === "paper" && <Check size={13} />}
            </button>
            <button
              className={preferences.theme === "night" ? "chosen" : ""}
              onClick={() => setPreferences((p) => ({ ...p, theme: "night" }))}
            >
              <Moon size={17} /> Noite{" "}
              {preferences.theme === "night" && <Check size={13} />}
            </button>
          </div>
          <p>Suas preferências ficam salvas neste navegador.</p>
        </aside>
      )}
      {contents && (
        <aside className="reader-panel contents-panel" aria-label="Capítulos">
          <div className="panel-title">
            <h2>Entre capítulos</h2>
            <button
              className="icon-button"
              aria-label="Fechar índice"
              onClick={() => setContents(false)}
            >
              <X size={18} />
            </button>
          </div>
          <div className="contents-list">
            {book.chapters.map((c, i) => (
              <button
                key={c.id}
                className={i === chapterIndex ? "current" : ""}
                onClick={() => selectChapter(i)}
              >
                <span>{(i + 1).toString().padStart(2, "0")}</span>
                <div>
                  <strong>{c.title}</strong>
                  <small>{c.subtitle}</small>
                </div>
                {i === chapterIndex && <span className="status-dot" />}
              </button>
            ))}
          </div>
        </aside>
      )}
      {popup && (
        <aside
          className="word-popup"
          onMouseEnter={() => clearTimeout(tooltipTimer.current)}
          onMouseLeave={() => {
            if (matchMedia("(hover: hover)").matches) dismissLookup();
          }}
          onFocusCapture={() => clearTimeout(tooltipTimer.current)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              dismissLookup();
          }}
          role="dialog"
          aria-label="Tradução contextual"
          style={{
            left: Math.max(154, Math.min(window.innerWidth - 154, popup.x)),
            top: Math.max(
              82,
              Math.min(window.innerHeight - 240, popup.y - 160),
            ),
          }}
        >
          <div className="popup-languages">
            {popup.language === "fr"
              ? "FRANÇAIS → PORTUGUÊS"
              : "PORTUGUÊS → FRANÇAIS"}
            <button
              className="icon-button"
              aria-label="Fechar tradução"
              onClick={() => setPopup(null)}
            >
              <X size={14} />
            </button>
          </div>
          <strong>{popup.source}</strong>
          <p>{popup.target}</p>
          <small>{popup.note}</small>
          {chapter.audio && (
            <button
              className="text-button"
              onClick={() => {
                pause();
                seekPassage(popup.segmentId);
                setPopup(null);
                void audio.current?.play().catch(() => setAudioError(true));
              }}
            >
              <Headphones size={13} /> Ouvir esta frase
            </button>
          )}
        </aside>
      )}
      {opening && openingOrigin && (
        <div
          ref={openingCover}
          className="opening-cover"
          aria-hidden="true"
          style={{
            left: openingOrigin.left,
            top: openingOrigin.top,
            width: openingOrigin.width,
            height: openingOrigin.height,
          }}
        >
          <div className="opening-leaf">
            <div className="opening-front">
              <Cover book={book} />
            </div>
            <div className="opening-back">
              <span>✧</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
