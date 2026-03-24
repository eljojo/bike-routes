/**
 * Convert a string to a URL-safe slug.
 * Lowercases, strips accents, replaces non-alphanumeric runs with hyphens,
 * and trims leading/trailing hyphens.
 */
export function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
