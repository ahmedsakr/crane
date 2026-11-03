/** Connected repositories and their operator-owned tool rules. */

export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  /** True for the repo Crane itself lives in, used for factory_feature tasks. */
  isFactory: boolean;
  addedAt: string;
}

/** Tool rules the operator has decided on for one repo. */
export interface RepoTools {
  /** Allowed for every agent working in this repo, on top of Crane's defaults. */
  allowed: string[];
  /** Blocked rules the operator chose to keep blocked, so Crane stops asking. */
  keptBlocked: string[];
}
