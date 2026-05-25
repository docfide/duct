# Contributing

## Prerequisites

- Node.js 18+
- npm

## Setup

```bash
git clone <repo>
cd duct
npm install
```

## Development

```bash
npm run dev -- index ./docs
npm run dev -- search "query"
npm run dev -- serve
```

## Build

```bash
npm run build
```

## Pull Request

1. Fork the repo
2. Create a branch (`git checkout -b my-change`)
3. Commit your changes
4. Push and open a PR

Keep changes focused. Run `npm run typecheck` before submitting.
