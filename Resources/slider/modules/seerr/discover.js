import { getSessionInfo } from "../../../Plugins/JMSFusion/runtime/api.js";
import { getConfig } from "../config.js";
import { getLanguageLabels, getEffectiveLanguage } from "../../language/index.js";
import { discoverSerr, getSerrAccess } from "./api.js";
import { ensureSerrStyles } from "./styles.js";
import { requestSerrResult } from "./ui.js";

const MODAL_ID = "monwuiSerrDiscoverModal";
const STYLE_ID = "monwui-serr-discover-styles";
const NAV_CLASS = "monwui-discover-nav-button";
const WATCHLIST_NAV_CLASS = "monwui-watchlist-nav-button";
const COMPASS_PATH = "M12 10.9c-.61 0-1.1.49-1.1 1.1s.49 1.1 1.1 1.1c.61 0 1.1-.49 1.1-1.1s-.49-1.1-1.1-1.1M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m2.19 12.19L6 18l3.81-8.19L18 6z";

const CATEGORIES = [
  { key: "trending", label: ["serrDiscoverTrending", "Trending"] },
  { key: "movies", label: ["serrDiscoverPopularMovies", "Popular Movies"] },
  { key: "movies-upcoming", label: ["serrDiscoverUpcomingMovies", "Upcoming Movies"] },
  { key: "tv", label: ["serrDiscoverPopularTv", "Popular Shows"] },
  { key: "tv-upcoming", label: ["serrDiscoverUpcomingTv", "Upcoming Shows"] }
];

// Seerr MediaStatus: 1 unknown, 2 pending, 3 processing, 4 partially available, 5 available.
const STATUS_PENDING = 2;
const STATUS_PROCESSING = 3;
const STATUS_PARTIAL = 4;
const STATUS_AVAILABLE = 5;

let booted = false;
let observer = null;
let navTimer = 0;
let accessAllowed = null;

function labels() {
  const cfg = getConfig() || {};
  return cfg.languageLabels || getLanguageLabels(getEffectiveLanguage()) || {};
}

function L(key, fallback) {
  const value = labels()?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function serrResultMediaType(result) {
  const type = String(result?.mediaType || result?.media_type || "").toLowerCase();
  return type === "movie" || type === "tv" ? type : "";
}

export function serrResultTitle(result) {
  return String(result?.title || result?.name || result?.originalTitle || result?.originalName || "").trim();
}

function resultYear(result) {
  const raw = String(result?.releaseDate || result?.firstAirDate || "");
  return /^\d{4}/.test(raw) ? raw.slice(0, 4) : "";
}

function posterUrl(result) {
  const path = String(result?.posterPath || "");
  return path ? `https://image.tmdb.org/t/p/w342${path}` : "";
}

function jellyfinDetailsHref(result) {
  const id = String(result?.mediaInfo?.jellyfinMediaId || result?.mediaInfo?.jellyfinMediaId4k || "").trim();
  if (!id) return "";
  const serverId = getSessionInfo()?.serverId || window.ApiClient?.serverId?.() || "";
  return `#/details?id=${encodeURIComponent(id)}${serverId ? `&serverId=${encodeURIComponent(serverId)}` : ""}`;
}

/**
 * Builds a poster card with the right action for the item's Seerr status:
 * open in Jellyfin when available, "Requested" when pending, otherwise a Request button.
 */
export function createSerrPosterCard(result, { access = null, source = "discover", onNavigate = null } = {}) {
  const mediaType = serrResultMediaType(result);
  const title = serrResultTitle(result);
  const year = resultYear(result);
  const img = posterUrl(result);
  const status = Number(result?.mediaInfo?.status || 0);
  const href = jellyfinDetailsHref(result);
  const available = status === STATUS_AVAILABLE || (status === STATUS_PARTIAL && mediaType === "movie");
  const requested = status === STATUS_PENDING || status === STATUS_PROCESSING;

  const card = document.createElement("article");
  card.className = "monwui-discover-card";
  const poster = img
    ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" decoding="async">`
    : `<div class="monwui-discover-poster-fallback">${escapeHtml(title)}</div>`;
  const badge = available
    ? `<span class="monwui-discover-badge available">${escapeHtml(L("serrDiscoverInLibrary", "In library"))}</span>`
    : requested
      ? `<span class="monwui-discover-badge requested">${escapeHtml(L("serrStatusRequested", "Requested"))}</span>`
      : "";
  const typeLabel = mediaType === "tv" ? L("serrDiscoverShow", "Show") : L("serrDiscoverMovie", "Movie");

  card.innerHTML = `
    <${available && href ? `a href="${escapeHtml(href)}"` : "div"} class="monwui-discover-poster">
      ${poster}
      ${badge}
    </${available && href ? "a" : "div"}>
    <div class="monwui-discover-name" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
    <div class="monwui-discover-meta">${escapeHtml([typeLabel, year].filter(Boolean).join(" · "))}</div>
    <div class="monwui-discover-action"></div>
  `;

  const action = card.querySelector(".monwui-discover-action");
  if (available) {
    if (href) {
      const open = document.createElement("a");
      open.className = "monwui-serr-btn monwui-discover-open";
      open.href = href;
      open.innerHTML = `<i class="fas fa-play" aria-hidden="true"></i><span>${escapeHtml(L("serrDiscoverOpen", "Open"))}</span>`;
      action.appendChild(open);
    }
    if (typeof onNavigate === "function") {
      card.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => onNavigate()));
    }
  } else if (requested) {
    action.innerHTML = `<button type="button" class="monwui-serr-btn monwui-discover-done" disabled><i class="fas fa-check" aria-hidden="true"></i><span>${escapeHtml(L("serrStatusRequested", "Requested"))}</span></button>`;
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "monwui-serr-btn";
    btn.innerHTML = `<i class="fas fa-paper-plane" aria-hidden="true"></i><span>${escapeHtml(L("serrRequestButton", "Request"))}</span>`;
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const ok = await requestSerrResult(result, btn, { access, source }).catch(() => false);
      if (ok === true) {
        btn.disabled = true;
        btn.classList.add("monwui-discover-done");
        btn.innerHTML = `<i class="fas fa-check" aria-hidden="true"></i><span>${escapeHtml(L("serrStatusRequested", "Requested"))}</span>`;
      }
    });
    action.appendChild(btn);
  }

  return card;
}

