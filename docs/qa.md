# Q&A

Duct can answer questions about your documents using a configurable LLM provider. The process is: search for relevant context, send it to the LLM with your question, return the answer with source citations.

## Quick Start

```bash
# With Ollama (default — no API keys)
duct ask "What are the termination clauses?"

# With OpenAI
duct ask "Summarize the indemnification" --llm openai

# With Gemini
duct ask "List all parties" --llm gemini
```

## Providers

### Ollama (Default)

Runs locally — no API keys, no data leaving your machine.

```bash
duct ask "What is the governing law?" --llm ollama
duct ask "..." --llm ollama --model llama3.2 --base-url http://localhost:11434
```

| Option | Default |
|--------|---------|
| Model | `llama3.2` |
| Base URL | `http://localhost:11434` |

Requires Ollama to be running locally: `ollama serve`

### OpenAI

```bash
export OPENAI_API_KEY=sk-...
duct ask "Summarize the agreement" --llm openai
duct ask "..." --llm openai --model gpt-4o
```

| Option | Default |
|--------|---------|
| Model | `gpt-4o` |
| Base URL | `https://api.openai.com/v1` |

### Gemini

```bash
export GEMINI_API_KEY=...
duct ask "What are the obligations?" --llm gemini
duct ask "..." --llm gemini --model gemini-2.0-flash
```

| Option | Default |
|--------|---------|
| Model | `gemini-2.0-flash` |
| Base URL | `https://generativelanguage.googleapis.com/v1beta` |

## Configuration

Set the LLM provider in the web UI Settings panel, or via the CLI:

```bash
# Just ask once with a specific provider
duct ask "Question" --llm openai

# Start the server with a default LLM
duct serve --llm ollama
```

## Agentic Retrieval

For complex questions that span multiple documents or topics, agentic retrieval decomposes your question into sub-queries, searches each independently, and synthesizes the final answer.

```bash
duct ask "Compare the indemnification clauses in all contracts" --multi
```

This is useful for:
- "What are the differences between the two NDAs?"
- "Which contracts have a termination for convenience clause?"
- "Summarize all payment terms across vendors"

## Context-Only Mode

Skip the LLM call and see what context would be retrieved:

```bash
duct ask "What are the termination clauses?" --no-answer
duct ask "Question" --no-answer --json    # JSON output
```

## Output

By default, the answer is printed with source citations:

```
  Searching for: "What are the termination clauses?"

  Answer (1523ms):

  The contract includes a 30-day notice period for termination without cause...

  Sources:
    [9.2] contract.pdf > Termination
    [7.8] appendix.pdf > Term
```

Use `--json` for machine-readable output:

```bash
duct ask "Question" --json
```

```json
{
  "answer": "The contract includes a 30-day notice period...",
  "sources": [
    {
      "documentPath": "contract.pdf",
      "score": 9.2,
      "content": "Either party may terminate...",
      "heading": "Termination"
    }
  ],
  "time": 1523
}
```
