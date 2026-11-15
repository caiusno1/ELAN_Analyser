# The example corpus

ELAN Analyser opens with an example corpus, so that every view shows something to work with before you load your own files. The same recordings are in [`examples/demo-corpus`](../examples/demo-corpus) as ordinary `.eaf` files: open them in ELAN to see how the tiers are set up, or drop them on the program to try the import.

**All of it is invented.** The corpus is simulated by [`src/core/demo/demoCorpus.ts`](../src/core/demo/demoCorpus.ts); there are no real participants, and the "findings" below are properties that were built into the simulation on purpose. They are there so that each analysis has something to find and you can check that it finds it. Do not cite them.

## Design

A referential communication task of the tangram type: a director (participant A) describes abstract figures to a matcher (participant B), who has to find them. Each dyad goes through the same eight figures in four rounds.

| | |
|---|---|
| Recordings | 12 dyads, about 2½ to 3 minutes each (33 minutes, some 4,100 annotations in all) |
| Conditions | 6 dyads face to face (`f2f`), 6 separated by a screen (`screen`) |
| File variables | `dyad`, `condition` (also in `file_variables.csv`) |

## Tiers

| Tier | Content | Type |
|---|---|---|
| `A_speech`, `B_speech` | utterances, transcribed | free text |
| `A_gesture`, `B_gesture` | gesture units: `iconic`, `deictic`, `metaphoric`, `beat` | categories |
| `A_gesture_phase`, `B_gesture_phase` | `preparation`, `stroke`, `hold`, `retraction` inside each gesture | child tier (Included In), controlled vocabulary |
| `A_gaze`, `B_gaze` | `partner`, `task`, `away` — covers the whole recording | categories, controlled vocabulary |
| `A_head`, `B_head` | head movements: `nod`, `shake`, `tilt` | categories |
| `round` | the four rounds of the task | categories, no participant |
| `A_gesture_R2`, `B_gesture_R2` | a second annotator's gesture coding (dyads 1 and 2 only) | categories |

The program reads this as the layers `speech`, `gesture`, `gesture_phase`, `gaze`, `head`, `round` and `gesture_R2`, each with a tier per participant.

## What was built in

| Built-in property | Where to look |
|---|---|
| Speakers adopt the partner's name for a figure ("the rabbit" / "the bunny") more often face to face (probability 0.80) than behind the screen (0.55). | Lexical alignment › Speakers & files, then Statistics: compare `er` between conditions |
| Alignment is above the level of shuffled and fake-pair dialogues. | Lexical alignment › Chance level |
| Responses come faster face to face: floor transfer offsets average about 180 ms against 330 ms. | Turn-taking; Statistics › Multilevel model: `fto_ms ~ condition + (1 | file)` |
| After the matcher's acceptance the director needs longer to start the next figure, so offsets differ by direction (B→A longer than A→B). | Turn-taking › Changes of speaker |
| Gestures are more frequent face to face (first-round probability 0.75 against 0.40) and get rarer from round to round (×1, 0.6, 0.3, 0.15). | Descriptives; Temporal structure › rate over the recording; Derived tiers › Split recordings by `round` |
| A gesture stroke starts about 200 ms before the word it goes with. | Timing › Event lags, gesture phases relative to speech |
| Speakers look away at the start of a longer utterance and back at the partner shortly before its end. | Timing › State around events: gaze `partner` around the end of speech |
| Listeners nod at the end of the partner's utterance, more often face to face (0.50 against 0.18), and matchers more than directors. | Timing › Event lags: head relative to the end of the partner's speech; Co-occurrence |
| The second annotator misses some gestures, shifts boundaries and confuses some categories. | Agreement: `gesture` against `gesture_R2` |
| Dyads differ in how much they gesture. | Statistics › Multilevel model: the standard deviation between files |

The simulation is seeded, so the corpus is the same on every machine and in every session. A test compares the files in `examples/demo-corpus` with what the generator produces; after changing the generator, run

```bash
npm run demo:write
```
