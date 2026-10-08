import { createRequire } from 'node:module'

// package.json sits one level above both src/ and dist/.
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version
