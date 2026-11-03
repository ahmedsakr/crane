/**
 * Draws the construction site from lib/site.ts on a 2D canvas: flat-shaded
 * boxes and lattice lines in perspective, sorted back to front. No 3D library;
 * the scene is a few hundred polygons. Colours come from the CSS tokens, so it
 * follows light and dark mode, and the crane goes graphite when the factory is
 * off, like the slab.
 */
export { SiteView, type SiteViewEvents } from "./controller";
