/**
 * The construction site on Home: a tower crane that carries each task, as a
 * crate, from one area of the site to the next as its status changes. These
 * modules are the pure part (layout, the crane's choreography, camera math), so
 * they run under node:test. components/site-view/ draws it on a canvas.
 *
 * The `.js` specifiers are for the tests' NodeNext typecheck, which follows
 * these imports; Vite and tsx resolve them to the `.ts` files.
 */
export * from "./site/vec.js";
export * from "./site/zones.js";
export * from "./site/model.js";
export * from "./site/camera.js";
