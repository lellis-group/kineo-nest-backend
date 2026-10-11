/**
 * The ceiling on how many places the browse map is drawn from.
 *
 * A guard on the payload, not a product quota, which is why it does not live in
 * `limits.*`: that block is documented as "undefined = unlimited", and an
 * unbounded map is the one outcome the endpoint exists to prevent. It is
 * tunable because the collection grows; `truncated` in the response is what
 * lets the client adapt to whatever it is set to.
 */
export const MAX_BROWSE_MAP_PLACES = 200;

/** How many postings a place's preview carries. */
export const PLACE_PREVIEW_LIMIT = 4;
