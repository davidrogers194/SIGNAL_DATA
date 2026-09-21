# SIGNAL GitHub research handoff

Production importer: https://signal-research-importer.davidrogers194.workers.dev
Status: GET /api/import/status
Exact schemas: GET /api/import/schema (also schemas/*.schema.json)
Manual run: POST /api/import/run with Authorization: Bearer SIGNAL_AUTOMATION_TOKEN.
The token is a Cloudflare secret; never commit it. A public repository needs no GitHub token. Private repositories require a read-only GITHUB_TOKEN Worker secret.

## Publish

1. Generate a complete document matching schemas/research.schema.json or schemas/results.schema.json. Unknown fields are rejected.
2. Set generated_at to the real UTC generation time, model_version to the actual research methodology version, season and week to the NFL season/week (week 1–22, postseason included).
3. Run `node scripts/hash.mjs path/to/file.json` to set content_hash. Hash is lowercase SHA-256 over UTF-8 canonical JSON of the entire document excluding content_hash: recursively sort object keys, preserve array order, no whitespace, JavaScript JSON.stringify scalar encoding. Do not invent a hash.
4. Commit identical copies to latest/{kind}.json and week/2026-W02/{kind}.json. Prefer one commit for related updates. The importer reads both latest files from one resolved branch commit.
5. Check /api/import/status after the hourly scan or an authorized manual run.

Current latest files are empty connection tests, not research, forecasts, picks, or results. They do not publish a weekly brief. Replace them with real verified research; leave the empty results file until actual outcomes are available.

## Research

Required envelope: schema_version='1.0', kind='research', season, week, model_version, generated_at (UTC ISO-8601), content_hash (64 lowercase hex), frozen (boolean), payload.
Payload: title, dek, games, qualifiedProps.
Each game: eventId, matchup, headline, thesis, defensiveWeakness, offensiveResponse, personnelContext, gameflow, breaker, sources.
Each qualified prop: eventId, player, marketKey (player_*), side (OVER/UNDER), line, score (0–100), grade (A/A-/B+/B/Pass), reason, tags, sources.
Each source: title, url (HTTPS), published_at (UTC ISO-8601).
Use exact event IDs and market keys from SIGNAL. Qualified props must link to a game in the same document. Maximum 16 games and 50 picks. No market odds, payouts, or prices are accepted in research. Thresholds identify the reviewed prop, not a market feed.
Set frozen=true only when final: later changes to that week's research are rejected, including attempts through the existing weekly research writer. Market and result imports never modify frozen research. GitHub and raw_snapshots retain original versions.

## Results

Required envelope: schema_version='1.0', kind='results', season, week, model_version, generated_at, content_hash, research_content_hash (the matching imported research hash; null only for empty bootstrap), payload.
Payload: results (maximum 300), learning_notes (maximum 50).
Each result: id, event_id, player_id, player, market_key, side, line, actual (number/null), outcome (win/loss/push/void/pending), settled_at (UTC ISO-8601/null), sources.
Each learning note: id, finding, evidence_result_ids, methodology.
Win/loss/push require actual + settled_at and are checked mathematically against side/line. Learning notes must cite result IDs in this payload. Results are a complete replacement snapshot for that week, not an incremental patch; preserve earlier rows when adding new ones. Prior versions remain in raw_snapshots. Corrections need a later generated_at. They never rewrite research.

## Storage and scope

One metadata table: signal_github_handoff. Existing weekly_research receives the research projection; raw_snapshots stores immutable github_research/github_results versions; stat_snapshots with entity_type=github_result stores the current weekly result rows. sync_state records status and a short import lease. Market tables are untouched. All changed documents commit in one D1 batch transaction; invalid or frozen documents leave prior data intact. rows_written counts document archive rows plus research/result content rows, excluding bookkeeping. The original SIGNAL learning UI does not yet read github_result rows; this integration persists the handoff without redesigning that UI.

Worker configuration: GITHUB_REPOSITORY_URL and GITHUB_BRANCH. Cron: hourly at minute 0, UTC. No OpenAI API calls.
