# Fastest Sandbox Worker

This Worker uses Cloudflare Sandboxes to run agent jobs in isolated containers.

## Prerequisites

1. **Docker** - Required for local development. The Cloudflare Sandbox SDK uses Docker to simulate the container environment locally.

   ```bash
   # Start Docker Desktop on macOS
   open -a Docker

   # Or using Colima
   colima start
   ```

2. **Wrangler CLI** - Included in devDependencies, but can also be installed globally:
   ```bash
   npm install -g wrangler
   ```

## Local Development

1. **Start Docker** - The sandbox SDK requires Docker to be running.

2. **Create secrets file** - Copy `.dev.vars.example` to `.dev.vars` and fill in your values:
   ```bash
   cp .dev.vars.example .dev.vars
   # Edit .dev.vars with your API tokens
   ```

3. **Start the API server** - In a separate terminal:
   ```bash
   cd ../api && bun run dev
   ```

4. **Start the sandbox worker**:
   ```bash
   bun run dev
   # or
   npx wrangler dev
   ```

   The first run will build the Docker container (2-3 minutes). Subsequent runs are much faster.

5. **Test endpoints**:
   ```bash
   # Health check
   curl http://localhost:8787/health

   # Run next pending job
   curl -X POST http://localhost:8787/run-next

   # Run specific job
   curl -X POST http://localhost:8787/run-job -H "Content-Type: application/json" -d '{"job_id": "your-job-id"}'
   ```

## How It Works

1. The Worker receives a job request
2. It spawns a Cloudflare Sandbox container
3. The container runs our `@fastest/sandbox` runner which:
   - Fetches the job details from the API
   - Restores the workspace from the snapshot
   - Runs OpenCode with the job prompt
   - Creates a new snapshot with the changes
   - Updates the job status

## Architecture

```
┌─────────────────────┐      ┌─────────────────────┐
│ Sandbox Worker      │      │ API Server          │
│ (Cloudflare Worker) │──────│ (Workers + D1 + R2) │
└────────┬────────────┘      └─────────────────────┘
         │
         │ spawns
         ▼
┌─────────────────────┐
│ Sandbox Container   │
│ ┌─────────────────┐ │
│ │ Sandbox Runner  │ │
│ │ (@fastest/      │ │
│ │  sandbox)       │ │
│ │                 │ │
│ │ - Fetch job     │ │
│ │ - Restore ws    │ │
│ │ - Run OpenCode  │ │
│ │ - Create snap   │ │
│ └─────────────────┘ │
└─────────────────────┘
```

## Deployment

```bash
npx wrangler deploy
```

## Configuration

The `wrangler.jsonc` file configures:
- Container image (built from Dockerfile)
- Instance type (`lite` for cost efficiency)
- Max instances (10 concurrent sandboxes)

Environment variables (set in dashboard or `.dev.vars`):
- `API_URL` - Fastest API URL
- `API_TOKEN` - API authentication token
- `ANTHROPIC_API_KEY` - For Claude models
- `OPENAI_API_KEY` - For OpenAI models (optional)
