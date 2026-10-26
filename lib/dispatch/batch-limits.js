// Root ingress and status aggregation must agree on the bounded card plan.
// Keep legacy callback/assignment limits separate: each new card has at most 20.
export const MAX_ITEMS_PER_CARD = 20;
export const MAX_BATCH_CHUNKS = 2;
export const MAX_BATCH_ITEMS = MAX_ITEMS_PER_CARD * MAX_BATCH_CHUNKS;
