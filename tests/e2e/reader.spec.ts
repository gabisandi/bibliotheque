import { test, expect } from "@playwright/test";

test("hover links the translation while only a click opens the tooltip", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Ver capa de Le Petit Prince" })
    .click();
  await page
    .getByRole("button", { name: "Abrir o livro", exact: true })
    .click();
  const word = page.getByRole("button", {
    name: "Consultar Lorsque",
    exact: true,
  });
  if (isMobile) {
    await word.tap();
    await expect(
      page.getByRole("dialog", { name: "Tradução contextual" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Fechar tradução" }).click();
  } else {
    await page.waitForTimeout(1600);
    await word.hover();
    await expect(
      page.getByRole("dialog", { name: "Tradução contextual" }),
    ).toBeHidden();
    await expect(
      page.locator(".translated-text .paired-word").first(),
    ).toBeVisible();
    await word.click();
    await expect(
      page.getByRole("dialog", { name: "Tradução contextual" }),
    ).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(
      page.getByRole("dialog", { name: "Tradução contextual" }),
    ).toBeHidden();
  }
});

test("reader preserves text while reflowing, consulting a word and restoring a bookmark", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Ver capa de Le Petit Prince" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Le Petit Prince" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Abrir o livro", exact: true })
    .click();
  await expect(page.locator(".book-frame")).toBeVisible();
  await expect
    .poll(async () =>
      page.locator(".page-viewport").evaluate((el) => {
        const flow = el.querySelector(".page-flow") as HTMLElement;
        const expected =
          innerWidth >= 800 ? (el.clientWidth - 56) / 2 : el.clientWidth;
        return Math.abs(flow.clientWidth - expected) < 2;
      }),
    )
    .toBe(true);
  const before = await page.locator(".original-text").allTextContents();
  await expect(
    page.getByRole("button", { name: "Consultar Lorsque", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Consultar Lorsque", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Tradução contextual" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Fechar tradução" }).click();
  await page.getByRole("button", { name: "Ajustes de leitura" }).click();
  await page.getByRole("slider", { name: "Tamanho da fonte" }).fill("28");
  await page.getByRole("button", { name: "Fechar ajustes" }).click();
  await expect(page.locator(".page-flow")).toHaveCSS("font-size", "28px");
  expect(await page.locator(".original-text").allTextContents()).toEqual(
    before,
  );
  await page.getByRole("button", { name: "Próxima página" }).click();
  await expect(
    page.getByRole("button", { name: "Página anterior" }),
  ).toBeEnabled();
  const bookmarkedPage = await page
    .locator(".page-numbers > span")
    .first()
    .textContent();
  await page.getByRole("button", { name: "A biblioteca", exact: true }).click();
  await page
    .getByRole("button", { name: "Ver capa de Le Petit Prince" })
    .click();
  await page.getByRole("button", { name: "Continuar a leitura" }).click();
  await expect(page.locator(".page-flow")).toHaveCSS("font-size", "28px");
  await expect(page.locator(".page-numbers > span").first()).toHaveText(
    bookmarkedPage!,
  );
  expect(errors).toEqual([]);
});

test("missing audio leaves the literary text usable", async ({ page }) => {
  await page.route("**/manifest.json", async (route) => {
    const response = await route.fetch();
    const book = await response.json();
    for (const chapter of book.chapters) delete chapter.audio;
    await route.fulfill({ response, json: book });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Ver capa de Le Petit Prince" })
    .click();
  await page
    .getByRole("button", { name: "Abrir o livro", exact: true })
    .click();
  await page.getByRole("button", { name: "Reproduzir narração" }).click();
  await expect(page.getByRole("status")).toContainText("preparação");
  await expect(page.locator(".original-text").first()).toContainText("Lorsque");
});

test("saved narration follows playback, seeking and speed changes without generated timers", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Ver capa de Le Petit Prince" })
    .click();
  await page
    .getByRole("button", { name: "Abrir o livro", exact: true })
    .click();
  const player = page.locator("audio");
  await expect
    .poll(() => player.evaluate((el: HTMLAudioElement) => el.readyState))
    .toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "Reproduzir narração" }).click();
  await expect
    .poll(() => page.locator(".word.spoken").count())
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Velocidade 1 vezes. Alterar", exact: true })
    .click();
  expect(await player.evaluate((el: HTMLAudioElement) => el.playbackRate)).toBe(
    1.25,
  );
  expect(
    await player.evaluate((el: HTMLAudioElement) => el.preservesPitch),
  ).toBe(true);
  await page.getByRole("slider", { name: "Posição do áudio" }).fill("75");
  await expect
    .poll(() => player.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBeGreaterThanOrEqual(75);
  await expect
    .poll(() => page.locator(".word.spoken").count())
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pausar narração" }).click();
  const time = await player.evaluate((el: HTMLAudioElement) => el.currentTime);
  await page.getByRole("button", { name: "Próxima página" }).click();
  expect(await player.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  expect(
    await player.evaluate((el: HTMLAudioElement) => el.currentTime),
  ).toBeCloseTo(time, 0);
});

test("the actual book is centred and fully visible without scrolling", async ({
  page,
}) => {
  await page.goto("/");
  const book = page.getByRole("button", {
    name: "Ver capa de Le Petit Prince",
  });
  await expect(book).toBeVisible();
  const box = await book.boundingBox();
  const last = await page.locator(".shelf-book").last().boundingBox();
  const size = page.viewportSize()!;
  expect(box!.y + box!.height).toBeLessThan(size.height);
  expect(
    Math.abs((box!.x + last!.x + last!.width) / 2 - size.width / 2),
  ).toBeLessThan(12);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(last!.x + last!.width).toBeLessThanOrEqual(size.width);
  await expect(page.locator(".volume-count")).toContainText("02");
});

test("Arsène Lupin opens the complete first story and identifies unavailable narration", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Ver capa de Arsène Lupin", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Arsène Lupin", exact: true }),
  ).toContainText("Áudio em preparação");
  await page
    .getByRole("button", { name: "Abrir o livro", exact: true })
    .click();
  await expect(page.locator(".reader-language")).toContainText(
    "TRADUÇÃO EM PREPARAÇÃO",
  );
  await expect(page.locator(".original-text").first()).toContainText(
    "L'étrange voyage!",
  );
  await page.getByRole("button", { name: "Reproduzir narração" }).click();
  await expect(page.getByRole("status")).toContainText("preparação");
});

test("backward navigation reaches the right-hand cover and reopens the beginning", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Ver capa de Le Petit Prince" })
    .click();
  await page
    .getByRole("button", { name: "Abrir o livro", exact: true })
    .click();
  await expect(page.locator(".opening-cover")).toBeHidden();
  await page.getByRole("button", { name: "Página anterior" }).click();
  const cover = page.getByRole("button", { name: "Abrir capa na direita" });
  await expect(cover).toBeVisible();
  await expect(page.locator(".book-frame.is-closing")).toBeHidden();
  const bounds = await cover.boundingBox();
  const frame = await page.locator(".book-frame").boundingBox();
  if (!isMobile) expect(bounds!.x).toBeCloseTo(frame!.x + frame!.width / 2, 0);
  await expect(
    page.getByRole("button", { name: "Página anterior" }),
  ).toBeDisabled();
  await cover.click();
  await expect(page.locator(".opening-cover")).toBeHidden();
  await expect(page.locator(".page-numbers > span").first()).toHaveText("1");
  await expect(
    page.getByRole("button", { name: "Consultar Lorsque", exact: true }),
  ).toBeVisible();
});

