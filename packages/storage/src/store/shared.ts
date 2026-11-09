export const now = () => new Date().toISOString();

/** A task whose start time has arrived. Binds the current time. */
export const TASK_DUE = "(scheduled_at IS NULL OR scheduled_at <= ?)";
