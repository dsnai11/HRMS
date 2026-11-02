// Chooses the look before the page draws, so there is no flash of the other one.
// "light" is Day (red and white), "dark" is Night (the dark command centre). A choice
// made with the Day | Night switch is remembered on this browser; until then the page
// follows the computer's or phone's own light/dark setting.
(() => {
  let saved = null;
  try {
    saved = localStorage.getItem("hrms-theme");
  } catch {
    /* storage can be blocked; fall back to the system setting */
  }
  const day = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  document.documentElement.dataset.theme =
    saved === "light" || saved === "dark" ? saved : day ? "light" : "dark";
})();
