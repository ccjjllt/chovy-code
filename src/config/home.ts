/**
 * Back-compat shim. The canonical implementation moved to `src/fs/home.ts`
 * during step-04. We keep the old import path live so config/secrets/
 * features (which were written against this module before the FS module
 * landed) don't have to change in step-04.
 *
 * NOTE: do *not* add new helpers here — extend `src/fs/home.ts` instead.
 */

export {
  chovyHome,
  chovyConfigPath,
  chovyFeaturesPath,
  chovySecretsDir,
} from "../fs/home.js";
