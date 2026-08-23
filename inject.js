/*
 * Frame Loop — shadow DOM opener (MAIN world, document_start)
 *
 * Many sites mount their <video> elements
 * inside a CLOSED shadow root, which element.shadowRoot returns null for.
 * That makes the video invisible to any normal DOM traversal from an
 * extension. We patch Element.prototype.attachShadow here, before those
 * components hydrate, to force mode:"open". Open roots are reachable from
 * every world, so the isolated content script can then find the video.
 *
 * This only affects shadow roots created AFTER this script runs. It cannot
 * open roots that were already attached (e.g. server-rendered declarative
 * shadow DOM). Running at document_start in the MAIN world beats client-side
 * hydration in the large majority of cases.
 */
(() => {
  try {
    const proto = Element.prototype;
    const native = proto.attachShadow;
    const PATCHED = Symbol("frameLoopPatched");
    if (!native || native[PATCHED]) return;

    const patched = function attachShadow(init) {
      const opts = Object.assign({}, init, { mode: "open" });
      return native.call(this, opts);
    };
    patched[PATCHED] = true;

    Object.defineProperty(proto, "attachShadow", {
      value: patched,
      writable: true,
      configurable: true,
    });
  } catch (e) {
    /* if the page freezes the prototype, we silently fall back to
       light-DOM + open-root traversal only */
  }
})();
