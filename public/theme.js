// Chooses the look before the page draws, so there is no flash of the other theme.
// "dark" is the futuristic command-centre look (the default); "light" is the classic
// red and white. The choice is remembered on this browser only.
(() => {
  let saved = null;
  try {
    saved = localStorage.getItem("hrms-theme");
  } catch {
    /* storage can be blocked; fall back to the default */
  }
  document.documentElement.dataset.theme = saved === "light" ? "light" : "dark";
})();
