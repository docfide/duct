import { FORMATS } from '../formats.js'
import { VERSION } from '../version.js'

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: object, description = 'OK') => ({ description, content: { 'application/json': { schema } } })
const error = (description: string) => json(ref('Error'), description)
const collectionParam = { name: 'collection', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,62}$' } }
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$' } }
const commonErrors = { 401: error('Missing or invalid API key'), 403: error('The key lacks the scope, or the Developer API is switched off'), 404: error('Not found') }

/** OpenAPI 3.1 description of /v1, served at /v1/openapi.json. */
export function openApiSpec() {
  const formats = [...FORMATS.map(f => f.format), 'url']
  const searchParams = {
    q: { type: 'string', description: 'Words to find. Matches word forms ("terminate" finds "termination"), phrases in quotes, and file names.' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    offset: { type: 'integer', minimum: 0, maximum: 999, default: 0 },
    filter: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] }, description: 'Exact matches on metadata fields, all of which must match.' },
    facets: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Metadata fields to count values of among matching documents.' },
    formats: { type: 'array', items: { type: 'string', enum: formats } },
    group: { type: 'string', enum: ['document', 'passage'], default: 'document', description: 'One hit per document (its best passage), or every matching passage.' },
    sort: { type: 'string', pattern: '^[^:]+:(asc|desc)$', examples: ['year:desc'], description: 'Order matches by a metadata field instead of relevance; documents without it come last.' },
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Duct Developer API',
      version: VERSION,
      description: 'Index PDFs, Office files, scans and your own text, and search them by keyword or meaning. Each collection is a separate index.',
      license: { name: 'Apache-2.0' },
    },
    servers: [{ url: '/v1' }],
    security: [{ apiKey: [] }],
    paths: {
      '/': { get: { summary: 'Service info and the collections this key can use', responses: { 200: json({ type: 'object' }), 401: commonErrors[401] } } },
      '/collections': {
        get: { summary: 'List collections', description: 'Scope: search', responses: { 200: json({ type: 'object', properties: { collections: { type: 'array', items: ref('CollectionStats') } } }), ...commonErrors } },
        post: {
          summary: 'Create a collection', description: 'Scope: admin',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, settings: { type: 'object', properties: { search_mode: { type: 'string', enum: ['bm25', 'vector', 'hybrid'] }, ocr: { type: 'boolean' } } } } } } } },
          responses: { 201: json(ref('CollectionStats'), 'Created'), 400: error('Invalid name or settings'), 409: error('Already exists'), ...commonErrors },
        },
      },
      '/collections/{collection}': {
        parameters: [collectionParam],
        get: { summary: 'Collection details', description: 'Scope: search', responses: { 200: json(ref('CollectionStats')), ...commonErrors } },
        delete: { summary: 'Delete a collection and everything in it', description: 'Scope: admin', responses: { 204: { description: 'Deleted' }, ...commonErrors } },
      },
      '/collections/{collection}/documents': {
        parameters: [collectionParam],
        get: {
          summary: 'List documents, newest first', description: 'Scope: search',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } }],
          responses: { 200: json({ type: 'object', properties: { documents: { type: 'array', items: ref('Document') }, total: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' } } }), ...commonErrors },
        },
        post: {
          summary: 'Add or replace up to 1000 text documents', description: 'Scope: write. Unchanged documents are skipped. All documents are validated before any is indexed.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['documents'], properties: { documents: { type: 'array', maxItems: 1000, items: { allOf: [ref('TextDocument'), { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }] } } } } } } },
          responses: { 200: json({ type: 'object', properties: { results: { type: 'array', items: ref('IndexResult') } } }), 400: error('Invalid document'), 413: error('Too many documents or too much text'), ...commonErrors },
        },
      },
      '/collections/{collection}/documents/{id}': {
        parameters: [collectionParam, idParam],
        put: { summary: 'Add or replace one text document', description: 'Scope: write', requestBody: { required: true, content: { 'application/json': { schema: ref('TextDocument') } } }, responses: { 200: json(ref('IndexResult')), 400: error('Invalid document'), ...commonErrors } },
        get: { summary: 'Get a document', description: 'Scope: search. Add ?include=text for its stored text.', parameters: [{ name: 'include', in: 'query', schema: { type: 'string', enum: ['text'] } }], responses: { 200: json(ref('Document')), ...commonErrors } },
        delete: { summary: 'Delete a document', description: 'Scope: write', responses: { 204: { description: 'Deleted' }, ...commonErrors } },
      },
      '/collections/{collection}/files': {
        parameters: [collectionParam],
        post: {
          summary: 'Upload a file (PDF, Word, Excel, PowerPoint, email, image…)', description: 'Scope: write. Duct extracts the text, with page numbers where the format has them. Scanned pages are read with OCR when the collection has OCR on.',
          requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, id: { type: 'string' }, title: { type: 'string' }, metadata: { type: 'string', description: 'JSON object' } } } } } },
          responses: { 200: json(ref('Document')), 413: error('File too large'), 415: error('Unsupported file type'), 422: json(ref('Document'), 'The file could not be read'), ...commonErrors },
        },
      },
      '/collections/{collection}/search': {
        parameters: [collectionParam],
        get: {
          summary: 'Search', description: 'Scope: search. `filter` is a JSON object; `facets` and `formats` are comma-separated.',
          parameters: Object.entries(searchParams).map(([name, schema]) => ({ name, in: 'query', schema: name === 'filter' ? { type: 'string' } : name === 'facets' || name === 'formats' ? { type: 'string' } : schema })),
          responses: { 200: json(ref('SearchResponse')), 400: error('Invalid parameters'), ...commonErrors },
        },
        post: { summary: 'Search (JSON body)', description: 'Scope: search', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: searchParams } } } }, responses: { 200: json(ref('SearchResponse')), 400: error('Invalid parameters'), ...commonErrors } },
      },
      '/keys': {
        get: { summary: 'List API keys', description: 'Scope: admin', responses: { 200: json({ type: 'object', properties: { keys: { type: 'array', items: ref('ApiKey') } } }), ...commonErrors } },
        post: {
          summary: 'Create an API key', description: 'Scope: admin. The key is returned once.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string', enum: ['search', 'write', 'admin'] }, default: ['search'] }, collections: { type: ['array', 'null'], items: { type: 'string' } } } } } } },
          responses: { 201: json({ allOf: [ref('ApiKey'), { type: 'object', properties: { key: { type: 'string' } } }] }, 'Created'), ...commonErrors },
        },
      },
      '/keys/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], delete: { summary: 'Revoke an API key', description: 'Scope: admin', responses: { 204: { description: 'Revoked' }, ...commonErrors } } },
    },
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'An API key (duct_…) from `duct keys create`, or the server admin token.' } },
      schemas: {
        Error: { type: 'object', required: ['error', 'code'], properties: { error: { type: 'string' }, code: { type: 'string' } } },
        Metadata: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
        TextDocument: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Required unless pages is given' },
            pages: { type: 'array', items: { type: 'string' }, description: 'Text per page; hits then carry page numbers' },
            title: { type: 'string', maxLength: 500 },
            metadata: ref('Metadata'),
            format: { type: 'string', enum: ['txt', 'md'], default: 'txt' },
          },
        },
        IndexResult: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['indexed', 'no-text', 'unchanged'] }, chunks: { type: 'integer' } } },
        Document: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: ['string', 'null'] }, format: { type: 'string', enum: formats }, status: { type: 'string', enum: ['indexed', 'no-text', 'failed'] },
            error: { type: 'string' }, chunks: { type: 'integer' }, size: { type: 'integer' }, indexed_at: { type: 'string', format: 'date-time' }, metadata: ref('Metadata'), text: { type: 'string' },
          },
        },
        Hit: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: ['string', 'null'] }, score: { type: 'number' }, format: { type: 'string' },
            page: { type: 'integer' }, page_label: { type: 'string', examples: ['p. 4', 'slide 2', 'sheet 1'] }, heading: { type: 'string' },
            snippet: { type: 'string', description: 'Plain text around the match' },
            highlight: { type: 'string', description: 'The snippet, HTML-escaped, with matches in <mark>' },
            metadata: ref('Metadata'),
          },
        },
        SearchResponse: {
          type: 'object',
          properties: {
            hits: { type: 'array', items: ref('Hit') }, offset: { type: 'integer' }, limit: { type: 'integer' }, has_more: { type: 'boolean' },
            facets: { type: 'object', additionalProperties: { type: 'object', additionalProperties: { type: 'integer' } } }, took_ms: { type: 'integer' },
          },
        },
        CollectionStats: { type: 'object', properties: { name: { type: 'string' }, documents: { type: 'integer' }, chunks: { type: 'integer' }, search_mode: { type: 'string' }, semantic: { type: 'boolean' } } },
        ApiKey: {
          type: 'object',
          properties: { id: { type: 'string' }, name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } }, collections: { type: ['array', 'null'], items: { type: 'string' } }, created_at: { type: 'string' }, last_used_at: { type: ['string', 'null'] } },
        },
      },
    },
  }
}
