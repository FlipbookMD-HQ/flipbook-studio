/** Registers the installable window. The worker is a no-cache shell around the local server. */
export function registerStudioWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const register = () => void navigator.serviceWorker.register("/sw.js");
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register);
}
