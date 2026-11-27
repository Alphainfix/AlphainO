# Search benchmark

A small, reproducible check of how AlphainO finds things, used for the table in the main README.

## The vault

[`vault/`](vault) is a demonstration vault written for this benchmark. Its notes are about
[AlphainZ's six demonstration papers](https://github.com/Alphainfix/AlphainZ/tree/main/docs/benchmark):
honeybee navigation, sleep and memory, sourdough fermentation, news recommenders, urban heat, and a river
delta. The studies and their data are invented, and the people in the notes are made up.

- A reading note and an idea note for each paper, and three journal-club notes that each discuss two papers.
- Three unrelated personal notes (a focaccia recipe, a garden log, commute notes) that share some of the
  vocabulary.
- The papers' twelve figures, pasted in as pictures under Obsidian's default names
  (`Pasted image <date>.png`), so a file name says nothing about what a picture shows.

[`queries.json`](queries.json) holds 36 questions with their answer:

| kind | count | what it asks | answer |
|---|---|---|---|
| `text` | 12 English, 6 Chinese | the content of one sentence, without reusing its words | the note holding it (`target`, `target_quote`) |
| `keyword` | 6 | two to four exact terms from one sentence | the note holding it |
| `picture` | 6 English, 6 Chinese | what a picture looks like: AlphainZ's figure questions, unchanged (`from_alphainz`) | the picture |

Where a question comes from AlphainZ's set, `from_alphainz` names it.

## How it was run

`npm run benchmark` in `plugin/` ([`tests/benchmark/search.bench.ts`](../../plugin/tests/benchmark/search.bench.ts))
reads the vault into AlphainO's own note index and picture index with a real embedding model, and asks every
question. No language model is involved.

- **Text and keyword questions:** the note search in its semantic mode, which `note_search_by_topic` uses and
  which returns at most two passages per note. The score is the rank of the note holding the answer among the
  18 notes. The ranks in keyword mode and in hybrid mode are recorded too.
- **Picture questions:** the picture search (`search_vault_images`). The score is the rank of the picture
  among the twelve.
- **Obsidian's built-in search:** played by its rule, that every word of the query must occur in the note,
  in its text or its file name, ignoring case. A question counts as found when the note is among the results.

EmbeddingGemma 2 ran in Ollama on a MacBook Air (`npm run benchmark`); Gemini Embedding 2 with a paid API key
(`GEMINI_API_KEY=… BENCH_MODELS=gemini npm run benchmark`; a whole run costs well under a cent). Pictures
are sent as stored, PNG; in Obsidian the plugin first re-encodes a picture to JPEG of at most 1024 pixels,
which these already fit.

## Results

[`results/`](results) has every rank. Summary:

| Question | EmbeddingGemma 2 (Ollama) | Gemini Embedding 2 | Obsidian's built-in search |
|---|:-:|:-:|:-:|
| Semantic search, English questions (12) | 10 best, all 12 in the top 3 (MRR 0.90) | 11 best, all 12 in the top 3 (MRR 0.96) | 0 of 12 |
| Semantic search, Chinese questions on English notes (6) | 5 best, 5 in the top 3 (MRR 0.87) | 4 best, all 6 in the top 3 (MRR 0.83) | 0 of 6 |
| Describing a picture (12) | 7 best, 11 in the top 3 (MRR 0.75) | 11 best, all 12 in the top 3 (MRR 0.96) | not possible |
| Exact keywords (6) | 5 of 6 best | 6 of 6 best | 6 of 6 |

MRR is the mean reciprocal rank: 1 when the answer always comes first. Keyword search alone ranks all six
keyword questions first.

Of the seven text questions that missed first place across both models, four found another note on the same
paper first, and one the garden log, which shares the word "ivy" with its target; the other two drifted to a
note on another subject. In four of the six picture misses, the street-heat map
came first: a grid of coloured squares that looks a lot like several other charts.

A picture is indexed on its own here, so describing it is easier than in AlphainZ's benchmark, where the same
twelve descriptions had to find the figure's page among whole PDF pages (6 best matches with Gemini Embedding 2,
5 with EmbeddingGemma 2).