export function ensureDiscoverStyles() {
  ensureSerrStyles();
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${MODAL_ID} {
      background: linear-gradient(180deg, rgba(8, 10, 16, 0.78), rgba(7, 9, 15, 0.94));
      backdrop-filter: blur(14px);
      display: none;
      inset: 0;
      padding: 18px;
      position: fixed;
      z-index: 999999;
    }
    #${MODAL_ID}.open { align-items: center; display: flex; justify-content: center; }
    #${MODAL_ID} .monwui-serr-card { max-width: 1280px; width: min(1280px, calc(100vw - 36px)); max-height: 94vh; }
    .${NAV_CLASS} {
      align-items: center; border: none; color: inherit; display: inline-flex !important;
      gap: 8px; position: relative; text-decoration: none;
    }
    .${NAV_CLASS}:hover { opacity: 1; text-decoration: none; }
    .${NAV_CLASS} .monwui-watchlist-nav-icon {
      align-items: center; display: inline-flex; flex-shrink: 0; justify-content: center;
      line-height: 1; min-width: 1em; pointer-events: none;
    }
    .${NAV_CLASS} .monwui-watchlist-nav-svg { display: block; fill: currentColor; height: 1em; min-height: 1em; min-width: 1em; width: 1em; }
    .${NAV_CLASS} .monwui-watchlist-nav-label { display: inline-block; pointer-events: none; }
    .monwui-serr-byw-row .monwui-discover-row { padding-inline: 3.3%; scroll-padding-inline: 3.3%; grid-auto-columns: 140px; }
    .monwui-discover-tabs { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 24px 14px; }
    .monwui-discover-tab {
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 999px;
      color: inherit; cursor: pointer; font: inherit; font-size: 14px; font-weight: 700; padding: 8px 16px;
    }
    .monwui-discover-tab.active { background: linear-gradient(135deg, #ffb703, #fb8500); border-color: transparent; color: #1b1f28; }
    .monwui-discover-body { overflow-y: auto; padding: 4px 24px 24px; }
    .monwui-discover-grid {
      display: grid; gap: 18px 14px;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    }
    .monwui-discover-row {
      display: grid; gap: 14px; grid-auto-columns: 160px; grid-auto-flow: column;
      overflow-x: auto; padding: 4px 0 12px; scroll-snap-type: x proximity;
    }
    .monwui-discover-row .monwui-discover-card { scroll-snap-align: start; }
    .monwui-discover-card { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .monwui-discover-poster {
      aspect-ratio: 2 / 3; background: rgba(255,255,255,0.05); border-radius: 12px; display: block;
      overflow: hidden; position: relative;
    }
    .monwui-discover-poster img { display: block; height: 100%; object-fit: cover; width: 100%; }
    .monwui-discover-poster-fallback { align-items: center; display: flex; height: 100%; justify-content: center; padding: 10px; text-align: center; }
    .monwui-discover-badge {
      border-radius: 999px; font-size: 11px; font-weight: 800; left: 8px; padding: 3px 9px; position: absolute; top: 8px;
    }
    .monwui-discover-badge.available { background: #2e7d32; color: #fff; }
    .monwui-discover-badge.requested { background: #6a1b9a; color: #fff; }
    .monwui-discover-name { font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .monwui-discover-meta { font-size: 12px; opacity: .7; }
    .monwui-discover-action .monwui-serr-btn { min-height: 34px; padding: 7px 10px; text-decoration: none; width: 100%; }
    .monwui-discover-done { background: rgba(255,255,255,0.12) !important; color: inherit !important; cursor: default !important; }
    .monwui-discover-more { display: flex; justify-content: center; padding-top: 18px; }
    .monwui-discover-status { opacity: .75; padding: 24px 0; text-align: center; }
    @media (max-width: 640px) {
      #${MODAL_ID} { padding: 0; }
      #${MODAL_ID} .monwui-serr-card { border-radius: 0; max-height: 100vh; height: 100vh; width: 100vw; }
      .monwui-discover-tabs, .monwui-discover-body { padding-inline: 12px; }
      .monwui-discover-grid { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 14px 10px; }
    }
  `;
  document.head.appendChild(style);
}

function ensureModal() {
  ensureDiscoverStyles();
  let modal = document.getElementById(MODAL_ID);
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = MODAL_ID;
  modal.setAttribute("hidden", "hidden");
  const title = L("serrDiscoverTitle", "Discover");
  modal.innerHTML = `
    <div class="monwui-serr-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="monwui-serr-head">
        <h2 class="monwui-serr-title">${escapeHtml(title)}</h2>
        <button type="button" class="monwui-serr-close" data-discover-close aria-label="${escapeHtml(L("close", "Close"))}">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      </div>
      <div class="monwui-discover-tabs" role="tablist">
        ${CATEGORIES.map((c) => `<button type="button" role="tab" class="monwui-discover-tab" data-discover-tab="${c.key}">${escapeHtml(L(c.label[0], c.label[1]))}</button>`).join("")}
      </div>
      <div class="monwui-discover-body">
        <div class="monwui-discover-grid"></div>
        <div class="monwui-discover-status"></div>
        <div class="monwui-discover-more" hidden>
          <button type="button" class="monwui-serr-btn" data-discover-more><span>${escapeHtml(L("serrDiscoverLoadMore", "Load more"))}</span></button>
        </div>
      </div>
    </div>
  `;

  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target?.closest?.("[data-discover-close]")) closeSerrDiscoverModal();
    const tab = event.target?.closest?.("[data-discover-tab]");
    if (tab) loadCategory(modal, tab.getAttribute("data-discover-tab"), 1).catch(() => {});
    if (event.target?.closest?.("[data-discover-more]")) {
      loadCategory(modal, modal.__category, (modal.__page || 1) + 1).catch(() => {});
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("open")) closeSerrDiscoverModal();
  });

  document.body.appendChild(modal);
  return modal;
}

async function loadCategory(modal, category, page) {
  const grid = modal.querySelector(".monwui-discover-grid");
  const status = modal.querySelector(".monwui-discover-status");
  const more = modal.querySelector(".monwui-discover-more");
  const token = Symbol("load");
  modal.__loadToken = token;

  modal.__category = category;
  modal.__page = page;
  modal.querySelectorAll("[data-discover-tab]").forEach((tab) => {
    const active = tab.getAttribute("data-discover-tab") === category;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (page === 1) {
    grid.innerHTML = "";
    modal.__seen = new Set();
  }
  more.hidden = true;
  status.textContent = L("loadingText", "Loading...");

  try {
    const access = await getSerrAccess();
    const language = access?.settings?.defaultLanguage || "";
    const data = await discoverSerr(category, { page, language });
    if (modal.__loadToken !== token) return;

    const frag = document.createDocumentFragment();
    for (const result of Array.isArray(data?.results) ? data.results : []) {
      const mediaType = serrResultMediaType(result);
      const key = `${mediaType}:${result?.id}`;
      if (!mediaType || modal.__seen.has(key)) continue;
      modal.__seen.add(key);
      frag.appendChild(createSerrPosterCard(result, { access, source: "discover", onNavigate: closeSerrDiscoverModal }));
    }
    grid.appendChild(frag);
    status.textContent = grid.children.length ? "" : L("serrNoResults", "No results found.");
    more.hidden = !(Number(data?.totalPages || 0) > page);
  } catch (error) {
    if (modal.__loadToken !== token) return;
    status.textContent = error?.message || L("serrSearchFailed", "Could not load from Seerr.");
  }
}

export function openSerrDiscoverModal(category = "trending") {
  const modal = ensureModal();
  modal.removeAttribute("hidden");
  modal.classList.add("open");
  if (modal.__category !== category || !modal.querySelector(".monwui-discover-card")) {
    loadCategory(modal, category, 1).catch(() => {});
  }
}

export function closeSerrDiscoverModal() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("hidden", "hidden");
}

function navMarkup(label, mui) {
  const iconClass = mui
    ? "MuiButton-icon MuiButton-startIcon MuiButton-iconSizeMedium monwui-watchlist-nav-icon"
    : "monwui-watchlist-nav-icon";
  const svgClass = mui ? "MuiSvgIcon-root MuiSvgIcon-fontSizeMedium monwui-watchlist-nav-svg" : "monwui-watchlist-nav-svg";
  return `
    <span class="${iconClass}" aria-hidden="true">
      <svg class="${svgClass}" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path fill="currentColor" d="${COMPASS_PATH}" />
      </svg>
    </span>
    <span class="monwui-watchlist-nav-label">${escapeHtml(label)}</span>
  `;
}

function removeNavButtons() {
  document.querySelectorAll(`.${NAV_CLASS}`).forEach((node) => node.remove());
}

function syncNavButtons() {
  if (accessAllowed !== true) {
    removeNavButtons();
    return;
  }
  ensureDiscoverStyles();
  const label = L("serrDiscoverTitle", "Discover");
  document.querySelectorAll(`.${WATCHLIST_NAV_CLASS}`).forEach((watchlistBtn) => {
    const next = watchlistBtn.nextElementSibling;
    if (next?.classList?.contains(NAV_CLASS)) return;
    const mui = watchlistBtn.tagName === "A";
    const btn = document.createElement(mui ? "a" : "button");
    btn.className = String(watchlistBtn.className)
      .split(/\s+/)
      .filter((c) => c && !c.startsWith("monwui-watchlist"))
      .concat(NAV_CLASS)
      .join(" ");
    if (mui) {
      btn.href = "#";
      btn.setAttribute("role", "button");
    } else {
      btn.type = "button";
    }
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("title", label);
    btn.setAttribute("aria-label", label);
    btn.innerHTML = navMarkup(label, mui);
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      try { btn.blur(); } catch {}
      openSerrDiscoverModal();
    });
    watchlistBtn.insertAdjacentElement("afterend", btn);
  });
}

let accessCheckedAt = 0;
const ACCESS_RECHECK_MS = 3_000;

function scheduleNavSync() {
  clearTimeout(navTimer);
  navTimer = setTimeout(() => {
    // Access can fail while Jellyfin Web is still signing in; check again later.
    if (accessAllowed !== true && Date.now() - accessCheckedAt > ACCESS_RECHECK_MS) {
      refreshAccess();
      return;
    }
    syncNavButtons();
  }, 150);
}

async function refreshAccess() {
  accessCheckedAt = Date.now();
  try {
    const access = await getSerrAccess({ force: true });
    accessAllowed = access?.serrEnabled === true;
  } catch {
    accessAllowed = false;
  }
  syncNavButtons();
}

export function initSerrDiscover() {
  if (booted) return null;
  if (getConfig()?.enableSerrDiscover === false) return null;
  booted = true;

  try { window.__monwuiOpenDiscoverModal = openSerrDiscoverModal; } catch {}
  refreshAccess();
  observer = new MutationObserver(() => {
    const missing = [...document.querySelectorAll(`.${WATCHLIST_NAV_CLASS}`)]
      .some((btn) => !btn.nextElementSibling?.classList?.contains(NAV_CLASS));
    if (missing) scheduleNavSync();
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  window.addEventListener("hashchange", scheduleNavSync);

  return () => {
    booted = false;
    observer?.disconnect?.();
    observer = null;
    clearTimeout(navTimer);
    window.removeEventListener("hashchange", scheduleNavSync);
    removeNavButtons();
    closeSerrDiscoverModal();
  };
}
