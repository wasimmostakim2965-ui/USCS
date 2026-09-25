/**
 * Cloud Wai icon set.
 *
 * A small, owned set of stroke icons rather than a font or an icon package:
 * one visual language, one stroke weight, one corner style, so the sidebar and
 * the toolbars read as a single product. Glyphs are named by meaning
 * (`projects`, `deployments`) rather than by shape, so a design pass can swap a
 * path without touching a call site.
 *
 * Each entry is the inner geometry of a 24×24 viewBox drawn with
 * `stroke="currentColor"`. `Icon` below applies the shared frame, so no path
 * carries its own colour, size or stroke width.
 */

export interface IconGeometry {
  /** Path data drawn with the shared stroke frame. */
  readonly paths: readonly string[];
  /** Elements drawn filled rather than stroked (dots, small accents). */
  readonly dots?: readonly (readonly [cx: number, cy: number, r: number])[];
  /** Outer radius for a stroked circle, drawn as `<circle>`. */
  readonly circles?: readonly (readonly [cx: number, cy: number, r: number])[];
}

const ICON_SET = {
  /* workspace level */
  projects: {
    paths: [
      "M4 7.5A2.5 2.5 0 0 1 6.5 5h3l2 2.5h6A2.5 2.5 0 0 1 20 10v6.5A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z",
    ],
  },
  key: {
    paths: [
      "M14.5 4a5.5 5.5 0 1 0-4.9 8.07L8.5 13.2 7 14.7l-1.5-1.5L4 14.7 5.5 16.2 4 17.7 5.5 19.2 8.5 16.2l1-1 1.1 1.1A5.5 5.5 0 0 0 14.5 4z",
    ],
    dots: [[16.4, 7.6, 1]],
  },
  activity: {
    paths: ["M4 12h3.5l2.5-6 3.5 12 2.5-6H20"],
  },
  billing: {
    paths: [
      "M4 7.5A2 2 0 0 1 6 5.5h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z",
      "M4 10h16",
      "M8 14.5h3",
    ],
  },
  pulse: {
    paths: ["M4 13.5h3.2l1.6-5 2.4 8.5 2-6 1.4 2.5H20", "M20 6.5h-3.5"],
  },
  settings: {
    paths: [
      "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z",
      "M19.4 13a7.6 7.6 0 0 0 0-2l1.7-1.3-1.9-3.3-2 .8a7.6 7.6 0 0 0-1.7-1L15.2 4h-3.8l-.3 2.2a7.6 7.6 0 0 0-1.7 1l-2-.8-1.9 3.3L7.2 11a7.6 7.6 0 0 0 0 2l-1.7 1.3 1.9 3.3 2-.8a7.6 7.6 0 0 0 1.7 1l.3 2.2h3.8l.3-2.2a7.6 7.6 0 0 0 1.7-1l2 .8 1.9-3.3z",
    ],
  },

  /* project level */
  overview: {
    paths: [
      "M4.5 6.5A2 2 0 0 1 6.5 4.5h4v15h-4a2 2 0 0 1-2-2z",
      "M13.5 4.5h4a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4z",
    ],
  },
  deployments: {
    paths: ["M12 4v11", "M8 11l4 4 4-4", "M5 18.5h14"],
  },
  domains: {
    paths: [
      "M3.5 12h17",
      "M12 3.5c2.6 2.4 4 5.3 4 8.5s-1.4 6.1-4 8.5c-2.6-2.4-4-5.3-4-8.5s1.4-6.1 4-8.5z",
      "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z",
    ],
  },
  database: {
    paths: [
      "M4.5 6.5c0-1.4 3.4-2.5 7.5-2.5s7.5 1.1 7.5 2.5S16.1 9 12 9 4.5 7.9 4.5 6.5z",
      "M4.5 6.5v11c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-11",
      "M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5",
    ],
  },
  shield: {
    paths: ["M12 3.5 19 6v5.5c0 4.3-2.8 7.6-7 9-4.2-1.4-7-4.7-7-9V6z", "M9 12l2.2 2.2L15.5 10"],
  },
  git: {
    paths: [
      "M7 8.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
      "M7 19.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
      "M17 11.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
      "M7 8.5v7",
      "M17 11.5c0 2-1.5 3-3.5 3H7",
    ],
  },

  /* an environment variable: a terminal prompt over a value line */
  env: {
    paths: ["M5 8.5 9 12l-4 3.5", "M12 16h7", "M4.5 4.5h15v15h-15z"],
  },

  /* database sub-level */
  table: {
    paths: ["M4.5 5.5h15v13h-15z", "M4.5 10h15", "M10 5.5v13"],
  },
  sql: {
    paths: ["M9 7 4.5 12 9 17", "M15 7l4.5 5L15 17"],
  },
  storage: {
    paths: [
      "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z",
      "M8 4v16",
      "M8 9h12",
    ],
  },
  api: {
    paths: ["M8.5 8.5 5 12l3.5 3.5", "M15.5 8.5 19 12l-3.5 3.5", "M13.2 6 10.8 18"],
  },
  roles: {
    paths: ["M12 3.8 6 6.2v5c0 3.6 2.4 6.4 6 7.6 3.6-1.2 6-4 6-7.6v-5z", "M12 10.5v2.5"],
  },
  logs: {
    paths: ["M5.5 5.5h13v13h-13z", "M8.5 9h7", "M8.5 12h7", "M8.5 15h4"],
  },
  auth: {
    paths: [
      "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z",
      "M12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
      "M6.5 19a5.5 5.5 0 0 1 11 0",
    ],
  },

  /* utilities */
  back: { paths: ["M14.5 6.5 9 12l5.5 5.5"] },
  chevronRight: { paths: ["M9.5 6.5 15 12l-5.5 5.5"] },
  chevronDown: { paths: ["M6.5 9.5 12 15l5.5-5.5"] },
  search: {
    paths: ["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M20 20l-4.2-4.2"],
  },
  menu: { paths: ["M4 7h16", "M4 12h16", "M4 17h16"] },
  plus: { paths: ["M12 5v14", "M5 12h14"] },
  check: { paths: ["M5 12.5 9.5 17 19 7"] },
  close: { paths: ["M6 6l12 12", "M18 6 6 18"] },
  copy: {
    paths: [
      "M9 9.5A1.5 1.5 0 0 1 10.5 8h7A1.5 1.5 0 0 1 19 9.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 9 16.5z",
      "M15 8V6.5A1.5 1.5 0 0 0 13.5 5h-7A1.5 1.5 0 0 0 5 6.5v7A1.5 1.5 0 0 0 6.5 15H8",
    ],
  },
  refresh: {
    paths: ["M19 12a7 7 0 1 1-2.1-5", "M19 4v4h-4"],
  },
  sun: {
    paths: ["M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"],
    circles: [[12, 12, 8.5]],
  },
  moon: {
    paths: ["M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"],
  },
  user: {
    paths: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M5 20a7 7 0 0 1 14 0"],
  },
} satisfies Record<string, IconGeometry>;

/**
 * The set, widened to `IconGeometry` per entry.
 *
 * `satisfies` above still checks every path against the shape; this mapping
 * keeps the member *names* literal (so `IconName` is a union of the real names)
 * while dropping the per-member literal path types, which is what lets `Icon`
 * read the optional `dots`/`circles` of any entry.
 */
export const ICONS: Readonly<Record<keyof typeof ICON_SET, IconGeometry>> = ICON_SET;

export type IconName = keyof typeof ICON_SET;
