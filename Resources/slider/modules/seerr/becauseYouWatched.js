import { getSessionInfo, makeApiRequest } from "../../../Plugins/JMSFusion/runtime/api.js";
import { getConfig } from "../config.js";
import { getLanguageLabels, getEffectiveLanguage } from "../../language/index.js";
import { getSerrAccess, getSerrRecommendations } from "./api.js";
import { createSerrPosterCard, ensureDiscoverStyles, serrResultMediaType } from "./discover.js";

// "Because you watched X" rows built from Seerr recommendations for the user's
// recently watched titles, ranked against the genres they watch most.

const WRAPPER_ID = "monwui-serr-byw";
const CACHE_MS = 15 * 60 * 1000;
const MIN_ROW_ITEMS = 4;

// TMDb genre ids (movie and TV) to the names Jellyfin stores from TMDb metadata.
const TMDB_GENRES = {
  28: ["action", "action & adventure"],
  12: ["adventure", "action & adventure"],
  16: ["animation"],
  35: ["comedy"],
  80: ["crime"],
  99: ["documentary"],
  18: ["drama"],
  10751: ["family"],
  14: ["fantasy", "sci-fi & fantasy"],
  36: ["history"],
  27: ["horror"],
  10402: ["music"],
  9648: ["mystery"],
  10749: ["romance"],
  878: ["science fiction", "sci-fi & fantasy", "sci-fi"],
  10770: ["tv movie"],
  53: ["thriller"],
  10752: ["war", "war & politics"],
  37: ["western"],
  10759: ["action & adventure", "action", "adventure"],
  10762: ["kids"],
  10763: ["news"],
  10764: ["reality"],
  10765: ["sci-fi & fantasy", "science fiction", "fantasy"],
  10766: ["soap"],
  10767: ["talk"],
  10768: ["war & politics", "war"]
};

let booted = false;
let observer = null;
let syncTimer = 0;
let cache = null;
let building = null;

function labels() {
  const cfg = getConfig() || {};
  return cfg.languageLabels || getLanguageLabels(getEffectiveLanguage()) || {};
}

function becauseTitle(name) {
  const tpl = labels()?.becauseYouWatched;
  const template = typeof tpl === "string" && tpl.includes("{title}") ? tpl : "Because you watched {title}";
  return template.replace("{title}", name);
}