test("automatic page turns hold the real audio clock and manual pause cancels resuming", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Ver capa de Le Petit Prince" })
    .click();
  await page
    .getByRole("button", { name: "Abrir o livro", exact: true })
    .click();
  await expect(page.locator(".opening-cover")).toBeHidden();
  const audio = page.locator("audio");
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState))
    .toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "Reproduzir narração" }).click();
  await page.getByRole("slider", { name: "Posição do áudio" }).fill("75");
  await expect(page.locator(".page-turn-status")).toBeVisible();
  const held = await audio.evaluate((el: HTMLAudioElement) => el.currentTime);
  await page.waitForTimeout(1700);
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  expect(
    await audio.evaluate((el: HTMLAudioElement) => el.currentTime),
  ).toBeCloseTo(held, 2);
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.paused))
    .toBe(false);
  await page.getByRole("slider", { name: "Posição do áudio" }).fill("5");
  await expect(page.locator(".page-turn-status")).toBeVisible();
  await page.getByRole("button", { name: "Pausar narração" }).click();
  await page.waitForTimeout(3000);
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
});

test("mobile player centres playback and keeps progress below the controls", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Touch player layout");
  await page.goto("/");
  await page
    .getByRole("button", { name: "Ver capa de Le Petit Prince" })
    .click();
  await page
    .getByRole("button", { name: "Abrir o livro", exact: true })
    .click();
  const play = await page
    .getByRole("button", { name: "Reproduzir narração" })
    .boundingBox();
  const timeline = await page.locator(".audio-timeline").boundingBox();
  expect(
    Math.abs(play!.x + play!.width / 2 - page.viewportSize()!.width / 2),
  ).toBeLessThan(2);
  expect(play!.width).toBeGreaterThanOrEqual(44);
  expect(
    (await page.locator(".audio-player").boundingBox())!.height,
  ).toBeLessThanOrEqual(110);
  expect(timeline!.y).toBeGreaterThan(play!.y + play!.height);
});