function clampSetting(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function userId() {
  return getSessionInfo()?.userId || window.ApiClient?.getCurrentUserId?.() || "";
}

function itemsQuery(params) {
  const qs = new URLSearchParams({ userId: userId(), Recursive: "true", EnableImages: "false", ...params });
  return `/Items?${qs.toString()}`;
}

function tmdbIdOf(item) {
  const ids = item?.ProviderIds || {};
  const raw = ids.Tmdb ?? ids.tmdb ?? ids.TMDB ?? "";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function lastPlayed(item) {
  return Date.parse(item?.UserData?.LastPlayedDate || "") || 0;
}

async function loadHistory() {
  const fields = "ProviderIds,Genres,SeriesId,UserData";
  const [played, resumable] = await Promise.all([
    makeApiRequest(itemsQuery({
      IncludeItemTypes: "Movie,Episode",
      Filters: "IsPlayed",
      SortBy: "DatePlayed",
      SortOrder: "Descending",
      Limit: "200",
      Fields: fields
    })).catch(() => ({ Items: [] })),
    makeApiRequest(itemsQuery({
      IncludeItemTypes: "Movie,Episode",
      Filters: "IsResumable",
      SortBy: "DatePlayed",
      SortOrder: "Descending",
      Limit: "20",
      Fields: fields
    })).catch(() => ({ Items: [] }))
  ]);

  const byId = new Map();
  for (const item of [...(resumable?.Items || []), ...(played?.Items || [])]) {
    if (item?.Id && !byId.has(item.Id)) byId.set(item.Id, item);
  }
  const items = [...byId.values()].sort((a, b) => lastPlayed(b) - lastPlayed(a));

  const seriesIds = [...new Set(items.filter((i) => i.Type === "Episode" && i.SeriesId).map((i) => i.SeriesId))];
  const series = new Map();
  for (let i = 0; i < seriesIds.length; i += 50) {
    const batch = seriesIds.slice(i, i + 50);
    const res = await makeApiRequest(itemsQuery({ Ids: batch.join(","), Fields: "ProviderIds,Genres" })).catch(() => ({ Items: [] }));
    for (const s of res?.Items || []) series.set(s.Id, s);
  }

  return { items, series };
}

function buildProfile({ items, series }) {
  const genreWeights = new Map();
  const watched = new Set();
  const seeds = [];
  const seedKeys = new Set();

  items.forEach((item, index) => {
    const isEpisode = item.Type === "Episode";
    const source = isEpisode ? series.get(item.SeriesId) : item;
    if (!source) return;
    const mediaType = isEpisode ? "tv" : "movie";
    const tmdbId = tmdbIdOf(source);
    // Recent history counts more towards the genre profile.
    const recency = 1 / (1 + index / 25);
    for (const genre of source.Genres || []) {
      const key = String(genre).toLowerCase();
      genreWeights.set(key, (genreWeights.get(key) || 0) + recency);
    }
    if (!tmdbId) return;
    const key = `${mediaType}:${tmdbId}`;
    if (item.UserData?.Played || !isEpisode) watched.add(key);
    if (!seedKeys.has(key)) {
      seedKeys.add(key);
      seeds.push({ key, mediaType, tmdbId, name: source.Name || item.SeriesName || item.Name || "" });
    }
  });

  const total = [...genreWeights.values()].reduce((a, b) => a + b, 0) || 1;
  for (const [k, v] of genreWeights) genreWeights.set(k, v / total);
  return { genreWeights, watched, seeds };
}

function genreScore(result, genreWeights) {
  let score = 0;
  const counted = new Set();
  for (const id of result?.genreIds || []) {
    for (const name of TMDB_GENRES[id] || []) {
      if (counted.has(name)) continue;
      counted.add(name);
      score += genreWeights.get(name) || 0;
    }
  }
  return score;
}

async function buildRows() {
  const cfg = getConfig() || {};
  const rowCount = clampSetting(cfg.becauseYouWatchedRowCount, 1, 6, 3);
  const cardCount = clampSetting(cfg.becauseYouWatchedCardCount, MIN_ROW_ITEMS, 30, 15);

  const access = await getSerrAccess();
  if (access?.serrEnabled !== true) return { access, rows: [] };
  const language = access?.settings?.defaultLanguage || "";

  const profile = buildProfile(await loadHistory());
  const seeds = profile.seeds.slice(0, rowCount + 2);
  const responses = await Promise.all(
    seeds.map((seed) => getSerrRecommendations(seed.mediaType, seed.tmdbId, { language }).catch(() => null))
  );

  const occurrences = new Map();
  const candidateLists = responses.map((data) =>
    (Array.isArray(data?.results) ? data.results : []).filter((r) => serrResultMediaType(r) && r?.posterPath)
  );
  for (const list of candidateLists) {
    for (const r of list) {
      const key = `${serrResultMediaType(r)}:${r.id}`;
      occurrences.set(key, (occurrences.get(key) || 0) + 1);
    }
  }

  const shown = new Set(profile.watched);
  const rows = [];
  seeds.forEach((seed, seedIndex) => {
    if (rows.length >= rowCount) return;
    const list = candidateLists[seedIndex] || [];
    const scored = list
      .map((r, i) => {
        const key = `${serrResultMediaType(r)}:${r.id}`;
        const rank = 1 - i / Math.max(1, list.length);
        const score = rank
          + 2 * genreScore(r, profile.genreWeights)
          + 0.3 * ((occurrences.get(key) || 1) - 1)
          + 0.1 * (Number(r?.voteAverage) || 0) / 10;
        return { r, key, score };
      })
      .filter(({ key }) => !shown.has(key))
      .sort((a, b) => b.score - a.score)
      .slice(0, cardCount);
    if (scored.length < MIN_ROW_ITEMS) return;
    scored.forEach(({ key }) => shown.add(key));
    rows.push({ seed, results: scored.map(({ r }) => r) });
  });

  return { access, rows };
}

async function getRows() {
  const uid = userId();
  if (cache && cache.uid === uid && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (building) return building;
  building = buildRows()
    .then((value) => {
      cache = { uid, at: Date.now(), value };
      return value;
    })
    .finally(() => { building = null; });
  return building;
}

function homeContainer() {
  const hash = String(window.location.hash || "");
  if (hash && !/^#\/?(home|index)/i.test(hash.replace(/^#!/, "#"))) return null;
  return document.querySelector("#indexPage:not(.hide) .homeSectionsContainer, #homePage:not(.hide) .homeSectionsContainer");
}

function renderWrapper({ access, rows }) {
  ensureDiscoverStyles();
  const wrapper = document.createElement("div");
  wrapper.id = WRAPPER_ID;
  rows.forEach(({ seed, results }, i) => {
    const section = document.createElement("div");
    section.className = "homeSection monwui-serr-byw-row";
    section.id = `monwui-serr-byw--${i}`;
    section.innerHTML = `
      <div class="sectionTitleContainer sectionTitleContainer-cards padded-left">
        <h2 class="sectionTitle sectionTitle-cards"></h2>
      </div>
      <div class="monwui-discover-row"></div>
    `;
    section.querySelector("h2").textContent = becauseTitle(seed.name);
    const row = section.querySelector(".monwui-discover-row");
    results.forEach((r) => row.appendChild(createSerrPosterCard(r, { access, source: "because-you-watched" })));
    wrapper.appendChild(section);
  });
  return wrapper;
}

function placeWrapper(container, wrapper) {
  const anchor = container.querySelector("#personal-recommendations");
  if (anchor?.parentElement === container) {
    anchor.insertAdjacentElement("afterend", wrapper);
  } else {
    container.prepend(wrapper);
  }
}

async function sync() {
  const container = homeContainer();
  if (!container || container.querySelector(`#${WRAPPER_ID}`)) return;
  const value = await getRows().catch(() => null);
  if (!value?.rows?.length) return;
  const current = homeContainer();
  if (!current || current.querySelector(`#${WRAPPER_ID}`)) return;
  document.querySelectorAll(`#${WRAPPER_ID}`).forEach((node) => node.remove());
  placeWrapper(current, renderWrapper(value));
}

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync().catch(() => {}), 400);
}

function invalidate() {
  // Cards already show "Requested"; rebuild on the next home visit.
  cache = null;
}

export function initSerrBecauseYouWatched() {
  const cfg = getConfig() || {};
  if (booted || cfg.enableHomeSectionsMaster === false || cfg.enableBecauseYouWatched === false) return null;
  booted = true;

  observer = new MutationObserver(() => {
    const container = homeContainer();
    if (container && !container.querySelector(`#${WRAPPER_ID}`)) scheduleSync();
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  window.addEventListener("hashchange", scheduleSync);
  window.addEventListener("monwui:serr-requests-changed", invalidate);
  scheduleSync();

  return () => {
    booted = false;
    observer?.disconnect?.();
    observer = null;
    clearTimeout(syncTimer);
    window.removeEventListener("hashchange", scheduleSync);
    window.removeEventListener("monwui:serr-requests-changed", invalidate);
    document.querySelectorAll(`#${WRAPPER_ID}`).forEach((node) => node.remove());
  };
}
